# Outreach — Architecture

## Overview

Outreach is a personal cold-email campaign tool. It manages a pipeline from contact import through personalised email sending, then tracks bounces and replies.

```
Browser (multi-page SPA)
        │
        ▼  REST API
Express.js (server.js)  ──────────────────► MongoDB Atlas
        │                                   (contacts, templates,
        │  event trigger                     settings, send jobs)
        ▼
    Inngest Cloud  ──► sendEmailBatch (orchestrator)
                   └──► sendSingleEmail × N  (worker)
                               │
                               ▼  SMTP
                          Gmail (nodemailer)
                               │
                               ▼  IMAP
                    Gmail Inbox (bounce + reply scan)
                               │
                    GitHub Actions cron (every 5 min)
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (Express.js) |
| Database | MongoDB Atlas via Mongoose |
| Background jobs | Inngest (event-driven, rate-limited) |
| Email sending | Nodemailer + Gmail SMTP |
| Inbox polling | ImapFlow + mailparser |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Hosting | Vercel (serverless) |
| Scheduled trigger | GitHub Actions cron |

---

## Directory Structure

```
outreach/
├── server.js            # Express entry point + IMAP check-mailbox + legacy /send
├── inngest.js           # Inngest client singleton
├── inngest-fns.js       # Inngest functions: sendEmailBatch, sendSingleEmail
├── db.js                # Mongoose connect + DB seed (default templates + settings)
├── lib/
│   └── mailer.js        # Nodemailer transporter factory (App Password)
├── models/
│   ├── Contact.js       # Contact schema
│   ├── SendJob.js       # Send job + items schema
│   ├── Settings.js      # Singleton settings schema (resume stored as Buffer)
│   └── Template.js      # Email template schema
├── routes/
│   ├── contacts.js      # /api/contacts CRUD + stats
│   ├── jobs.js          # /api/jobs CRUD + pause/resume/cancel/retry-failed
│   ├── settings.js      # /api/settings CRUD + resume upload/download/delete
│   └── templates.js     # /api/templates CRUD
├── js/
│   └── app.js           # Shared frontend module (window._app)
├── css/
│   └── style.css        # All styles (CSS variables, dark/light theme)
├── index.html           # Dashboard
├── step1.html           # Add contacts (CSV / manual)
├── step2.html           # Approve / edit personalised emails
├── step3.html           # Enter credentials + trigger send
├── done.html            # Completion screen
├── contacts.html        # Searchable contact list
├── templates.html       # Template management
├── settings.html        # Sender settings + custom variables + resume
├── vercel.json          # Vercel build config (routes → server.js)
└── .github/
    └── workflows/
        └── check-mailbox.yml  # GitHub Actions cron (every 5 min)
