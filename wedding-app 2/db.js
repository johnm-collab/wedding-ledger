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
    profile: { coupleNames: "", weddingDate: "", location: "", guestCount: null, budgetTotal: null, style: "", notes: "" },
    categories,
    checklist,
    requests: [],
    guests: [],
    fileImports: [],
    timeline: [],
    tables: [],
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

module.exports = { pool, init, getState, saveState, defaultState };
