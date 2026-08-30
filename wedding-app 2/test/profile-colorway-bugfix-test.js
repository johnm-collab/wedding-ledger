// Regression test for a bug found this session: picking a colorway swatch
// on the Profile tab triggers its own save/re-render, which used to rebuild
// the profile form from stale state.profile and silently discard any
// profile fields the user had typed but not yet saved via "Save profile".
const assert = require("assert");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:4123";

async function run() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "correcthorse");
  await page.click("#login-form button[type=submit]");
  // First-run setup wizard gate: finish (not skip) it here so it persists
  // server-side and every later reload in this test sees the dashboard.
  await page.waitForSelector(".masthead-title, #wizard-finish-btn", { timeout: 5000 });
  if (await page.$("#wizard-finish-btn")) {
    await page.click("#wizard-finish-btn");
    await page.waitForSelector(".masthead-title", { timeout: 5000 });
  }

  await page.click('[data-tab="profile"]');
  await page.waitForSelector('.tab-panel.active[data-panel="profile"]', { timeout: 5000 });

  // Type into profile fields but do NOT click Save profile yet.
  await page.fill("#f-names", "Priya & Sam");
  await page.fill("#f-location", "Napa Valley");

  // Now pick a colorway swatch -- before the fix, this used to trigger a
  // save + re-render that wiped the untyped fields above.
  await page.click('[data-colorway-pick="emerald"]');
  await page.waitForFunction(() => /applied/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  const namesVal = await page.inputValue("#f-names");
  const locationVal = await page.inputValue("#f-location");
  assert.strictEqual(namesVal, "Priya & Sam", "expected typed couple names to survive a colorway pick, got: " + JSON.stringify(namesVal));
  assert.strictEqual(locationVal, "Napa Valley", "expected typed location to survive a colorway pick, got: " + JSON.stringify(locationVal));
  console.log("PASS: unsaved profile fields survive picking a colorway");

  // Now actually save the profile and confirm it persisted correctly.
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector('.tab-panel.active[data-panel="profile"]', { timeout: 5000 });
  const namesAfterReload = await page.inputValue("#f-names");
  assert.strictEqual(namesAfterReload, "Priya & Sam", "expected saved couple names to persist after reload, got: " + JSON.stringify(namesAfterReload));
  console.log("PASS: profile fields save correctly and persist after reload");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll profile/colorway bugfix regression tests passed.");
  await browser.close();
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
