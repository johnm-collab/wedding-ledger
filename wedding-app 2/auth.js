// Two-account authentication. Both accounts are provisioned entirely via
// environment variables — there is no signup flow and no users table.
// Generate a password hash with `npm run hash-password -- "your password"`
// and paste the result into AUTH_USER_n_PASSWORD_HASH.
//
// Password hashing (scrypt) and session signing (HMAC-SHA256) both use
// Node's built-in crypto module only — no bcrypt/jsonwebtoken dependency,
// so credentials can be generated anywhere Node runs, no npm install needed.

const crypto = require("crypto");
const db = require("./db");

const COOKIE_NAME = "wl_session";
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
const DUMMY_SALT = Buffer.from("0000000000000000000000000000000000000000000000000000000000", "hex");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf("scrypt$") !== 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(String(password || ""), salt, SCRYPT_KEYLEN);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Accounts (email + password hash) live in the database now, not env vars
// — see db.js's initAccounts() for the one-time env-var seed migration.
async function verifyCredentials(email, password) {
  const account = await db.getAccountByEmail(email);
  if (!account) {
    // Run a real (discarded) scrypt hash so a nonexistent-email response
    // costs about the same CPU time as a wrong-password one.
    crypto.scryptSync(String(password || ""), DUMMY_SALT, SCRYPT_KEYLEN);
    return null;
  }
  return verifyPassword(password, account.password_hash) ? { email: account.email } : null;
}

// A cryptographically random, unguessable reset token. It's the row's
// primary key in password_resets, so it also has to be unpredictable
// enough that nobody can enumerate or guess another user's token.
function generateResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function signSession(user) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const payload = { email: user.email, exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}

function verifySession(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let sigBuf, expectedBuf;
  try {
    sigBuf = Buffer.from(sig, "base64url");
    expectedBuf = Buffer.from(crypto.createHmac("sha256", secret).update(body).digest("base64url"), "base64url");
  } catch (e) {
    return null;
  }
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return { email: payload.email };
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const user = verifySession(token);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  req.user = user;
  next();
}

function setSessionCookie(res, user) {
  const token = signSession(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TOKEN_TTL_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  verifyCredentials, requireAuth, setSessionCookie, clearSessionCookie, verifySession,
  hashPassword, verifyPassword, generateResetToken, COOKIE_NAME, RESET_TOKEN_TTL_MS
};
