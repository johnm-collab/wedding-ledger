// Batch 1 features: the Simulations tab (named, saved, side-by-side vendor
// scenarios with charts + budget impact) and per-vendor CRM (notes log +
// one attached contract file).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

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

  async function goTo(tabKey) {
    await page.click("#nav-toggle-btn");
    await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
    await page.click('[data-tab="' + tabKey + '"]');
    await page.waitForSelector('.tab-panel.active[data-panel="' + tabKey + '"]', { timeout: 5000 });
  }

  // Set a guest count + budget so the simulator has something to compare against.
  await goTo("profile");
  await page.fill("#f-guests", "100");
  await page.fill("#f-budget", "20000");
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  // --- Vendors: add two options in "planner" so scenarios have something to pick between ---
  await goTo("vendors");
  await page.fill("#v-add\\|planner-name", "Willow & Vine Planning");
  await page.selectOption("#v-add\\|planner-model", "flat");
  await page.fill("#v-add\\|planner-base", "3000");
  await page.click('[data-vendor-add="planner"]');
  await page.waitForFunction(() => document.body.textContent.includes("Willow & Vine Planning"), { timeout: 5000 });

  await page.fill("#v-add\\|planner-name", "Bloom Events Co.");
  await page.selectOption("#v-add\\|planner-model", "flat");
  await page.fill("#v-add\\|planner-base", "4500");
  await page.click('[data-vendor-add="planner"]');
  await page.waitForFunction(() => document.body.textContent.includes("Bloom Events Co."), { timeout: 5000 });
  console.log("PASS: two planner vendors added for scenario comparison");

  // --- Vendor CRM: notes ---
  // Note: this app inlines its whole JS source in a <script> tag inside
  // <body>, so document.body.textContent also contains that source text —
  // any check string that happens to also appear literally in the source
  // (a comment, a placeholder example, a UI label) can produce false
  // positives/negatives. Structural DOM checks (element/attribute
  // presence, not substring search) sidestep that entirely, so this test
  // prefers those throughout.
  await page.click('.tab-panel.active[data-panel="vendors"] [data-vendor-score-toggle]');
  await page.waitForSelector(".detail-row", { timeout: 5000 });
  const noteInputId = await page.locator(".detail-row input[type=text][id^='v-note-']").first().getAttribute("id");
  const noteText = "Phoned to confirm the Saturday hold — no deposit taken yet.";
  await page.fill("#" + noteInputId, noteText);
  const notePrefix = noteInputId.replace("v-note-", "");
  await page.click('[data-vendor-note-add="' + notePrefix.replace("-", "|") + '"]');
  await page.waitForSelector(".import-item", { timeout: 5000 });
  const savedNoteText = await page.locator(".import-item").first().innerText();
  if (savedNoteText.indexOf(noteText) < 0) throw new Error("note text wasn't rendered as expected: " + savedNoteText);
  console.log("PASS: vendor note added and shown");

  const removeBtn = page.locator("[data-vendor-note-remove]").first();
  await removeBtn.click();
  await page.waitForFunction(() => document.querySelectorAll(".import-item").length === 0, { timeout: 5000 });
  console.log("PASS: vendor note removed");

  // --- Vendor CRM: contract attach/remove ---
  const tmpFile = path.join(require("os").tmpdir(), "test-contract.pdf");
  fs.writeFileSync(tmpFile, "%PDF-1.4\n%fake contract for testing\n");
  const fileInputId = await page.locator(".detail-row input[type=file][id^='v-contract-']").first().getAttribute("id");
  await page.setInputFiles("#" + fileInputId, tmpFile);
  const uploadPrefix = fileInputId.replace("v-contract-", "");
  await page.click('[data-vendor-contract-upload="' + uploadPrefix.replace("-", "|") + '"]');
  await page.waitForSelector("[data-vendor-contract-remove]", { timeout: 5000 });
  console.log("PASS: contract attached (shows Download + Remove)");

  await page.click("[data-vendor-contract-remove]");
  await page.waitForFunction(() => !document.querySelector("[data-vendor-contract-remove]"), { timeout: 5000 });
  await page.waitForSelector(".detail-row [data-vendor-contract-upload]", { timeout: 5000 });
  console.log("PASS: contract removed");

  // --- Simulations: empty state ---
  await goTo("simulations");
  await page.waitForSelector("[data-sim-seed]", { timeout: 5000 });
  console.log("PASS: Simulations tab shows the empty-state seed button when no scenarios exist");

  await page.click("[data-sim-seed]");
  await page.waitForFunction(() => {
    var names = Array.from(document.querySelectorAll("[data-sim-name]")).map(function (e) { return e.value; });
    return names.indexOf("Scenario A") >= 0 && names.indexOf("Scenario B") >= 0;
  }, { timeout: 5000 });
  console.log("PASS: seeding creates Scenario A and Scenario B");

  // Both scenarios default to the same (first) planner vendor at 100 guests — $3,000 flat.
  await page.waitForFunction(() => /\$3,000/.test(document.body.textContent), { timeout: 5000 });

  // Pick the pricier vendor in the first scenario column and confirm the
  // total updates and the budget row reacts.
  const picks = page.locator("[data-sim-vendorpick]");
  const pickCount = await picks.count();
  let firstPlannerPick = null;
  for (let i = 0; i < pickCount; i++) {
    const attr = await picks.nth(i).getAttribute("data-sim-vendorpick");
    if (attr && attr.indexOf("|planner") >= 0) { firstPlannerPick = picks.nth(i); break; }
  }
  if (!firstPlannerPick) throw new Error("could not find a planner picker in the simulations table");
  await firstPlannerPick.selectOption({ label: "Bloom Events Co." });
  await page.waitForFunction(() => /\$4,500/.test(document.body.textContent), { timeout: 5000 });
  console.log("PASS: changing a scenario's vendor pick updates its estimated total");

  // Budget is $20,000 and nothing else is priced, so both scenarios should
  // read some "$X under" figure — a dynamically-assembled string (not a
  // literal that could coincidentally live in the app's own source), so
  // matching it is a meaningful check, unlike a bare word like "under".
  await page.waitForFunction(() => /\$[\d,]+ under/.test(document.body.textContent), { timeout: 5000 });
  console.log("PASS: budget-impact row shows under/over against the profile's total budget");

  // Chart rows should be present once there are 2+ scenarios.
  await page.waitForSelector(".simchart-bar-row", { timeout: 5000 });
  console.log("PASS: comparison charts render once there are 2+ scenarios");

  // Rename Scenario A and confirm it persists after a reload.
  function hasScenarioNamed(name) {
    return page.waitForFunction((n) => Array.from(document.querySelectorAll("[data-sim-name]")).some(function (e) { return e.value === n; }), name, { timeout: 5000 });
  }

  const nameInputs = page.locator("[data-sim-name]");
  await nameInputs.first().fill("Budget-friendly");
  await nameInputs.first().blur();
  await hasScenarioNamed("Budget-friendly");
  await page.reload({ waitUntil: "networkidle" });
  await goTo("simulations");
  await hasScenarioNamed("Budget-friendly");
  console.log("PASS: renamed scenario persists across a reload");

  // Duplicate, then remove back down to 2.
  await page.click("[data-sim-duplicate]");
  await page.waitForFunction(() => document.querySelectorAll("[data-sim-remove]").length === 3, { timeout: 5000 });
  console.log("PASS: duplicating a scenario adds a third column");

  await page.click("[data-sim-remove]");
  await page.waitForFunction(() => document.querySelectorAll("[data-sim-remove]").length === 2, { timeout: 5000 });
  console.log("PASS: removing a scenario drops it from the comparison");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll simulations + vendor CRM regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