```

---

## Data Models

### Contact
```
name, email, company, role, template (key)
status:         queued | sent | failed | bounced | replied
approvalStatus: pending | approved | rejected
editedSubject, editedBody      — per-contact overrides
messageId                      — Gmail Message-ID header (for reply matching)
sentSubject                    — subject used when sent
bounceReason                   — SMTP diagnostic string
repliedAt, replySnippet        — populated by IMAP scan
replyRead                      — frontend-controlled read flag
```
Indexes: `createdAt`, `status+createdAt`, `approvalStatus`, `email`, `messageId`

### SendJob
```
status:    pending | processing | paused | done | cancelled
items[]:   { contactId, to, name, subject, body, status, messageId, error, processedAt }
attachResume, processedCount
senderEmail, senderName, senderAppPassword  — stored per-job (multi-instance safe)
```

### Settings (singleton)
```
senderName, senderCompany, gmailEmail
customVariables: [{ key, value }]
resume: { filename, contentType, data (Buffer), size, uploadedAt }
lastMailboxCheckAt
```
Resume binary is excluded from most queries (`{ 'resume.data': 0 }`) to avoid loading multi-MB blob unnecessarily.

### Template
```
key (unique slug, auto-derived from name)
name, subject, body
```
Three defaults seeded at startup: `intro-v2`, `follow-up`, `cold`.

---

## API Surface

### Contacts
| Method | Path | Description |
|---|---|---|
| GET | `/api/contacts` | List (tab filter: all/sent/bounced/replied/remaining/pending; optional pagination) |
| GET | `/api/contacts/stats` | Single aggregation: total, sent, bounced, replied, pending, remaining |
| POST | `/api/contacts` | Bulk create (array of contact objects) |
| PATCH | `/api/contacts` | Bulk update (array of `{id, ...fields}`) — uses `bulkWrite` |
| PATCH | `/api/contacts/:id` | Update single contact |

### Templates
| Method | Path | Description |
|---|---|---|
| GET | `/api/templates` | List all |
| POST | `/api/templates` | Create (key auto-slugified from name) |
| PATCH | `/api/templates/:key` | Update name/subject/body |
| DELETE | `/api/templates/:key` | Delete |

### Settings
| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get (resume binary excluded) |
| PUT | `/api/settings` | Update senderName, senderCompany, gmailEmail, customVariables |
| POST | `/api/settings/resume` | Upload resume (multipart, PDF/Word ≤ 5 MB) |
| GET | `/api/settings/resume` | Download resume binary |
| DELETE | `/api/settings/resume` | Remove resume |

### Jobs
| Method | Path | Description |
|---|---|---|
| POST | `/api/jobs` | Create job + fire `email/batch.start` Inngest event |
| GET | `/api/jobs/active` | Latest job in pending/processing/paused state |
| GET | `/api/jobs/latest` | Most recent job (any status) |
| GET | `/api/jobs/:id` | Get job by ID |
| POST | `/api/jobs/:id/pause` | Set status → paused |
| POST | `/api/jobs/:id/resume` | Set status → processing + fan-out pending items |
| POST | `/api/jobs/:id/cancel` | Set status → cancelled |
| POST | `/api/jobs/:id/retry-failed` | Reset failed contacts to queued+approved; returns contact list for step3 |

### Misc
| Method | Path | Description |
|---|---|---|
| POST | `/api/config` | Store Gmail credentials in memory (mailer module) |
| GET | `/api/status` | Current sender config (email, name, configured flag) |
| POST | `/api/send` | Send single email (legacy, kept for step3 fallback) |
| POST | `/api/check-mailbox` | IMAP scan for bounces + replies |
| ANY | `/api/inngest` | Inngest event handler (served by `inngest/express`) |

---

## Send Pipeline

```
step3.html
  └─ POST /api/jobs   { items, senderEmail, senderName, senderAppPassword, attachResume }
          │
          ├── Creates SendJob in MongoDB (status: pending)
          └── inngest.send('email/batch.start', { jobId })

                    ┌──────────────────────────────────────────┐
                    │  sendEmailBatch (Inngest orchestrator)    │
                    │  trigger: email/batch.start               │
                    │                                           │
                    │  1. Load pending items from SendJob       │
                    │  2. Set job.status = 'processing'         │
                    │  3. fan-out: sendEvent(email/single.send) │
                    │     with ts: Date.now() + i * 1500ms      │
                    └──────────────────────────────────────────┘
                               │ × N events
                               ▼
                    ┌──────────────────────────────────────────┐
                    │  sendSingleEmail (Inngest worker)         │
                    │  trigger: email/single.send              │
                    │  retries: 2                               │
                    │                                           │
                    │  1. Load SendJob + find item              │
                    │  2. Build App Password transporter        │
                    │     (senderAppPassword from job doc)      │
                    │  3. sendMail via nodemailer                │
                    │  4. Update Contact (status, messageId)    │
                    │  5. Update job item + processedCount      │
                    │  6. If all done → job.status = 'done'     │
                    └──────────────────────────────────────────┘
