// Minimal Resend REST API client, built on Node's built-in `https` module
// only — no `resend` (or any other) npm dependency to install.
//
// If RESEND_API_KEY isn't set, sendEmail() logs a warning and resolves
// without sending anything, so the app degrades gracefully (password
// changes and reset-link *requests* still work; the email itself just
// doesn't go out) rather than crashing when the key hasn't been configured
// yet.

const https = require("https");

function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    console.warn(`[email] RESEND_API_KEY/RESEND_FROM_EMAIL not set — skipping send to ${to} ("${subject}").`);
    return Promise.resolve({ skipped: true });
  }

  const payload = JSON.stringify({ from, to, subject, html });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ skipped: false, status: res.statusCode });
          } else {
            console.error(`[email] Resend API error ${res.statusCode}: ${body}`);
            // Resolve rather than reject: a broken email provider shouldn't
            // surface as a 500 to the user on flows (like forgot-password)
            // that must always look successful regardless of delivery.
            resolve({ skipped: false, status: res.statusCode, error: body });
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error("[email] Resend request failed:", e.message);
      resolve({ skipped: false, error: e.message });
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendEmail };
