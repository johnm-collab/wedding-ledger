// Reproduces the production bug directly: logging in behind Render's
// reverse proxy (which always adds X-Forwarded-For) crashed the login
// route because Express wasn't told to trust the proxy, and confirms the
// fix (app.set('trust proxy', 1)) resolves it. Runs the pre-fix server
// (server-buggy.js, current server.js with that one line stripped out)
// against a request carrying X-Forwarded-For, exactly like Render sends,
// then runs the real, fixed server.js the same way.
const path = require("path");
const assert = require("assert");

function freshEnv() {
  const auth = require(path.join(__dirname, "..", "auth.js"));
  return {
    DATABASE_URL: "postgresql://fake",
    SESSION_SECRET: "test-secret",
    AUTH_USER_1_EMAIL: "you@example.com",
    AUTH_USER_1_PASSWORD_HASH: auth.hashPassword("correcthorse"),
    NODE_ENV: "development"
  };
}

async function runServerOnPort(serverPath, port) {
  Object.assign(process.env, freshEnv(), { PORT: String(port) });
  // auth.js now also depends on db.js (accounts live in the database, not
  // just env vars) — its require.cache entry has to be cleared alongside
  // db.js's, otherwise it keeps pointing at whichever db.js singleton was
  // resolved on a previous run of this loop, and login fails against an
  // account table that was never seeded for THIS run.
  delete require.cache[require.resolve(serverPath)];
  delete require.cache[require.resolve(path.join(__dirname, "..", "db.js"))];
  delete require.cache[require.resolve(path.join(__dirname, "..", "auth.js"))];
  require(serverPath);
  await new Promise((r) => setTimeout(r, 300));
}

async function loginAsRenderWould(port) {
  // The one thing that matters: a real X-Forwarded-For header, exactly as
  // Render's edge proxy adds to every request that reaches the app.
  return fetch("http://127.0.0.1:" + port + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" },
    body: JSON.stringify({ email: "you@example.com", password: "correcthorse" })
  });
}

async function run() {
  // --- Pre-fix server: reproduce the actual bug ---
  await runServerOnPort(path.join(__dirname, "..", "server-buggy.js"), 4201);
  const buggyRes = await loginAsRenderWould(4201);
  assert.notStrictEqual(buggyRes.status, 200, "pre-fix server should NOT succeed when Render's X-Forwarded-For header is present");
  console.log("PASS: reproduced the bug — pre-fix server fails login behind Render's proxy (status " + buggyRes.status + ")");

  // --- Fixed server: same request, should now succeed ---
  await runServerOnPort(path.join(__dirname, "..", "server.js"), 4202);
  const fixedRes = await loginAsRenderWould(4202);
  assert.strictEqual(fixedRes.status, 200, "fixed server should succeed when Render's X-Forwarded-For header is present, got " + fixedRes.status);
  const body = await fixedRes.json();
  assert.strictEqual(body.user.email, "you@example.com", "fixed server should return the logged-in user");
  console.log("PASS: fixed server (trust proxy set) logs in successfully behind Render's proxy");

  console.log("\nAll trust-proxy regression tests passed.");
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
