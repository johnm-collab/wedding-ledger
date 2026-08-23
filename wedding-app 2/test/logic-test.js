// Exercises db.js and auth.js control flow. auth.js only depends on Node's
// built-in crypto module (no bcrypt/jsonwebtoken), so this runs with real
// hashing/signing logic. db.js still needs the mock pg/ in node_modules/
// (the real npm registry is unreachable from this sandbox) — that part
// isn't a substitute for testing against real Postgres, but catches wiring
// bugs in the optimistic-concurrency logic.
const assert = require("assert");
const path = require("path");

const auth = require(path.join(__dirname, "..", "auth.js"));

process.env.DATABASE_URL = "postgresql://fake";
process.env.SESSION_SECRET = "test-secret";
process.env.AUTH_USER_1_EMAIL = "you@example.com";
process.env.AUTH_USER_1_PASSWORD_HASH = auth.hashPassword("correcthorse");
process.env.AUTH_USER_2_EMAIL = "partner@example.com";
process.env.AUTH_USER_2_PASSWORD_HASH = auth.hashPassword("anotherpass");

const db = require(path.join(__dirname, "..", "db.js"));

async function run() {
  // --- db.js: init + default state ---
  await db.init();
  let { state, rev } = await db.getState();
  assert.strictEqual(rev, 0, "fresh state should be rev 0");
  assert.deepStrictEqual(state.profile.coupleNames, "", "default profile should be blank");
  assert.strictEqual(Object.keys(state.categories).length, 14, "should seed 14 vendor categories");
  assert.strictEqual(state.checklist.length, 27, "should seed 27 checklist items");
  console.log("PASS: db.init() seeds correct default state");

  // --- db.js: successful save advances rev ---
  const edited = JSON.parse(JSON.stringify(state));
  edited.profile.coupleNames = "Alex & Sam";
  const saveResult = await db.saveState(edited, 0, "you@example.com");
  assert.strictEqual(saveResult.conflict, false, "save with correct expectedRev should not conflict");
  assert.strictEqual(saveResult.rev, 1, "rev should advance to 1");
  const reloaded = await db.getState();
  assert.strictEqual(reloaded.rev, 1, "reload should reflect new rev");
  assert.strictEqual(reloaded.state.profile.coupleNames, "Alex & Sam", "reload should reflect saved edit");
  console.log("PASS: db.saveState() persists and advances rev");

  // --- db.js: stale expectedRev is rejected as a conflict ---
  const staleEdit = JSON.parse(JSON.stringify(state)); // still has rev-0-era content
  staleEdit.profile.coupleNames = "Stale Writer";
  const conflictResult = await db.saveState(staleEdit, 0, "partner@example.com");
  assert.strictEqual(conflictResult.conflict, true, "save with stale expectedRev should conflict");
  assert.strictEqual(conflictResult.rev, 1, "conflict response should report the current rev");
  assert.strictEqual(conflictResult.state.profile.coupleNames, "Alex & Sam", "conflict response should return current data, not the stale write");
  const afterConflict = await db.getState();
  assert.strictEqual(afterConflict.state.profile.coupleNames, "Alex & Sam", "a rejected write must not mutate stored state");
  console.log("PASS: db.saveState() rejects stale expectedRev without clobbering data");

  // --- auth.js: credential verification ---
  const goodLogin = await auth.verifyCredentials("you@example.com", "correcthorse");
  assert.strictEqual(goodLogin.email, "you@example.com", "correct credentials should verify");
  const badPassword = await auth.verifyCredentials("you@example.com", "wrongpassword");
  assert.strictEqual(badPassword, null, "wrong password should be rejected");
  const unknownEmail = await auth.verifyCredentials("nobody@example.com", "whatever");
  assert.strictEqual(unknownEmail, null, "unknown email should be rejected");
  const caseInsensitive = await auth.verifyCredentials("YOU@EXAMPLE.COM", "correcthorse");
  assert.strictEqual(caseInsensitive.email, "you@example.com", "email match should be case-insensitive");
  console.log("PASS: auth.verifyCredentials() accepts/rejects correctly");

  // --- auth.js: session cookie sign/verify round trip ---
  const fakeRes = { cookie(name, value) { fakeRes._cookie = value; }, clearCookie() {} };
  auth.setSessionCookie(fakeRes, { email: "you@example.com" });
  assert.ok(fakeRes._cookie, "setSessionCookie should set a cookie value");
  const verified = auth.verifySession(fakeRes._cookie);
  assert.strictEqual(verified.email, "you@example.com", "verifySession should recover the signed email");
  const tampered = auth.verifySession(fakeRes._cookie.slice(0, -2) + "xx");
  assert.strictEqual(tampered, null, "tampered token should fail verification");
  console.log("PASS: auth session cookie sign/verify round trip");

  // --- auth.js: requireAuth middleware ---
  let nextCalled = false;
  let statusCode = null;
  const reqOk = { cookies: { [auth.COOKIE_NAME]: fakeRes._cookie } };
  const resOk = { status(c) { statusCode = c; return this; }, json() {} };
  auth.requireAuth(reqOk, resOk, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, "requireAuth should call next() for a valid session");
  assert.strictEqual(reqOk.user.email, "you@example.com", "requireAuth should attach req.user");

  nextCalled = false;
  const reqBad = { cookies: {} };
  const resBad = { status(c) { statusCode = c; return this; }, json() {} };
  auth.requireAuth(reqBad, resBad, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, "requireAuth should block a missing session");
  assert.strictEqual(statusCode, 401, "requireAuth should respond 401 for a missing session");
  console.log("PASS: auth.requireAuth() middleware gate");

  console.log("\nAll logic tests passed.");
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
