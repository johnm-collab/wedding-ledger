const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const auth = require("./auth");
const email = require("./email");

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
    // 400, not 401: the request itself is properly authenticated (it made
    // it past auth.requireAuth on a valid session) — this is a form
    // validation failure, not a session problem, and the frontend treats a
    // 401 here as "your session expired, go back to the login screen",
    // which would be wrong.
    if (!verified) return res.status(400).json({ error: "Current password is incorrect." });
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
    const photo = state.profile && state.profile.couplePhoto;
    if (typeof photo === "string" && photo.length > 3 * 1024 * 1024) {
      return res.status(400).json({ error: "That photo is too large — try a smaller image." });
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

// ---- guest RSVP portal (unauthenticated, token-gated) ----
//
// Reached at /rsvp/<token> from a link the couple generates and shares
// (see the Guest List tab). A token resolves to either a household (every
// guest with that householdId — the couple can put several family members
// behind one shared link) or a single guest (a personal token, when they're
// not part of a household). Anything else is a generic 404, matching the
// forgot-password anti-enumeration pattern, so this can't be used to probe
// for valid tokens. Writes are scoped strictly to the resolved guest ids —
// the request body can never touch a guest outside its own household — and
// go through the same optimistic-concurrency read-modify-write-retry as
// every other write to the shared planner state, since this is the one
// write path that isn't behind a login and could otherwise race the couple's
// own edits.
const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a few minutes." }
});

function resolvePortalScope(state, token) {
  if (!token) return null;
  const household = (state.households || []).find((h) => h.rsvpToken && h.rsvpToken === token);
  if (household) {
    const guestIds = (state.guests || []).filter((g) => g.householdId === household.id).map((g) => g.id);
    if (!guestIds.length) return null;
    return { kind: "household", household, guestIds };
  }
  const guest = (state.guests || []).find((g) => g.rsvpToken && g.rsvpToken === token);
  if (guest) return { kind: "guest", guestIds: [guest.id], guest };
  return null;
}

function makePortalGuestId() {
  return "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

app.get("/api/guest-portal/:token", portalLimiter, async (req, res) => {
  try {
    const { state } = await db.getState();
    const scope = resolvePortalScope(state, req.params.token);
    if (!scope) return res.status(404).json({ error: "This RSVP link isn't valid." });
    const members = state.guests
      .filter((g) => scope.guestIds.includes(g.id))
      .map((g) => ({
        id: g.id, name: g.name, rsvp: g.rsvp || "not_sent",
        mealChoice: g.mealChoice || "", email: g.email || "",
        plusOne: !!g.plusOne, plusOneName: g.plusOneName || ""
      }));
    res.json({
      ok: true,
      householdName: scope.kind === "household" ? scope.household.name : null,
      colorway: (state.settings && state.settings.colorway) || "classic",
      profile: {
        coupleNames: (state.profile && state.profile.coupleNames) || "",
        weddingDate: (state.profile && state.profile.weddingDate) || "",
        location: (state.profile && state.profile.location) || "",
        address: (state.profile && state.profile.address) || "",
        couplePhoto: (state.profile && state.profile.couplePhoto) || ""
      },
      timeline: (state.timeline || []).map((t) => ({ time: t.time || "", title: t.title || "", notes: t.notes || "" })),
      members
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load this RSVP link right now." });
  }
});

app.post("/api/guest-portal/:token", portalLimiter, async (req, res) => {
  try {
    const { updates, additions } = req.body || {};
    const hasUpdates = Array.isArray(updates) && updates.length;
    const hasAdditions = Array.isArray(additions) && additions.length;
    if (!hasUpdates && !hasAdditions) return res.status(400).json({ error: "No changes submitted." });
    if (hasAdditions && additions.length > 6) return res.status(400).json({ error: "Too many people added at once — please submit a few at a time." });

    const VALID_RSVP = new Set(["not_sent", "sent", "attending", "declined"]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { state, rev } = await db.getState();
      const scope = resolvePortalScope(state, req.params.token);
      if (!scope) return res.status(404).json({ error: "This RSVP link isn't valid." });

      const allowedIds = new Set(scope.guestIds);
      const next = JSON.parse(JSON.stringify(state));
      let changed = false;
      (updates || []).forEach((u) => {
        if (!u || !allowedIds.has(u.id)) return; // never touch a guest outside this link's own household
        const g = next.guests.find((x) => x.id === u.id);
        if (!g) return;
        if (typeof u.rsvp === "string" && VALID_RSVP.has(u.rsvp)) { g.rsvp = u.rsvp; changed = true; }
        if (typeof u.mealChoice === "string") { g.mealChoice = u.mealChoice.slice(0, 200); changed = true; }
        if (typeof u.email === "string") { g.email = u.email.slice(0, 200); changed = true; }
      });

      // A guest can add a family member/+1 who wasn't already on the list.
      // These land as new guest records, scoped to this link's own
      // household (or unattached, for a personal link), flagged
      // pendingApproval so the couple reviews them before they count
      // toward headcount/seating — this can never touch or reveal any
      // other guest's data.
      const addedNoteBase = scope.kind === "household"
        ? "Added via the " + (scope.household.name || "household") + " RSVP link"
        : "Added via " + ((scope.guest && scope.guest.name) || "a guest") + "'s RSVP link";
      (additions || []).forEach((a) => {
        if (!a || typeof a.name !== "string") return;
        const name = a.name.trim().slice(0, 120);
        if (!name) return;
        const rsvp = typeof a.rsvp === "string" && VALID_RSVP.has(a.rsvp) ? a.rsvp : "attending";
        const mealChoice = typeof a.mealChoice === "string" ? a.mealChoice.slice(0, 200) : "";
        next.guests.push({
          id: makePortalGuestId(), name, side: "", group: "", plusOne: false, status: "invite",
          howYouKnow: "", lastContact: "", closeness: "", notes: addedNoteBase,
          rsvp, mealChoice, email: "", plusOneName: "", needsHotel: false, hotelBlock: "", arrival: "", departure: "",
          giftReceived: false, giftDescription: "", thankYouSent: false, tableId: "",
          householdId: scope.kind === "household" ? scope.household.id : "", rsvpToken: "",
          pendingApproval: true
        });
        changed = true;
      });

      if (!changed) return res.status(400).json({ error: "No valid changes submitted." });

      const result = await db.saveState(next, rev, "guest-portal:" + req.params.token.slice(0, 8));
      if (!result.conflict) return res.json({ ok: true });
      // The couple (or another member on the same shared link) saved in
      // between our read and write — loop and retry against the fresh
      // state instead of clobbering it.
    }
    res.status(409).json({ error: "Could not save right now — please try again." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save your RSVP right now." });
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
