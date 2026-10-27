# Outreach

A cold-email and job-search tool. It finds people to contact (CSV, LinkedIn hiring posts, Hacker News, web search, company lookups), sends personalised emails through each user's own Gmail, reads the replies back from the mailbox, and tracks everything through to interviews.

It started as a single-owner tool. It is now **multi-user**: each account has its own contacts, templates, Gmail credentials and settings, and an admin decides who can sign in.

**Stack:** Node.js + Express · MongoDB Atlas (Mongoose 9) · Inngest (background jobs and crons) · React 18 + Vite + TypeScript (`client/`) · Vercel (region `bom1`) · Resend (sign-in codes and lifecycle emails)

---

## Quick start

```bash
cp .env.example .env          # every variable is documented in that file
npm install
NODE_ENV=dev npm start        # http://localhost:3000 → redirects to /app/
```

In a second terminal, run the Inngest dev server. Without it nothing sends and no cron runs:

```bash
npx inngest-cli@latest dev
```

To work on the frontend with hot reload:

```bash
npm run dev:client            # Vite dev server for client/
```

> **Check which database you are on.** `db.js` uses `MONGODB_URI_PROD` when `NODE_ENV=prod` and `MONGODB_URI_DEV` otherwise. If your `.env` sets `NODE_ENV=prod`, a bare `npm start` writes to the live database. The boot log says which one it picked.

### Signing in locally

There are no passwords. Sign-in is a six-digit code sent by email to a whitelisted address.

- Whitelist yourself (the first admin has to be made this way):
  ```bash
  node scripts/invite-user.js --email=you@example.com --admin --env=dev --execute
  ```
- With `RESEND_API_KEY` unset, the code is printed to the server log instead of emailed.
- Or set `AUTH_OPEN=1` (plus `AUTH_OPEN_EMAIL` once more than one account exists) to skip sign-in entirely. Local development only.

---

## What's in the app

The UI is a React single-page app served at `/app/`. Its source is in [client/src/pages](client/src/pages).

| Page | What it does |
|---|---|
| Dashboard | Replies waiting on you, sent/bounced counts, follow-ups due, and every contact |
| Analytics | Reply funnel, template and company performance, response speed, PDF reports |
| Contacts / Add Contacts | The contact list; add people by CSV/Excel upload or by hand |
| Send (`/send/step1–3`) | One-off sends: pick contacts, approve each personalised email, send |
| Campaigns | Hands-off drip sending: a list is released a set number per day at a chosen IST hour |
| Mailbox | Replies, with "Needs you" tabs for the ones waiting on an answer; reply in place |
| Interviews | People who replied, and interview stages, dates and reminders |
| Leads | Hiring posts from LinkedIn, Hacker News, web search or pasted text, with recruiter emails |
| Discover | Type a company, find people who work there, and guess their work email from its pattern |
| Companies | One page per company combining contacts, posts, jobs, interviews and the email format |
| Library | Data shared across users (contacts, leads, companies only). Admin-gated, and each user can opt out |
| Jobs | Every role from Naukri, Instahyre and Hirist in one pipeline, with your outreach state per company |
| Naukri | Keeps a Naukri profile fresh and applies to jobs you approve, using a local worker |
| Templates | Email templates with `{{variables}}` |
| Blocklist | Addresses and whole companies that must never be emailed |
| Export Contacts | Spreadsheet download, or a read-only share link for outsiders |
| Logs | Everything the app did: sends, imports, scrapes, errors |
| Settings / Onboarding | Sender identity, Gmail App Password, resume, custom variables, API keys |
| Admin | Users and access requests, per-user numbers, Issues, Sending, AI call logs, lifecycle emails. Admins only |

The old static pages in the repo root (`index.html`, `step1.html` …) are the pre-React UI. `/` now redirects to `/app/`.

### Template variables

`{{name}}`, `{{company}}`, `{{role}}`, `{{industry}}`, `{{jobTitle}}`, `{{sender}}`, `{{senderCompany}}`, `{{sentSubject}}`, plus any custom variable defined in **Settings**. Rendering is in [lib/renderTemplate.js](lib/renderTemplate.js).

### Gmail

Each user sends from their own Gmail account using an **App Password** (2-Step Verification on, then [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)). It is entered in Settings and stored per user, encrypted with AES-256-GCM under `CREDENTIAL_KEY` ([lib/credentials.js](lib/credentials.js)). If you rotate `CREDENTIAL_KEY`, every stored password becomes unreadable and has to be entered again.

When Gmail's daily limit is hit (SMTP 5.4.5), the batch pauses. An hourly `quota-watcher` resumes paused batches one account at a time.

---

## Background work

### Inngest functions

Sending and scheduled work run as Inngest functions served at `/api/inngest`. The crons run in IST.

