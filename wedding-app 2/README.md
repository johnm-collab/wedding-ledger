# The Wedding Ledger — standalone app

A private, two-account version of your wedding planner: a real Node/Express
backend, a shared Postgres database (Neon), and a login screen instead of a
public Claude Artifact link. Same design and the same planning features you
already had — budget recommendations, vendor tracking, guest list, seating
chart, checklist, day-of timeline — just self-hosted with a password gate.

## How it's built

- `server.js` / `db.js` / `auth.js` — the backend. Express serves the API
  and the frontend; Postgres holds one shared JSON document (your whole
  planner) with an optimistic-concurrency `rev` counter, so if you and your
  partner save at the same moment, the second save gets the first person's
  latest data back instead of silently overwriting it.
- `public/index.html` — the frontend. This is your existing planner UI,
  unchanged in every feature and every visual detail, with the Claude
  Artifact-specific plumbing (the self-republishing "quine" trick, the
  `downloads` capability) replaced by plain `fetch()` calls to the backend
  and a normal browser file download.
- Login is two fixed accounts (you + your partner) — there's no public
  signup page and no third account can be created without you adding one.
  Passwords live in the database (not environment variables), so either of
  you can change your own password from the Profile tab, or reset it via a
  "Forgot password?" emailed link, without needing a redeploy.

## 1. Set up the database (Neon)

Render's own free Postgres expires 30 days after creation, which isn't
workable for something you'll use for months — so the database lives on
[Neon](https://neon.tech) instead, whose free tier doesn't expire.

1. Create a free Neon account and a new project.
2. Copy the connection string it gives you (starts with `postgresql://`).
   Use the "pooled connection" variant if Neon offers both.
3. You'll paste this into Render as `DATABASE_URL` in step 3 — the app
   creates its own table automatically on first boot, no manual schema step.

## 2. Generate your two account passwords

Locally (or in any Node environment — no `npm install` needed, this uses
only Node's built-in `crypto` module):

```bash
node scripts/hash-password.js "a real password for you"
node scripts/hash-password.js "a real password for your partner"
```

Each command prints a salted scrypt hash. You'll paste these into Render,
not the plain passwords — Render/Neon never see the real password.

These env vars are only a one-time seed: the first time the app starts up
and finds its `accounts` table empty, it copies these two accounts in, and
from then on the database is the source of truth. After that first boot,
change a password from the app itself (Profile tab → Account security, or
the "Forgot password?" link on the login screen) instead of editing these
variables — editing them again later has no effect.

## 2b. (Optional) Enable "forgot password" emails

The "Forgot password?" link works without this — the app will still accept
the request and generate a reset link — but won't actually be able to
email it to you until you set this up. Skipping it for now is fine; add it
whenever you want the emailed reset link to work.

1. Create a free account at [Resend](https://resend.com) and verify a
   sending domain (or use their default test setup for personal use).
2. Grab an API key from the Resend dashboard.
3. In step 3 below, add `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (something
   like `The Wedding Ledger <noreply@yourdomain.com>`, using your verified
   domain) alongside the other environment variables.

## 3. Deploy to Render

1. Push this folder to a GitHub repo (Render deploys from a repo).
2. In Render, create a new **Web Service** from that repo. Runtime: Node.
   Build command: `npm install`. Start command: `npm start`. Free instance
   type is fine.
3. Under the service's **Environment** tab, add:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `SESSION_SECRET` — any long random string (e.g. run
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     locally and paste the output)
   - `AUTH_USER_1_EMAIL`, `AUTH_USER_1_PASSWORD_HASH` — your login (used
     once, to seed the database — see step 2 above)
   - `AUTH_USER_2_EMAIL`, `AUTH_USER_2_PASSWORD_HASH` — your partner's login
     (same, one-time seed)
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — optional, only needed for
     "forgot password" emails to actually send (see step 2b above)
   - `NODE_ENV` = `production`
4. Deploy. Render gives you a `https://your-service.onrender.com` URL —
   that's the link you both use to log in.

Note: on Render's free tier the service spins down after 15 minutes of no
traffic and takes a few seconds to wake back up on the next visit. That's
normal and doesn't affect your saved data (which lives in Neon, not on the
Render instance).

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET, both accounts
npm start
```

Then visit `http://localhost:3000`.

## What didn't come across yet

The old "upload a vendor quote and I'll read it" / "request vendor research
and I'll find real options" features are still present in the UI as a
request log, but nothing automatically processes them anymore — that
depended on Claude's Artifact tooling reading and republishing the page,
which doesn't apply to a standalone server. Wiring that back up (e.g. a
scheduled job that calls an admin API endpoint on this app, does the
research, and writes the results back to Postgres) is a separate follow-up
if you want it — just ask.

## Security notes

- Sessions are signed, httpOnly cookies valid for 90 days; logging out
  clears the cookie client-side (there's no server-side revocation list,
  so treat `SESSION_SECRET` as the thing to rotate if you ever need to
  force both of you to re-log-in).
- Login attempts are rate-limited (20 per 15 minutes per IP) to blunt
  brute-forcing, but with only two accounts and real passwords this is a
  low-stakes target — no additional hardening (2FA, etc.) was added.
