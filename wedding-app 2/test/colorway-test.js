// Verifies the new colorway picker on the Profile tab: clicking an option
// applies it instantly (before the save round-trip even finishes), persists
// it to the server, and a reload/re-login shows the chosen colorway again
// (proving it's read back from saved state, not just a client-side toggle).
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
  // First-run setup wizard gate: finish it here (leaving the theme on its
  // default, Ivory & Plum) so it persists server-side and every later
  // reload in this test sees the dashboard, not the wizard again.
  await page.waitForSelector(".masthead-title, #wizard-finish-btn", { timeout: 5000 });
  if (await page.$("#wizard-finish-btn")) {
    await page.click("#wizard-finish-btn");
    await page.waitForSelector(".masthead-title", { timeout: 5000 });
  }

  const initialAttr = await page.evaluate(() => document.documentElement.getAttribute("data-colorway"));
  if (initialAttr !== null) throw new Error("expected no data-colorway attribute for the default Ivory & Plum colorway, got: " + initialAttr);
  console.log("PASS: defaults to Ivory & Plum (no data-colorway attribute) for a brand-new planner");

  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector('.tab-panel.active[data-panel="profile"]', { timeout: 5000 });
  await page.waitForSelector(".colorway-option", { timeout: 5000 });
  const optionCount = await page.locator(".colorway-option").count();
  if (optionCount !== 10) throw new Error("expected 10 colorway options, found " + optionCount);
  console.log("PASS: all 10 colorway options render (Ivory & Plum, Sage & Blush, Emerald & Mocha, Cocoa & Blush, Mocha & Sage, Dusty Blue & Rust, Plum & Gold, Charcoal & Ivory, Terracotta & Olive, Burgundy & Champagne)");

  const activeBefore = await page.locator(".colorway-option.active .colorway-label").textContent();
  if (!/Ivory & Plum/.test(activeBefore)) throw new Error("expected Ivory & Plum (the boutique default, formerly \"Classic\") to start active, got: " + activeBefore);

  // Click Emerald & Mocha and confirm the attribute + a real computed color
  // change instantly, before waiting for the save to round-trip
  await page.click('[data-colorway-pick="emerald"]');
  const attrRightAfterClick = await page.evaluate(() => document.documentElement.getAttribute("data-colorway"));
  if (attrRightAfterClick !== "emerald") throw new Error("expected instant data-colorway=emerald right after clicking, got: " + attrRightAfterClick);
  const accentColorRightAfterClick = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  if (accentColorRightAfterClick.toLowerCase() !== "#0f5c46") throw new Error("expected --accent to switch to emerald's #0f5c46 instantly, got: " + accentColorRightAfterClick);
  console.log("PASS: clicking a colorway applies it instantly (attribute + CSS variable), before the save finishes");

  await page.waitForFunction(() => /applied/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: colorway change round-trips through save and shows a confirmation");

  const activeAfter = await page.locator(".colorway-option.active .colorway-label").textContent();
  if (!/Emerald/.test(activeAfter)) throw new Error("expected Emerald & Mocha to show as active after picking it, got: " + activeAfter);
  console.log("PASS: the picker itself highlights the newly chosen colorway");

  // Reload the page (fresh boot, re-fetches /api/me + /api/state) and
  // confirm the colorway is restored from saved state, not just held in
  // memory client-side
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  const attrAfterReload = await page.evaluate(() => document.documentElement.getAttribute("data-colorway"));
  if (attrAfterReload !== "emerald") throw new Error("expected data-colorway=emerald to survive a reload, got: " + attrAfterReload);
  console.log("PASS: chosen colorway survives a full page reload (persisted in shared state, not just in memory)");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll colorway regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
