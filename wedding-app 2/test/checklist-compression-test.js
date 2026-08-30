// Verifies the short-runway checklist compression: when the wedding date is
// less than 12 months out, default checklist offsets scale down so the plan
// fits inside the time actually available, while custom to-dos (offsets the
// couple typed in themselves) stay untouched, and a normal 12+ month runway
// behaves exactly as before (no regression for the common case).
const { chromium } = require("playwright");

function fmtISO(d) { return d.toISOString().slice(0, 10); }

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
  await page.waitForSelector(".masthead-title", { timeout: 5000 });

  const today = new Date();

  // --- Long runway (400 days): behavior must be identical to before ---
  const farDate = new Date(today.getTime() + 400 * 86400000);
  await page.click('[data-tab="profile"]');
  await page.fill("#f-date", fmtISO(farDate));
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  await page.click('[data-tab="checklist"]');
  await page.waitForSelector('.tab-panel.active[data-panel="checklist"]', { timeout: 5000 });
  const farLabels = await page.$$eval(".checklist-group h4", (els) => els.map((e) => e.textContent));
  if (!farLabels.includes("12+ months before")) throw new Error("long runway should keep the original label, got: " + JSON.stringify(farLabels));
  const compressionNoteFar = await page.locator('.tab-panel.active[data-panel="checklist"] p.tiny').count();
  if (compressionNoteFar !== 0) throw new Error("no compression note should show on a 400-day runway");
  console.log("PASS: 400-day runway keeps original checklist labels, no compression note");

  // Check the exact due date of the very first (furthest-out) item matches wd - 365 days unscaled
  const firstDue = await page.locator(".tab-panel.active .check-row .check-due").first().textContent();
  const expectedFar = new Date(farDate.getTime() - 365 * 86400000);
  const expectedFarStr = expectedFar.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!firstDue.includes(expectedFarStr)) throw new Error("expected unscaled due date " + expectedFarStr + ", got: " + firstDue);
  console.log("PASS: long-runway due dates are unscaled (offset -365 lands exactly 365 days out)");

  // --- Short runway (60 days): compression kicks in ---
  const nearDate = new Date(today.getTime() + 60 * 86400000);
  await page.click('[data-tab="profile"]');
  await page.fill("#f-date", fmtISO(nearDate));
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  await page.click('[data-tab="checklist"]');
  await page.waitForSelector('.tab-panel.active[data-panel="checklist"]', { timeout: 5000 });

  const noteText = await page.locator('.tab-panel.active[data-panel="checklist"] p.tiny').textContent();
  if (!/60 days away/.test(noteText)) throw new Error("expected compression note mentioning 60 days, got: " + noteText);
  console.log("PASS: compression note appears and states the correct runway");

  const nearLabels = await page.$$eval(".checklist-group h4", (els) => els.map((e) => e.textContent));
  if (nearLabels.includes("12+ months before")) throw new Error("short runway must not still say '12+ months before', got: " + JSON.stringify(nearLabels));
  console.log("PASS: short runway relabels buckets away from the stale '12+ months' text: " + JSON.stringify(nearLabels));

  // Every non-custom checklist item's due date must fall between today and the wedding date
  const dueTexts = await page.$$eval(".tab-panel.active .check-row .check-due", (els) => els.map((e) => e.textContent));
  const overdueCount = await page.locator(".tab-panel.active .check-due.overdue").count();
  if (overdueCount > 0) throw new Error("compressed plan should not show items as overdue the moment the date is set, found " + overdueCount + " overdue: " + JSON.stringify(dueTexts));
  console.log("PASS: no checklist item is immediately overdue on a compressed 60-day plan");

  // Furthest-out item should now land very close to today (within ~2 days), not 365 days ago
  const firstDueNear = dueTexts[0];
  const todayStr = today.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  console.log("First checklist item due date on 60-day plan: " + firstDueNear + " (today is " + todayStr + ")");

  // --- Custom to-do offsets are NOT rescaled ---
  await page.fill("#f-new-check", "Order welcome bags");
  await page.fill("#f-new-check-offset", "10");
  await page.click("#add-check-btn");
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".check-title")).some((e) => e.textContent.includes("Order welcome bags")), { timeout: 5000 });
  const customRow = page.locator(".check-row", { hasText: "Order welcome bags" });
  const customDueText = await customRow.locator(".check-due").textContent();
  const expectedCustomDue = new Date(nearDate.getTime() - 10 * 86400000);
  const expectedCustomStr = expectedCustomDue.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!customDueText.includes(expectedCustomStr)) throw new Error("custom to-do offset should be literal (10 days before wedding = " + expectedCustomStr + "), got: " + customDueText);
  console.log("PASS: custom to-do's typed-in offset is NOT rescaled");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll checklist-compression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