| Function | Trigger | Where |
|---|---|---|
| `send-email-batch`, `send-email-bulk`, `send-email-drip`, `send-single-email` | events | [inngest-fns.js](inngest-fns.js) |
| `quota-watcher` / `resume-after-quota` | hourly at :05 / event | [inngest-fns.js](inngest-fns.js) |
| `campaigns-run-due` | hourly at :01 | [lib/campaigns/inngest.js](lib/campaigns/inngest.js) |
| `mailbox-sweep` (fans out one check per account) | every 2 h | [lib/mailbox/inngest.js](lib/mailbox/inngest.js) |
| `companies-enrich-daily` | 06:00 daily | [lib/discovery/enrich](lib/discovery/enrich) |
| `sources-hn-daily` / `sources-web-daily` | 07:00 on days 1–10 / 08:00 daily | [lib/sources/inngest.js](lib/sources/inngest.js) |
| `lifecycle-*` (daily emails, Monday report, 21:00 admin digest) | daily / weekly | [lib/lifecycle/inngest.js](lib/lifecycle/inngest.js) |
| `report-failed-functions` | any failed function, logged to Admin → Issues | [inngest-fns.js](inngest-fns.js) |

### GitHub Actions

These workflows call the app with the `X-Cron-Secret` header. Set `CRON_SECRET` in Vercel and as a GitHub secret, and set `VERCEL_APP_URL` as a GitHub secret too.

- `check-mailbox.yml` and `run-campaigns.yml`: now duplicated by the Inngest crons above and being retired. Running both at once is safe because campaign claims are atomic.

GitHub turns off scheduled workflows after 60 days with no repo activity.

### Mailbox scan

The mailbox check connects to Gmail over IMAP ([lib/mailbox](lib/mailbox)) and does three things:

- marks bounces, using the SMTP diagnostic;
- matches replies by `In-Reply-To`/`References`;
- sorts replies into categories. A rule pass runs first, then the first working LLM provider in `CLASSIFIER_PROVIDER_ORDER` (Groq, Gemini, Cerebras).

A scan holds a 3-minute lease per account, so two scans never overlap.

---

## Local workers

LinkedIn harvesting and Naukri automation attach to a **real, logged-in Chrome over CDP** on your own Mac or Linux desktop. They cannot run on Vercel, in Docker or in CI, and they are opt-in for each account.

```bash
npm run scrape-worker     # LinkedIn hiring-post harvest
npm run naukri-worker     # Naukri refresh / harvest / apply
npm run workers           # both
```

Each worker machine needs its own token from `POST /api/scrapes/worker-token`, set as `WORKER_SECRET` in that machine's `.env`. See [worker/README.md](worker/README.md) for setup.

---

## Deploying (Vercel)

```bash
cd client && npm run build    # Vercel does NOT build the client
git add client/dist           # the committed dist is what ships
vercel --prod
```

[vercel.json](vercel.json) builds only `server.js` and ships the committed `client/dist/**`. If you change `client/src` without rebuilding and committing `dist`, the change will not show up in production.

The server must run in `bom1`, next to the Atlas cluster in Mumbai. In any other region every query pays a cross-world round trip.

A deployed instance **refuses to boot** without `RESEND_API_KEY` and `OTP_FROM_EMAIL`. Every variable is listed in [.env.example](.env.example). The ones a deployment needs:

| Variable | Purpose |
|---|---|
| `MONGODB_URI_PROD` (+ `NODE_ENV=prod`) | Database |
| `CREDENTIAL_KEY` | Encrypts stored Gmail App Passwords |
| `RESEND_API_KEY`, `OTP_FROM_EMAIL` | Sign-in codes |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Background jobs |
| `CRON_SECRET` | GitHub Actions callers |
| `AUTH_SECRET` | Signs the share-link cookie |
| `OUTREACH_URL` | Links in lifecycle emails |
| `GROQ_API_KEY` / `GEMINI_API_KEY` / `CEREBRAS_API_KEY` | Reply classification (optional) |
| `LIFECYCLE_FROM_EMAIL` | Welcome, reminder and report emails (optional) |

---

## Scripts and tests

[scripts/](scripts) holds one-off tools and test suites. Scripts that change data are **dry-run unless you pass `--execute`**. Use `--env=dev` or `--env=prod` to pick the database.

| Script | Use |
|---|---|
| `invite-user.js` | Whitelist, promote, disable or enable a user |
| `mint-session.js` | Emergency sign-in if Resend is down |
| `import-gmail-credential.js` | Move the legacy `GMAIL_*` env credential into the database |
| `clone-db.js` | Back up a database before a migration |
| `lifecycle-preview.js` | See who would get which lifecycle email |
| `view-replies.js` | Inspect stored replies |

Test suites are named `scripts/test-*.js` and run with `NODE_ENV=dev node scripts/test-<name>.js`. Run these three after touching routes or auth:

- `test-tenant-isolation.js`
- `test-token-isolation.js`
- `test-admin-isolation.js`

Some suites need the server running and take `--email`. Check the header of each file.

---

## More documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture
- [worker/README.md](worker/README.md): the local scrape and Naukri workers
- [docs/send-modes.md](docs/send-modes.md): how the send modes differ
- [docs/VERCEL_CPU_CHANGES.md](docs/VERCEL_CPU_CHANGES.md): Vercel CPU measurements and fixes
- [.env.example](.env.example): every environment variable, with explanations

The API is defined in [routes/](routes) and mounted in [server.js](server.js). Every `/api` route except the auth, share and cron endpoints needs a signed-in session and is scoped to that user.
