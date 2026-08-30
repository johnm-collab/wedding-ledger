// Regression test for the self-service password management feature:
// change-password (happy path + wrong-current-password rejection),
// forgot-password (generic response for both real and unknown emails,
// anti-enumeration), and the full reset-token flow end to end — including
// an invalid/expired token being rejected. Runs its own server instance
// (like server-test.js) rather than assuming one is already up on 4123,
// since it needs direct access to db.pool to read back the reset token a
// real inbox would have received by email.
const assert = require("assert");
const path = require("path");
const { chromium } = require("playwright");

const PORT = 4124;
const BASE = "http://127.0.0.1:" + PORT;

process.env.PORT = String(PORT);
process.env.DATABASE_URL = "postgresql://fake";
process.env.SESSION_SECRET = "test-secret";
process.env.AUTH_USER_1_EMAIL = "you@example.com";
const auth = require(path.join(__dirname, "..", "auth.js"));
process.env.AUTH_USER_1_PASSWORD_HASH = auth.hashPassword("correcthorse");
process.env.NODE_ENV = "development";

async function getLatestResetToken(db, email) {
  const { rows } = await db.pool.query(
    "SELECT token, expires_at, used_at FROM password_resets WHERE email = $1",
    [email]
  );
  if (!rows.length) throw new Error("no password_resets row found for " + email);
  // Mock pg has no ORDER BY support — just take the last inserted row.
  return rows[rows.length - 1].token;
}

async function run() {
  require(path.join(__dirname, "..", "server.js"));
  const db = require(path.join(__dirname, "..", "db.js"));
  await new Promise((r) => setTimeout(r, 300)); // let db.init()+listen settle

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  // Status 400/401 shows up as a Chrome resource-load console.error for
  // every deliberately-rejected request in this test (wrong current
  // password, bad/used reset token) — expected, not a real bug. Matches
  // the same allowance the other browser tests make for 401.
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 40[01]/.test(text);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !isBenign(msg.text())) errors.push("console.error: " + msg.text()); });

  // ---- sign in, go to Profile, exercise change-password ----
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "correcthorse");
  await page.click("#login-form button[type=submit]");
  // First-run setup wizard gate: finish (not skip) it here so it persists
  // server-side and every later login/reload in this test sees the dashboard.
  await page.waitForSelector(".masthead-title, #wizard-finish-btn", { timeout: 5000 });
  if (await page.$("#wizard-finish-btn")) {
    await page.click("#wizard-finish-btn");
    await page.waitForSelector(".masthead-title", { timeout: 5000 });
  }

  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector("#change-password-btn", { timeout: 5000 });
  console.log("PASS: Account security card renders on the Profile tab");

  // Wrong current password
  await page.fill("#f-current-password", "wrongpassword");
  await page.fill("#f-new-password", "brandnewpass1");
  await page.click("#change-password-btn");
  await page.waitForFunction(() => /incorrect/i.test(document.querySelector(".login-error")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: change-password rejects the wrong current password");

  // Correct current password
  await page.fill("#f-current-password", "correcthorse");
  await page.fill("#f-new-password", "brandnewpass1");
  await page.click("#change-password-btn");
  await page.waitForFunction(() => /password changed/i.test(document.querySelector(".login-notice")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: change-password succeeds with the correct current password");

  // Log out, confirm old password no longer works and the new one does
  await page.click("#logout-btn");
  await page.waitForSelector("#login-form", { timeout: 5000 });
  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "correcthorse");
  await page.click("#login-form button[type=submit]");
  await page.waitForFunction(() => /incorrect/i.test(document.querySelector(".login-error")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: old password rejected after change-password");

  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "brandnewpass1");
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  console.log("PASS: new password works after change-password");

  await page.click("#logout-btn");
  await page.waitForSelector("#login-form", { timeout: 5000 });

  // ---- forgot-password: generic response, real vs unknown email ----
  await page.click("#show-forgot-btn");
  await page.waitForSelector("#forgot-form", { timeout: 5000 });

  await page.fill("#forgot-email", "nobody-here@example.com");
  await page.click('#forgot-form button[type=submit]');
  await page.waitForFunction(() => /reset link is on its way/i.test(document.querySelector(".login-notice")?.textContent || ""), { timeout: 5000 });
  const unknownMsg = await page.textContent(".login-notice");
  console.log("PASS: forgot-password gives a generic response for an unknown email");

  await page.fill("#forgot-email", "you@example.com");
  await page.click('#forgot-form button[type=submit]');
  await page.waitForFunction(() => /reset link is on its way/i.test(document.querySelector(".login-notice")?.textContent || ""), { timeout: 5000 });
  const knownMsg = await page.textContent(".login-notice");
  assert.strictEqual(knownMsg.trim(), unknownMsg.trim(), "the response text must be identical for a real and an unknown email (anti-enumeration)");
  console.log("PASS: forgot-password response is identical for a real account (anti-enumeration)");

  // ---- full reset-token flow ----
  const token = await getLatestResetToken(db, "you@example.com");
  await page.goto(BASE + "/?resetToken=" + token, { waitUntil: "networkidle" });
  const urlAfterLoad = await page.evaluate(() => window.location.search);
  if (urlAfterLoad) throw new Error("expected resetToken to be scrubbed from the URL, got query: " + urlAfterLoad);
  await page.waitForSelector("#reset-form", { timeout: 5000 });
  console.log("PASS: a ?resetToken= link renders the set-new-password screen and scrubs the token from the URL bar");

  await page.fill("#reset-password", "resetflowpass1");
  await page.fill("#reset-password-confirm", "resetflowpass1");
  await page.click('#reset-form button[type=submit]');
  await page.waitForFunction(() => /password updated/i.test(document.querySelector(".login-notice")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: submitting a valid reset token sets the new password and returns to sign-in");

  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "resetflowpass1");
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  console.log("PASS: the password set via the reset-token flow actually works for login");
  await page.click("#logout-btn");
  await page.waitForSelector("#login-form", { timeout: 5000 });

  // A used token must not be usable a second time
  await page.goto(BASE + "/?resetToken=" + token, { waitUntil: "networkidle" });
  await page.waitForSelector("#reset-form", { timeout: 5000 });
  await page.fill("#reset-password", "shouldnotwork1");
  await page.fill("#reset-password-confirm", "shouldnotwork1");
  await page.click('#reset-form button[type=submit]');
  await page.waitForFunction(() => /invalid or has expired/i.test(document.querySelector(".login-error")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: a used reset token is rejected on a second attempt");

  // An outright bogus token is rejected too
  await page.goto(BASE + "/?resetToken=not-a-real-token", { waitUntil: "networkidle" });
  await page.waitForSelector("#reset-form", { timeout: 5000 });
  await page.fill("#reset-password", "irrelevant123");
  await page.fill("#reset-password-confirm", "irrelevant123");
  await page.click('#reset-form button[type=submit]');
  await page.waitForFunction(() => /invalid or has expired/i.test(document.querySelector(".login-error")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: a bogus reset token is rejected");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll password-reset regression tests passed.");
  await browser.close();
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
