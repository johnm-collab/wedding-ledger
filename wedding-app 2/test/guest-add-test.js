// Regression test for the "added guest doesn't appear until you switch tabs"
// bug: saveState() updated `state` on a successful save but never called
// render(), so the DOM stayed stale. This drives the actual browser flow a
// user would follow and asserts the new row shows up immediately.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 401/.test(text);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !isBenign(msg.text())) errors.push("console.error: " + msg.text()); });

  await page.goto("http://127.0.0.1:4123/", { waitUntil: "networkidle" });
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

  await page.click('[data-tab="guests"]');
  await page.waitForSelector('.tab-panel.active[data-panel="guests"]', { timeout: 5000 });

  // No guests yet
  const emptyNote = await page.textContent(".tab-panel.active .empty-note");
  if (!/No guests yet/.test(emptyNote)) throw new Error("expected the empty-state note, got: " + emptyNote);
  console.log("PASS: empty guest list shows the empty-state note");

  // Add one guest via the manual-add form
  await page.fill("#f-guest-name", "Jamie Rivera");
  await page.fill("#f-guest-group", "College friends");
  await page.click("#add-guest-btn");

  // The bug: this used to require a tab switch or reload before the row
  // appeared. Assert it shows up right away, with no reload/tab-switch.
  await page.waitForSelector("td.guest-row-name input", { timeout: 5000 });
  const nameValue = await page.inputValue("td.guest-row-name input");
  if (nameValue !== "Jamie Rivera") throw new Error("expected the new guest row immediately, got: " + nameValue);
  console.log("PASS: newly added guest appears immediately without a tab switch or reload");

  // Stat tiles should reflect it too (still on the same render pass)
  const onTheList = await page.textContent(".guest-stats .stat-tile:first-child .stat-val");
  if (onTheList.trim() !== "1") throw new Error("expected guest-stats to show 1, got: " + onTheList);
  console.log("PASS: guest stat tiles update in the same render");

  // Add a second guest via the paste importer, confirm it also renders live
  await page.fill("#f-guest-paste", "Alex Chen, His side, Work friends");
  await page.click("#import-paste-btn");
  await page.waitForFunction(() => document.querySelectorAll("td.guest-row-name input").length === 2, { timeout: 5000 });
  console.log("PASS: pasted-import guest also appears immediately");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll guest-add regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
