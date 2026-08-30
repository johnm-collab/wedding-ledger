// Batch 2 (guest-facing) features: the RSVP deadline countdown, the
// caterer/dietary report, and the travel & lodging summary — all on the
// Guest List tab.
//
// Note: this app inlines its whole JS source in a <script> tag inside
// <body>, so document.body.textContent also contains that source text —
// any check string that happens to also appear literally in the source (a
// comment, a placeholder, a UI label) can produce false positives. This
// test prefers structural DOM checks (element/attribute presence, scoped
// locators) over whole-body substring search, and only regex-matches
// dynamically-computed strings that can't coincidentally live in the
// source.
const { chromium } = require("playwright");

function fmtISO(d) { return d.toISOString().slice(0, 10); }

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

  await goTo("guests");

  // --- No guests yet: caterer/travel cards should show their empty states ---
  const catererEmpty = await page.locator('.card:has(h2:has-text("Caterer")) .empty-note').count();
  if (catererEmpty !== 1) throw new Error("expected the caterer report's empty state with no attending guests");
  const travelEmpty = await page.locator('.card:has(h2:has-text("Travel")) .empty-note').count();
  if (travelEmpty !== 1) throw new Error("expected the travel & lodging card's empty state with no travelers");
  console.log("PASS: caterer report and travel/lodging card show empty states with no data yet");

  // --- RSVP deadline: set 10 days out, expect a "days left" countdown ---
  const deadline = new Date(Date.now() + 10 * 86400000);
  await page.fill("#f-rsvp-deadline", fmtISO(deadline));
  await page.locator("#f-rsvp-deadline").blur();
  await page.waitForFunction(() => /saved|set/i.test(document.querySelector(".save-status")?.textContent || ""), { timeout: 5000 });
  await page.waitForSelector("[data-rsvp-deadline-status]", { timeout: 5000 });
  const statusText = await page.locator("[data-rsvp-deadline-status]").innerText();
  if (!/10 days left/.test(statusText)) throw new Error("expected a '10 days left' countdown, got: " + statusText);
  console.log("PASS: setting an RSVP deadline shows a live countdown");

  // Persists across reload.
  await page.reload({ waitUntil: "networkidle" });
  await goTo("guests");
  const persistedValue = await page.inputValue("#f-rsvp-deadline");
  if (persistedValue !== fmtISO(deadline)) throw new Error("expected the deadline to persist across reload, got: " + persistedValue);
  console.log("PASS: RSVP deadline persists across a reload");

  // --- Add two guests: one attending with a meal choice + hotel needs, one attending with no meal choice noted ---
  await page.fill("#f-guest-name", "Dana Wu");
  await page.click("#add-guest-btn");
  await page.waitForFunction(() => document.querySelectorAll("td.guest-row-name input").length === 1, { timeout: 5000 });

  await page.fill("#f-guest-name", "Priya Nair");
  await page.click("#add-guest-btn");
  await page.waitForFunction(() => document.querySelectorAll("td.guest-row-name input").length === 2, { timeout: 5000 });
  console.log("PASS: two guests added");

  // Mark both attending via their RSVP selects.
  const rsvpSelects = page.locator('select[data-guest-field^="rsvp|"]');
  await rsvpSelects.nth(0).selectOption("attending");
  await rsvpSelects.nth(1).selectOption("attending");

  // Open Dana's details, set a meal choice and hotel info; leave Priya's meal choice blank.
  await page.locator(".detail-toggle").first().click();
  await page.waitForSelector(".detail-row", { timeout: 5000 });
  const mealInput = page.locator(".detail-row input[data-guest-field^='mealChoice|']").first();
  await mealInput.fill("Vegan (tree nut allergy)");
  await mealInput.blur();
  const hotelCheck = page.locator(".detail-row input[data-guest-check^='needsHotel|']").first();
  await hotelCheck.check();
  const hotelBlockInput = page.locator(".detail-row input[data-guest-field^='hotelBlock|']").first();
  await hotelBlockInput.fill("Riverside Inn");
  await hotelBlockInput.blur();
  const arrivalInput = page.locator(".detail-row input[data-guest-field^='arrival|']").first();
  await arrivalInput.fill(fmtISO(new Date(Date.now() + 5 * 86400000)));
  await arrivalInput.blur();

  await page.click("#save-guests-btn");
  await page.waitForFunction(() => /saved/i.test(document.querySelector(".save-status")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: guest edits (RSVP, meal choice, hotel needs) saved");

  // --- Caterer report: one row per meal choice, correct counts, correct total ---
  const catererCard = page.locator('.card:has(h2:has-text("Caterer"))');
  await page.waitForSelector('.card:has(h2:has-text("Caterer")) table tbody tr', { timeout: 5000 });
  const catererRows = await catererCard.locator("table tbody tr").count();
  if (catererRows !== 2) throw new Error("expected 2 meal-choice rows (Vegan.../ No meal choice noted), got " + catererRows);
  const catererText = await catererCard.innerText();
  if (!/Vegan \(tree nut allergy\)/.test(catererText)) throw new Error("expected Dana's meal choice to appear: " + catererText);
  if (!/No meal choice noted/.test(catererText)) throw new Error("expected Priya's unset meal choice to fall into 'No meal choice noted': " + catererText);
  if (!/2 confirmed heads/.test(catererText)) throw new Error("expected the caterer summary line to count 2 confirmed heads: " + catererText);
  console.log("PASS: caterer report groups attending guests by meal choice with correct counts");

  // --- Travel & lodging: only Dana (needsHotel) should show up ---
  const travelCard = page.locator('.card:has(h2:has-text("Travel"))');
  await page.waitForSelector('.card:has(h2:has-text("Travel")) table tbody tr', { timeout: 5000 });
  const travelRows = await travelCard.locator("table tbody tr").count();
  if (travelRows !== 1) throw new Error("expected exactly 1 traveler row, got " + travelRows);
  const travelText = await travelCard.innerText();
  if (!/Dana Wu/.test(travelText)) throw new Error("expected Dana Wu in the travel/lodging table: " + travelText);
  if (/Priya Nair/.test(travelText)) throw new Error("Priya shouldn't appear in travel/lodging (didn't check needsHotel): " + travelText);
  if (!/Riverside Inn/.test(travelText)) throw new Error("expected the hotel block to show: " + travelText);
  console.log("PASS: travel & lodging card shows only guests marked as needing a hotel");

  // --- Export buttons present ---
  if (!(await page.locator("#export-caterer-btn").count())) throw new Error("expected a caterer CSV export button");
  if (!(await page.locator("#export-travel-btn").count())) throw new Error("expected a travel/lodging CSV export button");
  console.log("PASS: CSV export buttons present for both reports");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll RSVP deadline / caterer report / travel-lodging regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
