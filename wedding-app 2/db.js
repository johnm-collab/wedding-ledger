// Postgres persistence for the shared wedding-planner state document.
// One row (id = 1) holds the entire state as JSONB, versioned with a
// monotonically increasing `rev` for optimistic-concurrency saves — this
// mirrors the compare-and-set semantics the frontend already expects.

const { Pool } = require("pg");

const CATEGORY_KEYS = [
  "planner", "venue", "photography", "videography", "catering", "attire",
  "florist", "music", "officiant", "invitations", "rentals", "hairMakeup",
  "transportation", "cake"
];

// Kept in sync with CATEGORY_META's labels in public/index.html — used only
// for the emailed digest (scripts/send-digest.js), which has no browser DOM
// to render category names from.
const CATEGORY_LABELS = {
  planner: "Wedding Planner", venue: "Venue", photography: "Photography",
  videography: "Videography", catering: "Catering", attire: "Attire",
  florist: "Florist & Décor", music: "Music (DJ / Band)", officiant: "Officiant",
  invitations: "Invitations & Stationery", rentals: "Rentals",
  hairMakeup: "Hair & Makeup", transportation: "Transportation", cake: "Cake & Desserts"
};

const CHECKLIST_DEFAULTS = [
  ["cl-01", "Set a total budget and rough guest count", -365, null],
  ["cl-02", "Draft the guest list", -330, null],
  ["cl-03", "Book a venue", -300, "venue"],
  ["cl-04", "Book a wedding planner (if using one)", -300, "planner"],
  ["cl-05", "Book photographer and videographer", -270, "photography"],
  ["cl-06", "Choose the wedding party", -260, null],
  ["cl-07", "Book catering", -240, "catering"],
  ["cl-08", "Start dress / attire shopping", -210, "attire"],
  ["cl-09", "Book florist", -180, "florist"],
  ["cl-10", "Book music (DJ or band)", -180, "music"],
  ["cl-11", "Book officiant", -150, "officiant"],
  ["cl-12", "Block hotel rooms for out-of-town guests", -150, null],
  ["cl-13", "Order invitations", -120, "invitations"],
  ["cl-14", "Book rental items (linens, chairs, tenting)", -120, "rentals"],
  ["cl-15", "Plan the honeymoon", -110, null],
  ["cl-16", "Order the cake", -90, "cake"],
  ["cl-17", "Send invitations", -75, null],
  ["cl-18", "Book hair & makeup trial", -70, "hairMakeup"],
  ["cl-19", "Book transportation", -60, "transportation"],
  ["cl-20", "Apply for marriage license (check local rules)", -45, null],
  ["cl-21", "Final dress fitting", -30, null],
  ["cl-22", "Give caterer final headcount", -21, null],
  ["cl-23", "Finalize seating chart", -14, null],
  ["cl-24", "Confirm details with every vendor", -10, null],
  ["cl-25", "Pay final vendor balances", -7, null],
  ["cl-26", "Rehearsal", -1, null],
  ["cl-27", "Wedding day", 0, null]
];

function defaultPayment() {
  return { depositAmount: null, depositPaid: false, depositDueDate: "", balanceAmount: null, balancePaid: false, balanceDueDate: "" };
}

