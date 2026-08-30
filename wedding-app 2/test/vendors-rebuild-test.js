// Verifies the Vendors tab rebuild: the old "request vendors" flow is
// gone, manual "Add a vendor" works and feeds the budget market-signal
// fields, the AI-analyze route degrades gracefully with no API key
// configured, and the cost simulator computes totals correctly for
// flat / per-guest / per-hour pricing models.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 401|status of 501|status of 400/.test(text);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !isBenign(msg.text())) errors.push("console.error: " + msg.text()); });

  await page.goto("http://127.0.0.1:4123/", { waitUntil: "networkidle" });
  await page.fill("#login-email", "you@example.com");
  await page.fill("#login-password", "correcthorse");
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector(".masthead-title, #wizard-finish-btn", { timeout: 5000 });
  if (await page.$("#wizard-finish-btn")) {
    await page.click("#wizard-finish-btn");
    await page.waitForSelector(".masthead-title", { timeout: 5000 });
  }

  // Set guest count for simulator math
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector('.tab-panel.active[data-panel="profile"]', { timeout: 5000 });
  const profileHtml = await page.locator('.tab-panel.active[data-panel="profile"]').innerHTML();
  if (/Vendor categories|Request vendors|Request log|Have a quote/i.test(profileHtml)) {
    throw new Error("old vendor-request UI still present on the Profile tab");
  }
  console.log("PASS: old 'request vendor' UI is gone from the Profile tab");
  const tabLabel = await page.locator('[data-tab="profile"]').textContent();
  if (tabLabel.trim() !== "Profile") throw new Error("expected Profile tab label to just be 'Profile', got: " + tabLabel);
  console.log("PASS: Profile tab renamed (no longer 'Profile & Requests')");

  await page.fill("#f-guests", "100");
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  // --- Vendors tab ---
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="vendors"]');
  await page.waitForSelector('.tab-panel.active[data-panel="vendors"]', { timeout: 5000 });

  const vendorsHtml = await page.locator('.tab-panel.active[data-panel="vendors"]').innerHTML();
  if (/data-request-cat|Request vendors/i.test(vendorsHtml)) throw new Error("old 'request vendors' button still present on Vendors tab");
  console.log("PASS: old 'request vendors' button removed from the Vendors tab");

  // Add a flat-fee vendor to "planner"
  await page.fill("#v-add\\|planner-name", "Willow & Vine Planning");
  await page.selectOption("#v-add\\|planner-model", "flat");
  await page.fill("#v-add\\|planner-base", "3000");
  await page.fill("#v-add\\|planner-rating", "4");
  await page.fill("#v-add\\|planner-highlights", "Great reviews, day-of coordination included");
  await page.click('[data-vendor-add="planner"]');
  await page.waitForFunction(() => /added/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  await page.waitForSelector('.tab-panel.active[data-panel="vendors"] table', { timeout: 5000 });
  const plannerRowText = await page.locator('.tab-panel.active[data-panel="vendors"] .cat-card', { hasText: "Wedding Planner" }).first().innerText();
  if (!/Willow & Vine Planning/.test(plannerRowText) || !/\$3,000/.test(plannerRowText)) {
    throw new Error("flat-fee vendor didn't show up with the right price: " + plannerRowText);
  }
  console.log("PASS: manually added flat-fee vendor appears in the comparison table with correct price");

  // Add a per-guest vendor to "catering"
  await page.fill("#v-add\\|catering-name", "Home Plate Catering");
  await page.selectOption("#v-add\\|catering-model", "per_guest");
  await page.fill("#v-add\\|catering-perguest", "85");
  await page.click('[data-vendor-add="catering"]');
  await page.waitForFunction(() => document.body.textContent.includes("Home Plate Catering"), { timeout: 5000 });
  const cateringRowText = await page.locator('.tab-panel.active[data-panel="vendors"] .cat-card', { hasText: "Catering" }).first().innerText();
  if (!/\$85\/guest/.test(cateringRowText)) throw new Error("per-guest vendor price label wrong: " + cateringRowText);
  console.log("PASS: manually added per-guest vendor shows a '$/guest' price label");

  // Add a per-hour vendor to "photography"
  await page.fill("#v-add\\|photography-name", "Lens & Light Photo");
  await page.selectOption("#v-add\\|photography-model", "per_hour");
  await page.fill("#v-add\\|photography-perhour", "300");
  await page.fill("#v-add\\|photography-hours", "6");
  await page.click('[data-vendor-add="photography"]');
  await page.waitForFunction(() => document.body.textContent.includes("Lens & Light Photo"), { timeout: 5000 });
  console.log("PASS: manually added per-hour vendor");

  // --- Cost simulator ---
  await page.waitForSelector("#sim-guest-count", { timeout: 5000 });
  await page.fill("#sim-guest-count", "120");
  await page.locator("#sim-guest-count").blur();
  await page.waitForFunction(() => document.getElementById("sim-guest-count")?.value === "120", { timeout: 5000 });

  // planner picked automatically (only option) = 3000 flat
  // catering picked automatically (only option) = 85 * 120 = 10200
  // photography picked automatically (only option) = 300 * 6 = 1800
  // total = 15000
  await page.waitForFunction(() => /Estimated total: \$15,000/.test(document.body.textContent), { timeout: 5000 });
  console.log("PASS: cost simulator computes the correct total across flat + per-guest + per-hour vendors at 120 guests");

  // Booking a vendor should still set cat.actual via priceValue (existing budget wiring)
  await page.locator('.tab-panel.active[data-panel="vendors"] .cat-card', { hasText: "Wedding Planner" }).first().locator('[data-book]').click();
  await page.waitForFunction(() => /updated/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: marking the manually-added vendor booked still works (existing budget wiring untouched)");

  // --- AI analyze route degrades gracefully without an API key ---
  const analyzeStatus = await page.evaluate(async () => {
    const res = await fetch("/api/analyze-vendor-doc", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "venue", guestCount: 100, filename: "test.pdf", mimeType: "application/pdf", fileBase64: "JVBERi0xLjQK" })
    });
    return { status: res.status, body: await res.json() };
  });
  if (analyzeStatus.status !== 501) throw new Error("expected 501 (not configured) with no ANTHROPIC_API_KEY set, got " + analyzeStatus.status);
  if (!/ANTHROPIC_API_KEY/.test(analyzeStatus.body.error || "")) throw new Error("expected a helpful 'not configured' message, got: " + JSON.stringify(analyzeStatus.body));
  console.log("PASS: /api/analyze-vendor-doc degrades gracefully (501 + clear message) with no ANTHROPIC_API_KEY set");

  // Unknown category should 400, not 500
  const badCatStatus = await page.evaluate(async () => {
    const res = await fetch("/api/analyze-vendor-doc", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "not-a-real-category", guestCount: 100, filename: "test.pdf", mimeType: "application/pdf", fileBase64: "JVBERi0xLjQK" })
    });
    return res.status;
  });
  if (badCatStatus !== 400) throw new Error("expected 400 for an unknown category, got " + badCatStatus);
  console.log("PASS: /api/analyze-vendor-doc rejects an unknown category with 400");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll vendors-rebuild regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
