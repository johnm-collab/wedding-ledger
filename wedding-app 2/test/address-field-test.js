// Verifies the new "Address" profile field: it renders, saves, and survives
// a reload, alongside the existing Location field (both coexist).
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
  await page.waitForSelector(".masthead-title", { timeout: 5000 });

  await page.click('[data-tab="profile"]');
  await page.waitForSelector("#f-address", { timeout: 5000 });
  console.log("PASS: Address field renders on the Profile tab");

  await page.fill("#f-location", "Austin, TX");
  await page.fill("#f-address", "456 River Rd, Austin, TX 78701");
  await page.click("#save-profile-btn");
  await page.waitForFunction(() => /saved/i.test(document.getElementById("save-status-badge")?.textContent || ""), { timeout: 5000 });
  console.log("PASS: Address field saves alongside Location");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".masthead-title", { timeout: 5000 });
  await page.click('[data-tab="profile"]');
  await page.waitForSelector("#f-address", { state: "visible", timeout: 5000 });
  const addressVal = await page.inputValue("#f-address");
  const locationVal = await page.inputValue("#f-location");
  if (addressVal !== "456 River Rd, Austin, TX 78701") throw new Error("address did not persist, got: " + addressVal);
  if (locationVal !== "Austin, TX") throw new Error("location did not persist, got: " + locationVal);
  console.log("PASS: both Address and Location persist after reload");

  if (errors.length) {
    console.error("Console/page errors observed:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("\nAll address-field regression tests passed.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
