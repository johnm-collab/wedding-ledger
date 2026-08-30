// Verifies the seating chart: it now lives on its own "Seating" tab (not
// nested under Day-of), guests' full names appear as labeled pills arranged
// around a table (not just two-letter initials with a hover tooltip),
// tables can be Round or Rectangular (different seat-placement math for
// each), tables can be dragged around a shared floor-plan canvas and that
// position persists after Save + reload, unfilled seats render as small
// placeholder dots, and clicking a filled pill unseats that guest.
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

  // Add a couple of guests and mark them invited so they're eligible to be seated
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="guests"]');
  await page.waitForSelector('.tab-panel.active[data-panel="guests"]', { timeout: 5000 });
  await page.fill("#f-guest-name", "Priyanka Subramaniam");
  await page.fill("#f-guest-group", "College friends");
  await page.click("#add-guest-btn");
  await page.waitForSelector("td.guest-row-name input", { timeout: 5000 });
  await page.fill("#f-guest-name", "Alex Chen");
  await page.click("#add-guest-btn");
  await page.waitForFunction(() => document.querySelectorAll("td.guest-row-name input").length === 2, { timeout: 5000 });

  const inviteButtons = page.locator('button[data-guest-status^="invite|"]');
  const inviteCount = await inviteButtons.count();
  for (let i = 0; i < inviteCount; i++) {
    await inviteButtons.nth(i).click();
  }

  // Seating eligibility is driven by RSVP, not just invite status — set
  // both guests to "Attending" so they show up on the Seating tab (this is
  // the "click Attending -> guest becomes seatable" behavior).
  const rsvpSelects = page.locator('select[data-guest-field^="rsvp|"]');
  const rsvpCount = await rsvpSelects.count();
  for (let i = 0; i < rsvpCount; i++) {
    await rsvpSelects.nth(i).selectOption("attending");
  }

  // Seating now has its own tab, separate from Day-of
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="seating"]');
  await page.waitForSelector('[data-panel="seating"]', { timeout: 5000 });

  // Add a round table
  await page.fill("#f-table-name", "Table 1");
  await page.fill("#f-table-capacity", "6");
  await page.selectOption("#f-table-shape", "round");
  await page.click("#add-table-btn");
  await page.waitForSelector(".seat-table-visual.round", { timeout: 5000 });
  console.log("PASS: seating chart lives on its own Seating tab, round table added");

  // Add a rectangular table too, and confirm it renders with the rectangle
  // shape class (different seat-placement math from round)
  await page.fill("#f-table-name", "Head Table");
  await page.fill("#f-table-capacity", "8");
  await page.selectOption("#f-table-shape", "rectangle");
  await page.click("#add-table-btn");
  await page.waitForSelector(".seat-table-visual.rectangle", { timeout: 5000 });
  console.log("PASS: a rectangular table can be added alongside a round one");

  // Seat both guests via the "Unseated" assignment dropdowns, onto Table 1
  const unseatedSelects = page.locator('.card:has(h3:text("Unseated")) select[data-guest-field^="tableId|"]');
  const countBefore = await unseatedSelects.count();
  if (countBefore !== 2) throw new Error("expected 2 unseated invited guests, found " + countBefore);
  for (let i = 0; i < countBefore; i++) {
    // Assigning a table via this dropdown updates state in memory but
    // doesn't re-render (by design — it's a plain field edit, applied on
    // Save like the rest of the form), so the DOM list of unseated rows
    // stays put; address each row by its original index rather than
    // always nth(0).
    const options = await unseatedSelects.nth(i).locator("option").allTextContents();
    if (!options.includes("Table 1")) throw new Error("Table 1 missing from assignment dropdown: " + JSON.stringify(options));
    await unseatedSelects.nth(i).selectOption({ label: "Table 1" });
  }
  await page.click("#save-seating-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge-6")?.textContent || ""), { timeout: 5000 });

  // Regression test: a freshly added table's default position used to sit
  // close enough to the top of the floor-plan canvas that its (much bigger,
  // overflow-visible) seat ring bled outside the canvas and covered the
  // Visual/List toggle row above it, silently eating clicks on "List".
  await page.click('[data-seating-view="list"]', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('[data-seating-view="list"]').classList.contains("active"), { timeout: 5000 });
  await page.waitForSelector('.tab-panel.active[data-panel="seating"] .cat-card', { timeout: 5000 });
  console.log("PASS: the List toggle is clickable and switches views (not blocked by the floor plan canvas)");
  await page.click('[data-seating-view="visual"]', { timeout: 5000 });
  await page.waitForSelector(".seat-table-visual", { timeout: 5000 });

  // Pills show a shortened "First L." label (crowded tables are hard to
  // read with full names), but the full name is still available via the
  // title tooltip.
  await page.waitForFunction(() => {
    const pills = Array.from(document.querySelectorAll(".seat-pill"));
    return pills.some((p) => p.textContent.trim() === "Priyanka S." && p.title.includes("Priyanka Subramaniam")) &&
      pills.some((p) => p.textContent.trim() === "Alex C." && p.title.includes("Alex Chen"));
  }, { timeout: 5000 });
  console.log("PASS: pills show a shortened first-name-plus-last-initial label, full name still in the tooltip");

  // Unfilled seats: Table 1 has 6 capacity / 2 seated (4 empty), Head Table
  // has 8 capacity / 0 seated (8 empty) = 12 empty-seat dots total
  const dotCount = await page.locator(".seat-dot").count();
  if (dotCount !== 12) throw new Error("expected 12 empty-seat placeholder dots total, got " + dotCount);
  console.log("PASS: unfilled seats render as compact placeholder dots (" + dotCount + " of them)");

  // Every pill/dot must be positioned (non-zero radius from center) so
  // names are genuinely arranged around the table, not stacked at 0,0
  const positions = await page.$$eval(".seat-visual-stage", (stages) =>
    stages.map((stage) => {
      const rect = stage.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const seats = Array.from(stage.querySelectorAll(".seat-pill, .seat-dot"));
      return seats.every((e) => Math.hypot(parseFloat(e.style.left) - cx, parseFloat(e.style.top) - cy) > 15);
    }));
  if (!positions.every(Boolean)) throw new Error("some seats are not spread around their table center");
  console.log("PASS: all seats (filled and empty), on both table shapes, are positioned around their table, not stacked at the center");

  // Clicking a filled name pill should unseat that guest immediately
  const pill = page.locator('.seat-pill[title*="Alex Chen"]').first();
  await pill.click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll(".seat-pill")).some((p) => p.title.includes("Alex Chen")), { timeout: 5000 });
  console.log("PASS: clicking a name pill unseats that guest immediately");

  // Table names now render inside the table shape itself, not in a label
  // floating below the whole (much larger) stage
  const table1Name = page.locator(".seat-table-name", { hasText: "Table 1" });
  const table1Box = await table1Name.boundingBox();
  const table1ShapeBox = await page.locator('.floor-table', { has: table1Name }).locator('[data-table-drag]').boundingBox();
  const nameCenterY = table1Box.y + table1Box.height / 2;
  if (nameCenterY < table1ShapeBox.y || nameCenterY > table1ShapeBox.y + table1ShapeBox.height) {
    throw new Error("table name is not positioned inside its own table shape");
  }
  console.log("PASS: table name renders inside the table shape, right next to the seat count");

  // Rotating a table: click Rotate once (45°) and confirm the shape's
  // transform picks up the rotation, while the name/count label counter-
  // rotates to stay upright
  const table1Wrap = page.locator('.floor-table', { has: table1Name });
  await table1Wrap.locator('[data-table-rotate]').click();
  await page.waitForFunction(() => {
    const shape = document.querySelector('.floor-table [data-table-drag]');
    return shape && /rotate\(45deg\)/.test(shape.style.transform);
  }, { timeout: 5000 });
  const centerTransform = await page.locator(".seat-table-center").first().evaluate((el) => el.style.transform);
  if (!/rotate\(-45deg\)/.test(centerTransform)) throw new Error("table label did not counter-rotate to stay upright, got: " + centerTransform);
  console.log("PASS: rotating a table turns the shape 45° and keeps its label upright");

  // Full screen: toggling it applies the fullscreen class and an Exit
  // control appears; toggling again (via Exit) removes it
  await page.click("#fullscreen-seating-btn");
  await page.waitForSelector(".floor-plan-canvas.fullscreen", { timeout: 5000 });
  await page.waitForSelector("#exit-fullscreen-btn", { timeout: 5000 });
  console.log("PASS: Full screen expands the floor plan canvas");
  await page.click("#exit-fullscreen-btn");
  await page.waitForFunction(() => !document.querySelector(".floor-plan-canvas.fullscreen"), { timeout: 5000 });
  console.log("PASS: Exit full screen returns the floor plan to its normal size");

  // Drag Table 1 to a new spot on the floor plan and confirm the position
  // both updates live and survives a Save + reload
  const floorTable = page.locator('.floor-table', { has: page.locator('.seat-table-name', { hasText: "Table 1" }) });
  const beforeBox = await floorTable.boundingBox();
  const shapeHandle = floorTable.locator('[data-table-drag]');
  const shapeBox = await shapeHandle.boundingBox();
  const canvasBox = await page.locator("#floor-plan-canvas").boundingBox();

  await page.mouse.move(shapeBox.x + shapeBox.width / 2, shapeBox.y + shapeBox.height / 2);
  await page.mouse.down();
  const targetX = canvasBox.x + canvasBox.width * 0.8;
  const targetY = canvasBox.y + canvasBox.height * 0.8;
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();

  const afterBox = await floorTable.boundingBox();
  const moved = Math.hypot(afterBox.x - beforeBox.x, afterBox.y - beforeBox.y) > 50;
  if (!moved) throw new Error("dragging the table did not move it — before: " + JSON.stringify(beforeBox) + " after: " + JSON.stringify(afterBox));
  console.log("PASS: dragging a table moves it live on the floor plan");

  // Read back the saved position as the left/top PERCENTAGES actually
  // stored on the element (and, after reload, re-derived from state.tables
  // via the renderer) — not absolute page pixel coordinates. A page pixel
  // boundingBox can legitimately shift between two renders if unrelated
  // content above the canvas (e.g. the Unseated table) changes height, even
  // though the table's real position within its own floor plan is unchanged
  // — so that's not a meaningful way to check persistence.
  const readPct = async (loc) => loc.evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  const afterDragPct = await readPct(floorTable);

  await page.click("#save-seating-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge-6")?.textContent || ""), { timeout: 5000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="seating"]');
  await page.waitForSelector('[data-panel="seating"]', { timeout: 5000 });
  const afterReloadPct = await readPct(page.locator('.floor-table', { has: page.locator('.seat-table-name', { hasText: "Table 1" }) }));
  const persisted = Math.hypot(afterReloadPct.left - afterDragPct.left, afterReloadPct.top - afterDragPct.top) < 1;
  if (!persisted) throw new Error("dragged table position did not survive save + reload — after-drag %: " + JSON.stringify(afterDragPct) + " after-reload %: " + JSON.stringify(afterReloadPct));
  console.log("PASS: dragged table position persists after Save and a page reload");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll seating-chart regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
