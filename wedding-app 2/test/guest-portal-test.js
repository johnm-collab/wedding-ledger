// Regression test for the new guest-facing RSVP portal (/rsvp/<token>):
// a household RSVP link that covers multiple guests at once, a personal
// link for a standalone guest, an invalid token being rejected, and that
// an RSVP submitted through the portal actually lands in the couple's
// shared state (and makes that guest seating-eligible), without touching
// login at all — this whole flow is unauthenticated by design.
const assert = require("assert");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:4123";

async function run() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const couplePage = await browser.newPage();
  const errors = [];
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 40[014]/.test(text);
  couplePage.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  couplePage.on("console", (msg) => { if (msg.type() === "error" && !isBenign(msg.text())) errors.push("console.error: " + msg.text()); });

  // ---- couple side: sign in, add two guests, group them into a household ----
  await couplePage.goto(BASE + "/", { waitUntil: "networkidle" });
  await couplePage.fill("#login-email", "you@example.com");
  await couplePage.fill("#login-password", "correcthorse");
  await couplePage.click("#login-form button[type=submit]");
  await couplePage.waitForSelector(".masthead-title", { timeout: 5000 });

  await couplePage.click('[data-tab="guests"]');
  await couplePage.waitForSelector('.tab-panel.active[data-panel="guests"]', { timeout: 5000 });

  await couplePage.fill("#f-guest-name", "Jordan Reyes");
  await couplePage.click("#add-guest-btn");
  await couplePage.waitForSelector("td.guest-row-name input", { timeout: 5000 });
  await couplePage.fill("#f-guest-name", "Casey Reyes");
  await couplePage.click("#add-guest-btn");
  await couplePage.waitForFunction(() => document.querySelectorAll("td.guest-row-name input").length === 2, { timeout: 5000 });
  console.log("PASS: two guests added");

  // Create a household and assign both guests to it via their detail panels
  await couplePage.fill("#f-household-name", "The Reyes Family");
  await couplePage.click("#add-household-btn");
  await couplePage.waitForFunction(() => document.querySelectorAll("[data-household-genlink]").length === 1, { timeout: 5000 });
  console.log("PASS: household created");

  const detailToggles = couplePage.locator("[data-guest-toggle]");
  const toggleCount = await detailToggles.count();
  for (let i = 0; i < toggleCount; i++) await detailToggles.nth(i).click();
  const householdSelects = couplePage.locator('select[data-guest-field^="householdId|"]');
  const hhCount = await householdSelects.count();
  for (let i = 0; i < hhCount; i++) await householdSelects.nth(i).selectOption({ label: "The Reyes Family" });
  console.log("PASS: both guests assigned to the household");

  // Generate the shared household RSVP link
  await couplePage.click("[data-household-genlink]");
  await couplePage.waitForFunction(() => {
    const row = document.querySelector('td input[readonly][value*="/rsvp/"]');
    return !!row;
  }, { timeout: 5000 });
  const householdLink = await couplePage.locator('td input[readonly][value*="/rsvp/"]').first().inputValue();
  assert.ok(/\/rsvp\/[0-9a-f]{64}$/.test(householdLink), "expected a 64-hex-char household RSVP link, got: " + householdLink);
  console.log("PASS: household RSVP link generated and persisted (" + householdLink + ")");

  // A raw, wrong token must be rejected with a generic message (anti-enumeration)
  const badPage = await browser.newContext().then((c) => c.newPage());
  await badPage.goto(BASE + "/rsvp/not-a-real-token-at-all", { waitUntil: "networkidle" });
  await badPage.waitForFunction(() => /isn.t valid/i.test(document.body.textContent || ""), { timeout: 5000 });
  console.log("PASS: an invalid RSVP token shows a generic 'not valid' message, not a stack trace or guest data");
  await badPage.close();

  // ---- guest side: open the household link in a fresh, unauthenticated context ----
  const guestPage = await browser.newContext().then((c) => c.newPage());
  await guestPage.goto(householdLink, { waitUntil: "networkidle" });
  await guestPage.waitForSelector(".portal-member", { timeout: 5000 });
  const memberCount = await guestPage.locator(".portal-member").count();
  assert.strictEqual(memberCount, 2, "expected both household members on the portal, found " + memberCount);
  const memberNames = await guestPage.locator(".portal-member h3").allTextContents();
  assert.ok(memberNames.includes("Jordan Reyes") && memberNames.includes("Casey Reyes"), "expected both guests by name: " + JSON.stringify(memberNames));
  console.log("PASS: the shared household link shows both household members, unauthenticated");

  // Mark both attending with a meal choice, then submit
  const attendingRadios = guestPage.locator('input[data-portal-rsvp][value="attending"]');
  const radioCount = await attendingRadios.count();
  for (let i = 0; i < radioCount; i++) await attendingRadios.nth(i).check();
  const mealInputs = guestPage.locator("[data-portal-meal]");
  const mealCount = await mealInputs.count();
  for (let i = 0; i < mealCount; i++) await mealInputs.nth(i).fill("Vegetarian");
  await guestPage.click("#portal-submit-btn");
  await guestPage.waitForFunction(() => /RSVP is saved/i.test(document.body.textContent || ""), { timeout: 5000 });
  console.log("PASS: submitting the portal RSVP shows a confirmation");
  await guestPage.close();

  // ---- back on the couple side: confirm the RSVP actually landed, and that
  // it made both guests seating-eligible without any manual step ----
  await couplePage.reload({ waitUntil: "networkidle" });
  await couplePage.waitForSelector(".masthead-title", { timeout: 5000 });
  await couplePage.click('[data-tab="seating"]');
  await couplePage.waitForSelector('[data-panel="seating"]', { timeout: 5000 });
  const unseatedNames = await couplePage.locator('.card:has(h3:text("Unseated")) td:first-child').allTextContents();
  assert.ok(unseatedNames.includes("Jordan Reyes") && unseatedNames.includes("Casey Reyes"),
    "expected both guests to show up as seating-eligible after RSVPing attending through the portal, got: " + JSON.stringify(unseatedNames));
  console.log("PASS: guest-portal RSVPs flow back into the couple's state and unlock seating eligibility");

  // ---- personal (non-household) link for a single guest ----
  await couplePage.click('[data-tab="guests"]');
  await couplePage.waitForSelector('.tab-panel.active[data-panel="guests"]', { timeout: 5000 });
  await couplePage.fill("#f-guest-name", "Sam Okafor");
  await couplePage.click("#add-guest-btn");
  await couplePage.waitForFunction(() => Array.from(document.querySelectorAll("td.guest-row-name input")).some((i) => i.value === "Sam Okafor"), { timeout: 5000 });
  const samToggle = couplePage.locator("tr:has(input[value='Sam Okafor']) [data-guest-toggle]");
  await samToggle.click();
  await couplePage.click("[data-guest-genlink]");
  await couplePage.waitForFunction(() => {
    const el = document.querySelector('[data-guest-genlink]');
    return el && /Regenerate/.test(el.textContent);
  }, { timeout: 5000 });
  const personalLink = await couplePage.locator('input[readonly][value*="/rsvp/"]').last().inputValue();
  assert.ok(/\/rsvp\/[0-9a-f]{64}$/.test(personalLink), "expected a personal RSVP link, got: " + personalLink);

  const samPage = await browser.newContext().then((c) => c.newPage());
  await samPage.goto(personalLink, { waitUntil: "networkidle" });
  await samPage.waitForSelector(".portal-member", { timeout: 5000 });
  const samMemberCount = await samPage.locator(".portal-member").count();
  assert.strictEqual(samMemberCount, 1, "personal link should show exactly one member, found " + samMemberCount);
  await samPage.locator('input[data-portal-rsvp][value="declined"]').check();
  await samPage.click("#portal-submit-btn");
  await samPage.waitForFunction(() => /RSVP is saved/i.test(document.body.textContent || ""), { timeout: 5000 });
  console.log("PASS: a standalone guest's personal RSVP link works independently of any household");
  await samPage.close();

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll guest-portal regression tests passed.");
  await browser.close();
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
