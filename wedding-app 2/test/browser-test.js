const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  // Ignore two known-benign patterns: this sandbox can't reach Google Fonts
  // (unrelated to the app, doesn't happen in a real deployment), and
  // Chromium logs a "Failed to load resource: 401" devtools line for the
  // expected post-logout /api/state check even though the app handles it
  // correctly (asserted separately above).
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 401/.test(text);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !isBenign(msg.text())) errors.push("console.error: " + msg.text()); });

  await page.goto("http://127.0.0.1:4123/", { waitUntil: "networkidle" });
  await page.waitForSelector("#login-form", { timeout: 5000 });
  console.log("PASS: login form rendered on first load");

  // Wrong password
  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "wrongpass");
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector(".login-error", { timeout: 5000 });
  console.log("PASS: wrong password shows an inline error");

  // Correct login
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
  const title = await page.textContent(".masthead-title");
  if (title.trim() !== "Our Wedding") throw new Error("expected default masthead title, got: " + title);
  console.log("PASS: correct login loads the app shell");

  // Fill in profile and save
  await page.click('[data-tab="profile"]');
  await page.fill("#f-names", "Jordan & Casey");
  await page.fill("#f-date", "2027-06-12");
  await page.fill("#f-budget", "40000");
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => {
    const el = document.getElementById("save-status-badge");
    return el && el.textContent && /saved/i.test(el.textContent);
  }, { timeout: 5000 });
  console.log("PASS: profile save round-trips to the server");

  // Reload — session cookie + persisted state should survive
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  const titleAfterReload = await page.textContent(".masthead-title");
  if (titleAfterReload.trim() !== "Jordan & Casey") throw new Error("state did not persist across reload, got: " + titleAfterReload);
  console.log("PASS: session + saved state survive a page reload");

  // Budget tab renders recommendation engine output without errors
  await page.click('[data-tab="budget"]');
  await page.waitForSelector(".tab-panel.active .card h2", { timeout: 5000 });

  // Vendors, guests, checklist, seating, dayof tabs all render without throwing
  for (const tab of ["vendors", "guests", "checklist", "seating", "dayof", "overview"]) {
    await page.click('[data-tab="' + tab + '"]');
    await page.waitForSelector('.tab-panel.active[data-panel="' + tab + '"]', { timeout: 5000 });
  }
  console.log("PASS: all tabs render without console/page errors so far");

  // Logout returns to the login screen
  await page.click("#logout-btn");
  await page.waitForSelector("#login-form", { timeout: 5000 });
  console.log("PASS: logout returns to the login screen");

  await page.screenshot({ path: "/tmp/wedding-app/test/screenshot-login.png" });

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll browser tests passed with zero console/page errors.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
