# Outreach — Email Campaign Tool

A personal cold-email outreach tool. Import contacts from CSV, personalise and approve emails per contact, send via Gmail, and automatically track bounces and replies.

**Stack:** Node.js + Express · MongoDB Atlas · Inngest (background jobs) · Vanilla HTML/CSS/JS · Vercel

> For a full architectural breakdown see [architecture.md](architecture.md).

---

## Quick start

```bash
cp .env.example .env   # fill in MONGODB_URI_DEV and optionally Gmail creds
npm install
npm start              # http://localhost:3000
```

For background email sending, run the Inngest dev server in a second terminal:

```bash
npx inngest-cli@latest dev
```

On first run the database is seeded with three default templates (Intro v2, Follow-up, Cold outreach) and a singleton settings document.

---

## Workflow

```
Settings → Step 1 (import) → Step 2 (approve) → Step 3 (send) → Dashboard
```

1. **Settings** — enter your name, company, Gmail address, and optionally upload your resume and define custom template variables.
2. **Step 1 — Add contacts** — upload a CSV (`Name,Email,Company,Role`) or enter contacts manually. A sample file is available to download on that page.
3. **Step 2 — Approve emails** — preview the personalised email for each contact; Approve, Edit, or Reject individually. Bulk-approve is also available.
4. **Step 3 — Send** — enter your Gmail App Password (or it's pre-filled from env), optionally attach your resume, and hit Send. Inngest fans out individual sends at 1.5 s intervals to respect Gmail rate limits.
5. **Dashboard** — live progress widget shows sent/failed counts. Use "Check for bounces & replies" (or the GitHub Actions cron) to pull IMAP data back into contact statuses.

---

## Gmail setup

### App Password (default)
1. Enable 2-Step Verification on your Google account.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and create a new App Password named "Outreach".
3. Copy the 16-character password — paste it at Step 3 (or set `GMAIL_APP_PASSWORD` in `.env`).

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI_DEV` | Yes (dev) | MongoDB Atlas URI for development |
| `MONGODB_URI_PROD` | Yes (prod) | MongoDB Atlas URI for production |
| `NODE_ENV` | No | Set to `prod` to use the prod URI |
| `GMAIL_EMAIL` | No | Pre-configure sender email at startup |
| `GMAIL_APP_PASSWORD` | No | Pre-configure App Password at startup |
| `SENDER_NAME` | No | Default sender name |
| `INNGEST_EVENT_KEY` | Yes (prod) | Inngest event key |
| `INNGEST_SIGNING_KEY` | Yes (prod) | Inngest signing key |
| `PORT` | No | HTTP port (default: 3000) |

---

## Pages

| File | Description |
|---|---|
| `index.html` | Dashboard — stats, contact table, mailbox check |
| `step1.html` | Add contacts — CSV upload or manual entry |
| `step2.html` | Approve / edit personalised emails per contact |
| `step3.html` | Enter Gmail credentials and trigger send |
| `done.html` | Completion screen |
| `contacts.html` | Full paginated contact list with status tabs |
| `templates.html` | Create, edit, and delete email templates |
| `settings.html` | Sender info, custom variables, resume upload |

---

## CSV format

```
Name,Email,Company,Role
Rahul Sharma,rahul@acme.in,Acme Corp,VP Sales
Priya Kaur,priya@startup.io,Startup.io,Co-founder
```

A `sample-contacts.csv` is available on the Step 1 page (also in the repo root).

---

## Template variables

| Variable | Value |
|---|---|
| `{{name}}` | Contact's first name |
| `{{company}}` | Contact's company |
| `{{role}}` | Contact's role |
| `{{sender}}` | Your name (from Settings) |
| `{{senderCompany}}` | Your company (from Settings) |
| `{{yourVariable}}` | Any custom variable defined in Settings |

Custom variables (e.g. `{{calendlyLink}}`, `{{phone}}`) are defined in **Settings → Custom variables**. Variable names must start with a letter and contain only letters, numbers, and underscores.

---

## Resume attachment

Upload a PDF or Word document (max 5 MB) on the Settings page. Step 3 shows an "Attach my resume" checkbox — when checked, every email in the batch includes the resume as an attachment.

---

## Bounce & reply tracking

`POST /api/check-mailbox` connects via IMAP to Gmail, scans the Inbox and Spam folders, and:
- Marks contacts **bounced** (with the SMTP diagnostic reason) when a mailer-daemon / multipart/report message is found for their address.
- Marks contacts **replied** (with a snippet of the reply) by matching `In-Reply-To`/`References` headers to the stored `messageId`, or subject-line heuristics as a fallback.

A **GitHub Actions cron** (`.github/workflows/check-mailbox.yml`) calls this endpoint every 5 minutes automatically. Requires `VERCEL_APP_URL` to be set as a GitHub secret.

---

## API reference

Full API documentation is in [architecture.md § API Surface](architecture.md#api-surface).

Key routes at a glance:

```
GET  /api/contacts          list contacts (tab, page, limit query params)
GET  /api/contacts/stats    { total, sent, bounced, replied, pending, remaining }
POST /api/contacts          bulk create
PATCH /api/contacts         bulk update

GET  /api/templates         list templates
POST /api/templates         create template
PATCH /api/templates/:key   update template
DELETE /api/templates/:key  delete template

GET  /api/settings          get settings (resume binary excluded)
PUT  /api/settings          update settings
POST /api/settings/resume   upload resume
GET  /api/settings/resume   download resume
DELETE /api/settings/resume remove resume

POST /api/jobs              create send job + trigger Inngest
GET  /api/jobs/active       active job (pending/processing/paused)
GET  /api/jobs/latest       most recent job
GET  /api/jobs/:id          get job
POST /api/jobs/:id/pause    pause job
POST /api/jobs/:id/resume   resume job
POST /api/jobs/:id/cancel   cancel job
POST /api/jobs/:id/retry-failed  reset failed contacts and return them for re-send

POST /api/config            store Gmail credentials in-memory
GET  /api/status            { configured, email, name }
POST /api/check-mailbox     IMAP scan for bounces + replies
```

---

## Deployment (Vercel)

`vercel.json` routes all traffic to `server.js` and bundles the static assets. Deploy with:

```bash
vercel --prod
```

Set all required environment variables in the Vercel dashboard (or via `vercel env add`). For the GitHub Actions cron, add `VERCEL_APP_URL` as a repository secret.
