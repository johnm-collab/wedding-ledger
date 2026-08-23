const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (like Heroku, Vercel, etc.) puts the app behind a reverse proxy
// that sets X-Forwarded-For to the real client IP. Express ignores that
// header by default, which makes express-rate-limit's IP-based key
// generator throw (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) instead of handling
// the request — that crash is what surfaced to users as "Network error"
// on login. Trusting exactly one hop (the platform's own edge proxy) is
// the standard, safe setting for this kind of single-proxy deployment.
app.set("trust proxy", 1);

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
