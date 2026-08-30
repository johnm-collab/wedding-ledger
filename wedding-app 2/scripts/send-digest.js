// Weekly planning digest: upcoming checklist items and any deposit/balance
// coming due, emailed to both account holders. Meant to run on a schedule
// (a Render Cron Job calling `node scripts/send-digest.js`), not as part of
// the web server — it connects to the same database directly and exits when
// done, rather than adding a new authenticated HTTP endpoint + external
// scheduler for the app itself to expose.
//
// Gracefully does nothing (besides logging) if RESEND_API_KEY/
// RESEND_FROM_EMAIL aren't set, same as every other email in this app, and
// exits 0 either way so a missing key doesn't fail the cron job.

const db = require("../db");
const email = require("../email");

const LOOKAHEAD_DAYS = 14;

function dueDateFor(item, weddingDateStr) {
  if (!weddingDateStr || item.offset === null || item.offset === undefined) return null;
  const d = new Date(weddingDateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + item.offset);
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function computeUpcomingChecklist(state) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + LOOKAHEAD_DAYS);
  return (state.checklist || [])
    .map((it) => ({ it, due: dueDateFor(it, state.profile && state.profile.weddingDate) }))
    .filter((x) => x.due && !x.it.done && x.due >= today && x.due <= cutoff)
    .sort((a, b) => a.due - b.due);
}

function computeUpcomingPayments(state) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + LOOKAHEAD_DAYS);
  const items = [];
  db.CATEGORY_KEYS.forEach((key) => {
    const cat = state.categories && state.categories[key];
    if (!cat || !cat.payment) return;
    const pay = cat.payment;
    const label = db.CATEGORY_LABELS[key] || key;
    if (pay.depositAmount && pay.depositDueDate && !pay.depositPaid) {
      const due = new Date(pay.depositDueDate + "T00:00:00");
      if (!isNaN(due.getTime()) && due <= cutoff) items.push({ label, kind: "Deposit", amount: pay.depositAmount, due, overdue: due < today });
    }
    if (pay.balanceAmount && pay.balanceDueDate && !pay.balancePaid) {
      const due = new Date(pay.balanceDueDate + "T00:00:00");
      if (!isNaN(due.getTime()) && due <= cutoff) items.push({ label, kind: "Balance", amount: pay.balanceAmount, due, overdue: due < today });
    }
  });
  items.sort((a, b) => a.due - b.due);
  return items;
}

function buildHtml(state, checklist, payments) {
  const coupleNames = (state.profile && state.profile.coupleNames) || "your wedding";
  const checklistHtml = checklist.length
    ? "<ul>" + checklist.map((x) => `<li><strong>${fmtDate(x.due)}</strong> — ${x.it.title}</li>`).join("") + "</ul>"
    : "<p>Nothing on the checklist is due in the next two weeks.</p>";
  const paymentsHtml = payments.length
    ? "<ul>" + payments.map((p) => `<li>${p.overdue ? "⚠️ OVERDUE — " : ""}<strong>${fmtDate(p.due)}</strong> — ${p.label} ${p.kind}: $${Number(p.amount).toLocaleString()}</li>`).join("") + "</ul>"
    : "<p>No deposits or balances due in the next two weeks.</p>";
  return `<h2>Your Wedding Ledger — weekly digest</h2>
    <p>Here's what's coming up for ${coupleNames} in the next ${LOOKAHEAD_DAYS} days.</p>
    <h3>Checklist</h3>${checklistHtml}
    <h3>Payments due</h3>${paymentsHtml}
    <p style="color:#888;font-size:0.85em">You're receiving this because you're an account holder on The Wedding Ledger. This is an automated weekly summary — nothing to reply to.</p>`;
}

async function run() {
  const { state } = await db.getState();
  const checklist = computeUpcomingChecklist(state);
  const payments = computeUpcomingPayments(state);

  if (!checklist.length && !payments.length) {
    console.log("[send-digest] Nothing due in the next " + LOOKAHEAD_DAYS + " days — skipping send.");
    return;
  }

  const html = buildHtml(state, checklist, payments);
  const recipients = await db.listAccountEmails();
  if (!recipients.length) {
    console.warn("[send-digest] No account emails found — nothing to send to.");
    return;
  }

  for (const to of recipients) {
    await email.sendEmail({ to, subject: "The Wedding Ledger — weekly digest", html });
  }
  console.log(`[send-digest] Sent digest to ${recipients.length} account(s): ${checklist.length} checklist item(s), ${payments.length} payment(s) due.`);
}

run()
  .then(() => { db.pool.end(); process.exit(0); })
  .catch((e) => {
    console.error("[send-digest] Failed:", e);
    db.pool.end().finally(() => process.exit(1));
  });