```

**Rate limiting:** Inngest events are time-stamped 1.5 s apart (`ts: Date.now() + i * 1500`) to avoid Gmail throttling.

**Credentials:** Gmail credentials are stored directly on the `SendJob` document (`senderEmail`, `senderAppPassword`). This solves the Vercel multi-instance problem where different serverless instances handle job creation vs. job execution — the worker always has credentials from the DB, not in-memory state.

---

## Bounce & Reply Detection

Triggered by `POST /api/check-mailbox`, called by a GitHub Actions cron every 5 minutes.

```
IMAP connect to imap.gmail.com:993
    │
    ├── INBOX + [Gmail]/Spam
    │
    ├── Search since lastMailboxCheckAt (with 5-min buffer):
    │   bounce candidates: multipart/report, from mailer-daemon, from postmaster
    │   reply candidates:  all messages since replySince (30-day lookback)
    │
    ├── For each UID — fetchOne + parse raw
    │
    ├── Bounce path:
    │   parseBounces() extracts Final-Recipient + Diagnostic-Code
    │   → update Contact.status = 'bounced', Contact.bounceReason
    │
    └── Reply path:
        tryMatchReply() matches In-Reply-To / References → messageId map
        Fallback: subject starts with Re: → match by email
        → update Contact.status = 'replied', repliedAt, replySnippet
```

**Performance:** All contacts are pre-loaded once (`Contact.find().lean()`) into `Map` structures keyed by email and messageId. The scan loop does O(1) lookups — no per-message DB queries.

---

## Frontend Architecture

All pages share a single `js/app.js` module exposed as `window._app`. Each page script initialises state by calling `App.init()`, which in parallel fetches contacts, templates, and settings.

**Shared `window._app` API:**
- `init()` — load contacts + templates + settings
- `renderTemplate(key, contact)` — interpolate `{{variables}}` into subject/body
- `createContacts(rows)`, `updateContact(id, patch)`, `bulkUpdateContacts(updates)`
- `checkMailbox()`, `saveSettings(patch)`, `uploadResume(file)`, `deleteResume()`
- `createTemplate(data)`, `updateTemplate(key, patch)`, `deleteTemplate(key)`
- `toast(msg, type)`, `btnLoad(btn, label)`, `initTheme()`, `initMobileNav()`

**Send-job widget (`_sjw*`):** A floating DOM overlay injected into any page (except step3). It polls `GET /api/jobs/:id` every 3 seconds, shows progress bar and pause/resume controls, and persists `activeJobId` in `localStorage` to survive page navigation.

**Template variable system:**
- Built-in: `{{name}}`, `{{company}}`, `{{role}}`, `{{sender}}`, `{{senderCompany}}`
- Custom: any `{{key}}` defined in Settings → Custom variables

---

## Database Connection (Vercel serverless)

```js
let _dbConnecting = null;   // shared promise across concurrent cold-start requests

const ensureDb = async () => {
  if (mongoose.connection.readyState === 1) return;   // warm — reuse
  if (!_dbConnecting) {
    _dbConnecting = db.connect().catch(err => {
      _dbConnecting = null;   // reset so next request retries
      throw err;
    });
  }
  await _dbConnecting;
};
```

This pattern prevents N simultaneous `mongoose.connect()` calls on a cold Vercel instance. MongoDB pool size is capped at 5 to respect Atlas free-tier connection limits.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI_DEV` | Yes (dev) | MongoDB Atlas connection string for development |
| `MONGODB_URI_PROD` | Yes (prod) | MongoDB Atlas connection string for production |
| `NODE_ENV` | No | Set to `prod` to use `MONGODB_URI_PROD` |
| `GMAIL_EMAIL` | No | Pre-configure sender email at startup |
| `GMAIL_APP_PASSWORD` | No | Pre-configure App Password at startup |
| `SENDER_NAME` | No | Default sender name (default: Prashuk Jain) |
| `INNGEST_EVENT_KEY` | Yes (prod) | Inngest event signing key |
| `INNGEST_SIGNING_KEY` | Yes (prod) | Inngest webhook signing key |
| `PORT` | No | HTTP port (default: 3000) |

---

## Deployment

### Vercel
`vercel.json` routes all requests to `server.js` via `@vercel/node`. Static assets (HTML, CSS, JS, CSV) are bundled via `includeFiles`. Max function duration is 60 s.

### Local dev
```bash
npm start                          # starts Express on :3000
npx inngest-cli@latest dev         # local Inngest dev server (separate terminal)
```
Inngest dev server proxies events locally so background functions run without cloud connectivity.

### GitHub Actions (mailbox cron)
`.github/workflows/check-mailbox.yml` POSTs to `VERCEL_APP_URL/api/check-mailbox` every 5 minutes. The cron can also be triggered manually via `workflow_dispatch`.
