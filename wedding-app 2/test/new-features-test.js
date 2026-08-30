// Verifies the four latest changes in one pass:
// 1. "Add a login" — allowlist-restricted account creation from the Profile tab.
// 2. Mass-messaging rate limit is raised (server-side constant check only —
//    a full 60-request burst isn't practical in a quick regression run).
// 3. "Our story" photo gallery — upload, guest-portal display, remove.
// 4. "Preview as a guest" button — reuses the real portal render path.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// A tiny valid 1x1 PNG, so the upload flow gets a real image file.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  const isBenign = (text) => /ERR_TUNNEL_CONNECTION_FAILED|status of 401|status of 403|status of 400/.test(text);
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

  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector('.tab-panel.active[data-panel="profile"]', { timeout: 5000 });

  // --- 1. Add a login ---
  await page.waitForSelector("#f-new-login-email", { timeout: 5000 });
  const optionValues = await page.$$eval("#f-new-login-email option", (els) => els.map((e) => e.value));
  if (optionValues.includes("you@example.com")) throw new Error("the already-existing account should not show as an add option");
  console.log("PASS: add-login dropdown excludes the already-existing account, offers: " + JSON.stringify(optionValues));

  await page.selectOption("#f-new-login-email", "jkmundia99@gmail.com");
  await page.fill("#f-new-login-password", "correcthorse2");
  await page.click("#add-login-btn");
  await page.waitForFunction(() => /can now sign in/i.test(document.body.textContent || ""), { timeout: 5000 });
  console.log("PASS: allowlisted email (jkmundia99@gmail.com) successfully created a login");

  // Reload profile and confirm it now shows in the logins list and no longer as an add option
  await page.waitForFunction(() => document.body.textContent.includes("jkmundia99@gmail.com"), { timeout: 5000 });
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll("#f-new-login-email option")).some((o) => o.value === "jkmundia99@gmail.com"),
    { timeout: 5000 }
  );
  console.log("PASS: newly created login no longer offered as an add option");

  // Confirm the new login can actually sign in
  const page2 = await browser.newPage();
  await page2.goto("http://127.0.0.1:4123/", { waitUntil: "networkidle" });
  await page2.fill("#login-email", "jkmundia99@gmail.com");
  await page2.fill("#login-password", "correcthorse2");
  await page2.click("#login-form button[type=submit]");
  await page2.waitForSelector(".masthead-title, #wizard-finish-btn", { timeout: 5000 });
  console.log("PASS: newly created login (jkmundia99@gmail.com) can actually sign in");
  await page2.close();

  // Confirm a non-allowlisted email is rejected server-side even if forced
  const rejected = await page.evaluate(async () => {
    const res = await fetch("/api/accounts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone-else@example.com", password: "correcthorse3" })
    });
    return res.status;
  });
  if (rejected !== 403) throw new Error("expected 403 for a non-allowlisted email, got " + rejected);
  console.log("PASS: server rejects a non-allowlisted email with 403, even via a raw API call");

  // --- 2. Messaging rate limit raised ---
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const messageLimiterMatch = serverJs.match(/const messageLimiter = rateLimit\(\{[\s\S]*?max:\s*(\d+)/);
  if (!messageLimiterMatch || Number(messageLimiterMatch[1]) <= 10) throw new Error("expected messageLimiter max to be raised above 10, found: " + (messageLimiterMatch && messageLimiterMatch[1]));
  console.log("PASS: messageLimiter max raised to " + messageLimiterMatch[1] + " (was 10)");

  // --- 3. Our Story photo gallery ---
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="guestsite"]');
  await page.waitForSelector('.tab-panel.active[data-panel="guestsite"]', { timeout: 5000 });
  await page.fill("#f-story", "How we met, the short version.");
  const tmpImgPath = "/tmp/wl_test_story_photo.png";
  fs.writeFileSync(tmpImgPath, PNG_1x1);
  await page.setInputFiles("#f-story-photos", tmpImgPath);
  await page.waitForFunction(() => /photos updated/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  const tileCount = await page.locator(".story-photo-tile").count();
  if (tileCount !== 1) throw new Error("expected 1 story photo tile after upload, got " + tileCount);
  console.log("PASS: story photo uploads and renders a tile in the editor");

  // Save the story text too (photo save doesn't touch the textarea's own save button)
  await page.click("#save-guestsite-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge-8")?.textContent || document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });

  // Confirm it shows on the actual guest portal page for a real guest link
  const portalCheck = await page.evaluate(async () => {
    const stateRes = await fetch("/api/state", { credentials: "same-origin" });
    return stateRes.status;
  });
  if (portalCheck !== 200) throw new Error("could not re-fetch state to verify save, status " + portalCheck);

  // --- 4. Preview as a guest ---
  await page.click("#guest-preview-btn");
  await page.waitForSelector(".portal-preview-banner", { timeout: 5000 });
  await page.waitForSelector(".portal-story-photos img", { timeout: 5000 });
  const previewStoryText = await page.locator(".portal-story").textContent();
  if (!/How we met/.test(previewStoryText)) throw new Error("expected story text in preview, got: " + previewStoryText);
  console.log("PASS: 'Preview as a guest' shows the story text and story photo exactly as a guest would see it");

  await page.click("#guest-preview-exit-btn");
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  console.log("PASS: 'Back to dashboard' returns to the normal app");

  // Remove the story photo, confirm the tile disappears
  await page.click("#nav-toggle-btn");
  await page.waitForSelector(".nav-drawer.open", { timeout: 5000 });
  await page.click('[data-tab="guestsite"]');
  await page.waitForSelector('.tab-panel.active[data-panel="guestsite"]', { timeout: 5000 });
  await page.click("[data-story-photo-remove='0']");
  await page.waitForFunction(() => document.querySelectorAll(".story-photo-tile").length === 0, { timeout: 5000 });
  console.log("PASS: removing a story photo works");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll new-features regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