function defaultState() {
  const categories = {};
  CATEGORY_KEYS.forEach((k) => {
    categories[k] = { requestStatus: "none", requestNote: "", vendors: [], bookedVendorId: null, allocated: null, actual: null, payment: defaultPayment() };
  });
  const checklist = CHECKLIST_DEFAULTS.map(([id, title, offset, category]) => ({
    id, title, offset, category: category || null, done: false, custom: false
  }));
  return {
    profile: { coupleNames: "", weddingDate: "", location: "", address: "", guestCount: null, budgetTotal: null, style: "", notes: "", couplePhoto: "", story: "" },
    categories,
    checklist,
    requests: [],
    guests: [],
    households: [],
    fileImports: [],
    timeline: [],
    tables: [],
    weddingParty: [],
    faq: [],
    registryLinks: [],
    messageLog: [],
    settings: { colorway: "classic", onboardingComplete: false },
    writable: true,
    _rev: 0
  };
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Point it at your Neon Postgres connection string.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )
  `);
  const { rows } = await pool.query("SELECT id FROM ledger_state WHERE id = 1");
  if (!rows.length) {
    await pool.query(
      "INSERT INTO ledger_state (id, data, rev) VALUES (1, $1, 0)",
      [defaultState()]
    );
    console.log("Seeded initial ledger state.");
  }
  await initAccounts();
}

// ---- accounts + password resets ----
//
// Passwords used to live only in Render env vars (AUTH_USER_n_EMAIL /
// AUTH_USER_n_PASSWORD_HASH), which meant every password change required a
// full app redeploy. They now live in this table instead, so a change or
// reset takes effect immediately. The env vars are kept as a one-time seed
// source: the very first time this table is empty, whatever accounts are
// currently described by those env vars get copied in, so both partners'
// existing logins keep working without any manual re-entry. After that,
// this table is the sole source of truth and the env vars are ignored.
async function initAccounts() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM accounts");
  if (rows[0].n > 0) return;

  const seeds = [];
  for (const n of [1, 2]) {
    const email = process.env[`AUTH_USER_${n}_EMAIL`];
    const hash = process.env[`AUTH_USER_${n}_PASSWORD_HASH`];
    if (email && hash) seeds.push([email.toLowerCase(), hash]);
  }
  for (const [email, hash] of seeds) {
    await pool.query(
      "INSERT INTO accounts (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
      [email, hash]
    );
  }
  if (seeds.length) console.log(`Seeded ${seeds.length} account(s) from environment variables into the accounts table.`);
}

async function listAccountEmails() {
  const { rows } = await pool.query("SELECT email FROM accounts");
  return rows.map((r) => r.email);
}

async function getAccountByEmail(email) {
  const { rows } = await pool.query(
    "SELECT email, password_hash FROM accounts WHERE email = $1",
    [String(email || "").toLowerCase()]
  );
  return rows[0] || null;
}

async function updateAccountPassword(email, newHash) {
  await pool.query(
    "UPDATE accounts SET password_hash = $1, updated_at = now() WHERE email = $2",
    [newHash, String(email || "").toLowerCase()]
  );
}

async function createPasswordReset(email, token, expiresAt) {
  await pool.query(
    "INSERT INTO password_resets (token, email, expires_at) VALUES ($1, $2, $3)",
    [token, String(email || "").toLowerCase(), expiresAt]
  );
}

// Returns the reset row only if the token exists, hasn't been used, and
// hasn't expired — callers should treat any other outcome (null) as "this
// link is no longer valid" without distinguishing why, to avoid leaking
// details to someone probing tokens.
async function getValidPasswordReset(token) {
  const { rows } = await pool.query(
    "SELECT token, email, expires_at, used_at FROM password_resets WHERE token = $1",
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

async function markPasswordResetUsed(token) {
  await pool.query("UPDATE password_resets SET used_at = now() WHERE token = $1", [token]);
}

async function getState() {
  const { rows } = await pool.query("SELECT data, rev FROM ledger_state WHERE id = 1");
  if (!rows.length) {
    await pool.query("INSERT INTO ledger_state (id, data, rev) VALUES (1, $1, 0)", [defaultState()]);
    return { state: defaultState(), rev: 0 };
  }
  return { state: rows[0].data, rev: rows[0].rev };
}

// Optimistic concurrency: the write only lands if `expectedRev` still
// matches the row's current rev. On a mismatch the caller gets back
// whatever is currently stored so the client can reconcile instead of
// silently clobbering the other account's edits.
async function saveState(nextState, expectedRev, updatedBy) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data, rev FROM ledger_state WHERE id = 1 FOR UPDATE");
    const current = rows[0];
    if (!current || current.rev !== expectedRev) {
      await client.query("ROLLBACK");
      return { conflict: true, state: current ? current.data : defaultState(), rev: current ? current.rev : 0 };
    }
    const newRev = current.rev + 1;
    await client.query(
      "UPDATE ledger_state SET data = $1, rev = $2, updated_at = now(), updated_by = $3 WHERE id = 1",
      [nextState, newRev, updatedBy || null]
    );
    await client.query("COMMIT");
    return { conflict: false, rev: newRev };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  pool, init, getState, saveState, defaultState,
  getAccountByEmail, updateAccountPassword, listAccountEmails,
  createPasswordReset, getValidPasswordReset, markPasswordResetUsed,
  CATEGORY_KEYS, CATEGORY_LABELS, CHECKLIST_DEFAULTS
};
