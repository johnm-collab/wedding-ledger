const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const auth = require("./auth");
const email = require("./email");

const app = express();
const PORT = process.env.PORT || 3000;


app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." }
});

app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    const user = await auth.verifyCredentials(email, password);
    if (!user) return res.status(401).json({ error: "Incorrect email or password." });
    auth.setSessionCookie(res, user);
    res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not sign in right now." });
  }
});

app.post("/api/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const user = auth.verifySession(req.cookies && req.cookies[auth.COOKIE_NAME]);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user });
});

// Shared limiter for the password-change/forgot/reset endpoints — looser
// than the login limiter (these aren't a brute-force login target the same
// way), but still capped so someone can't hammer the forgot-password
// endpoint to spam an inbox or probe which emails exist.
const authActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." }
});

app.post("/api/change-password", authActionLimiter, auth.requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required." });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    const verified = await auth.verifyCredentials(req.user.email, currentPassword);
    if (!verified) return res.status(401).json({ error: "Current password is incorrect." });
    const newHash = auth.hashPassword(newPassword);
    await db.updateAccountPassword(req.user.email, newHash);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not change your password right now." });
  }
});

app.post("/api/forgot-password", authActionLimiter, async (req, res) => {
  // Always the same generic response, whether or not the email matches a
  // real account — otherwise this endpoint would let anyone check which
  // emails are registered ("account enumeration").
  const genericResponse = { ok: true, message: "If that email has an account, a reset link is on its way." };
  try {
    const { email: rawEmail } = req.body || {};
    const targetEmail = String(rawEmail || "").trim().toLowerCase();
    if (!targetEmail) return res.json(genericResponse);

    const account = await db.getAccountByEmail(targetEmail);
    if (account) {
      const token = auth.generateResetToken();
      const expiresAt = new Date(Date.now() + auth.RESET_TOKEN_TTL_MS);
      await db.createPasswordReset(account.email, token, expiresAt);
      const resetUrl = `${req.protocol}://${req.get("host")}/?resetToken=${token}`;
      await email.sendEmail({
        to: account.email,
        subject: "Reset your Wedding Ledger password",
        html: `<p>Someone (hopefully you) asked to reset the password for The Wedding Ledger.</p>` +
          `<p><a href="${resetUrl}">Click here to set a new password</a>. This link works for 1 hour.</p>` +
          `<p>If you didn't request this, you can ignore this email.</p>`
      });
    }
    res.json(genericResponse);
  } catch (e) {
    console.error(e);
    // Even on an internal error, don't leak account existence — still
    // reply with the generic message.
    res.json(genericResponse);
  }
});

app.post("/api/reset-password", authActionLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: "Missing reset token or new password." });
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    const reset = await db.getValidPasswordReset(token);
    if (!reset) return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
    const newHash = auth.hashPassword(newPassword);
    await db.updateAccountPassword(reset.email, newHash);
    await db.markPasswordResetUsed(token);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not reset your password right now." });
  }
});

app.get("/api/state", auth.requireAuth, async (req, res) => {
  try {
    const { state, rev } = await db.getState();
    res.json({ state, rev });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load your planner data." });
  }
});

app.put("/api/state", auth.requireAuth, async (req, res) => {
  try {
    const { state, expectedRev } = req.body || {};
    if (!state || typeof expectedRev !== "number") {
      return res.status(400).json({ error: "Malformed save request." });
    }
    const result = await db.saveState(state, expectedRev, req.user.email);
    if (result.conflict) {
      return res.status(409).json({ state: result.state, rev: result.rev });
    }
    res.json({ ok: true, rev: result.rev });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save your changes." });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`The Wedding Ledger listening on :${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to initialize database:", e);
    process.exit(1);
  });
