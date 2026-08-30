// Sends a one-time (per cooldown window) RSVP reminder to guests or
// households who haven't responded yet, once the couple has set an RSVP
// deadline on the Guest List tab. Meant to run on a schedule (a Render
// Cron Job calling `node scripts/send-rsvp-reminders.js`), same pattern as
// scripts/send-digest.js — connects to the database directly and exits
// when done, rather than adding an authenticated HTTP endpoint.
//
// Needs one extra env var beyond the digest script's: APP_URL (the app's
// public https URL, e.g. https://wedding-ledger.onrender.com), since this
// script builds real /rsvp/<token> links and — unlike a request handler —
// has no incoming request to read a host from.
//
// Gracefully does nothing (besides logging) if APP_URL or
// RESEND_API_KEY/RESEND_FROM_EMAIL aren't set, or if no RSVP deadline has
// been configured yet, and exits 0 either way so a missing setting doesn't
// fail the cron job.

const crypto = require("crypto");
const db = require("../db");
const email = require("../email");

const LOOKAHEAD_DAYS = 21; // start reminding up to 3 weeks before the deadline
const OVERDUE_GRACE_DAYS = 10; // stop nagging 10 days past a missed deadline
const REMINDER_COOLDOWN_MS = 5 * 24 * 60 * 60 * 1000; // at most one reminder per 5 days, even if the cron runs daily

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function needsReminder(g) {
  return g.rsvp !== "attending" && g.rsvp !== "declined";
}

function recentlyReminded(entity) {
  return !!(entity.rsvpReminderSentAt && (Date.now() - entity.rsvpReminderSentAt) < REMINDER_COOLDOWN_MS);
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function subjectFor(profile, daysUntil) {
  const names = (profile && profile.coupleNames) || "our wedding";
  if (daysUntil < 0) return `RSVP reminder — ${names} needs your response`;
  if (daysUntil === 0) return `Last day to RSVP for ${names}`;
  return `RSVP reminder — ${names}`;
}

function buildHtml(profile, recipientLabel, link, daysUntil) {
  const names = (profile && profile.coupleNames) || "us";
  const dateLine = profile && profile.weddingDate ? ` on ${profile.weddingDate}` : "";
  const urgency = daysUntil < 0
    ? "We haven't heard back from you yet, and our RSVP deadline has passed"
    : daysUntil === 0
      ? "Today's the last day to RSVP"
      : `Just a friendly reminder that we'd love to hear from you within the next ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
  return `<p>Hi ${escapeHtml(recipientLabel)},</p>
    <p>${urgency} for ${escapeHtml(names)}'s wedding${dateLine}.</p>
    <p><a href="${link}">Please RSVP here</a> — it only takes a minute.</p>
    <p style="color:#888;font-size:0.85em">This is an automated reminder from The Wedding Ledger.</p>`;
}

async function run() {
  const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (!appUrl) {
    console.log("[send-rsvp-reminders] APP_URL isn't set — can't build RSVP links, skipping.");
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    console.log("[send-rsvp-reminders] RESEND_API_KEY/RESEND_FROM_EMAIL not set — skipping (emails would be discarded anyway).");
    return;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, rev } = await db.getState();
    const deadlineStr = state.settings && state.settings.rsvpDeadline;
    if (!deadlineStr) {
      console.log("[send-rsvp-reminders] No RSVP deadline set on the Guest List tab — nothing to do.");
      return;
    }
    const deadline = new Date(deadlineStr + "T00:00:00");
    if (isNaN(deadline.getTime())) {
      console.log("[send-rsvp-reminders] RSVP deadline is invalid — skipping.");
      return;
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysUntil = daysBetween(today, deadline); // negative = overdue
    if (daysUntil > LOOKAHEAD_DAYS || daysUntil < -OVERDUE_GRACE_DAYS) {
      console.log(`[send-rsvp-reminders] Deadline is ${daysUntil} day(s) away — outside the reminder window (-${OVERDUE_GRACE_DAYS} to +${LOOKAHEAD_DAYS} days), skipping.`);
      return;
    }

    const next = JSON.parse(JSON.stringify(state));
    const households = next.households || [];

    // Households sharing one invite/link are treated as one unit: remind if
    // ANY member hasn't responded and the household hasn't been reminded
    // recently, sending once to whichever member email(s) are on file.
    const handledHouseholdIds = new Set();
    const sends = [];
    let skipped = 0;

    for (const h of households) {
      if (h.sendSeparateInvites) continue;
      const members = next.guests.filter((g) => g.householdId === h.id);
      if (!members.length) continue;
      handledHouseholdIds.add(h.id);
      if (!members.some(needsReminder)) continue;
      if (recentlyReminded(h)) { skipped++; continue; }
      const emails = Array.from(new Set(members.map((m) => m.email).filter((e) => e && String(e).trim())));
      if (!emails.length) { skipped++; continue; }
      if (!h.rsvpToken) h.rsvpToken = makeToken();
      const link = `${appUrl}/rsvp/${h.rsvpToken}`;
      sends.push({
        emails,
        html: buildHtml(state.profile, h.name || "your household", link, daysUntil),
        after: () => { h.rsvpReminderSentAt = Date.now(); }
      });
    }

    // Everyone else — a standalone guest, or a guest in a household that
    // opted into separate invites — gets their own personal reminder.
    for (const g of next.guests) {
      if (g.householdId && handledHouseholdIds.has(g.householdId)) continue; // already covered above
      if (!needsReminder(g)) continue;
      if (recentlyReminded(g)) { skipped++; continue; }
      if (!g.email || !String(g.email).trim()) { skipped++; continue; }
      if (!g.rsvpToken) g.rsvpToken = makeToken();
      const link = `${appUrl}/rsvp/${g.rsvpToken}`;
      sends.push({
        emails: [g.email],
        html: buildHtml(state.profile, g.name, link, daysUntil),
        after: () => { g.rsvpReminderSentAt = Date.now(); }
      });
    }

    if (!sends.length) {
      console.log(`[send-rsvp-reminders] Nothing to send this run (${skipped} skipped — already reminded recently, responded, or no email on file).`);
      return;
    }

    let sent = 0, failed = 0;
    for (const s of sends) {
      let anyOk = false;
      for (const to of s.emails) {
        const r = await email.sendEmail({ to, subject: subjectFor(state.profile, daysUntil), html: s.html });
        if (r.skipped || r.error) failed++; else { sent++; anyOk = true; }
      }
      if (anyOk) s.after();
    }

    const result = await db.saveState(next, rev, "system:send-rsvp-reminders");
    if (!result.conflict) {
      console.log(`[send-rsvp-reminders] Sent ${sent} reminder(s), ${failed} failed/skipped, ${skipped} not due for a reminder.`);
      return;
    }
    console.log("[send-rsvp-reminders] Save conflict (state changed mid-run) — retrying...");
  }
  console.log("[send-rsvp-reminders] Gave up after repeated save conflicts — will try again next run.");
}

run()
  .then(() => { db.pool.end(); process.exit(0); })
  .catch((e) => {
    console.error("[send-rsvp-reminders] Failed:", e);
    db.pool.end().finally(() => process.exit(1));
  });
