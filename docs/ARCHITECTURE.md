# Architecture — Frontend & Backend

> Technical deep-dive into how Outreach is structured, how data flows, and why each architectural decision was made.

---

## System Overview

```
Browser (Vanilla HTML/JS)
        │ HTTP (REST)
        ▼
Express.js on Vercel (Serverless Node.js)
        │                        │
        ▼                        ▼
MongoDB Atlas              Inngest Cloud
(Mongoose ODM)        (Event-driven background jobs)
                               │
                     Nodemailer (Gmail SMTP)
                               │
                         ImapFlow (IMAP)

GitHub Actions (cron every 5 min)
        │ POST /api/check-mailbox
        ▼
Express.js → ImapFlow → MongoDB
```

---

## Backend Architecture

### Runtime & Deployment

| Property | Value |
|----------|-------|
| Runtime | Node.js 18 (Vercel) |
| Framework | Express 4 |
| Deployment | Vercel Serverless Functions |
| Max duration | 60 seconds per function invocation |
| Hosting model | Single Express server (`server.js`) — all requests route here |

**Vercel treats Express as one serverless function.** Every request cold-starts a new Node.js instance if none are warm. The codebase handles this via a DB connection pattern designed for cold starts (see below).

---

### File Layout

```
server.js           — Express app, route mounts, static serving, legacy /send, /check-mailbox
inngest.js          — Inngest client singleton (used across server + inngest-fns)
inngest-fns.js      — All four Inngest function definitions
db.js               — Mongoose connect + seed on first connect
lib/
  mailer.js         — Nodemailer transporter factory + resume binary fetcher
models/
  Contact.js        — Contact lifecycle + approval + reply/bounce metadata
  SendJob.js        — Job state + embedded items array + credential snapshot
  Settings.js       — Singleton: sender identity + resume + custom vars
  Template.js       — Email templates with slugified keys
routes/
  contacts.js
  jobs.js
  settings.js
  templates.js
```

---

### Data Models

#### Contact
```
_id, name, email, company, role, template (key)
status: queued | sent | failed | bounced | replied | unsubscribed
approvalStatus: pending | approved | rejected
editedSubject, editedBody       — per-contact overrides
messageId                       — SMTP Message-ID for reply matching
lastSentAt                      — cooldown check (prevent re-send within 2h)
bounceReason, repliedAt, replySnippet, replyRead
deleted                         — soft-delete flag
createdAt (indexed)
Compound index: { status, createdAt }
Single indexes: approvalStatus, email, messageId
```

#### SendJob
```
_id, status: pending | processing | paused | done | cancelled
sendMode: sequential | bulk | drip
chunkSize (bulk), ratePerHour (drip)
senderEmail, senderName, senderAppPassword   — credential snapshot at job creation
items: [{
  contactId, to, name, subject, body
  status: queued | sent | failed
  messageId, error, processedAt
}]                                           — embedded, NOT referenced
processedCount                               — atomic-increment counter
createdAt (indexed)
```

**Why embedded items instead of references?**  
Avoids a join query per job status poll. The widget polls every 3 seconds — with referenced items, that's a populate() call loading N contacts per poll. With embedded items, one `findById()` returns everything. Trade-off: jobs with 500+ contacts have large documents, but MongoDB handles 16 MB max document size comfortably at this scale.

#### Settings (Singleton)
```
senderName, senderCompany, gmailEmail
customVariables: [{ name, description }]
resume: { filename, contentType, data (Buffer), size, uploadedAt }
lastMailboxCheckAt
```

One document, always fetched with `{ 'resume.data': 0 }` projection (excludes binary).

#### Template
```
key (unique slug, auto-derived), name, subject, body
createdAt
```

---

### Database Connection (Serverless Pattern)

```js
let _dbConnecting = null;

const ensureDb = async () => {
  if (mongoose.connection.readyState === 1) return;  // warm instance
  if (!_dbConnecting) {
    _dbConnecting = db.connect().catch(err => {
      _dbConnecting = null;  // reset on failure
      throw err;
    });
  }
  await _dbConnecting;  // concurrent cold starts share one promise
};
```

**Why this matters:** Vercel can spawn multiple function instances for concurrent requests. Without the shared-promise pattern, two simultaneous cold starts would both call `mongoose.connect()`, creating two connection pools and wasting Atlas connection slots. This pattern ensures only one `connect()` call happens per instance even under concurrent load.

**Connection pool:** `maxPoolSize: 5` — appropriate for serverless where many function instances each hold a small pool, vs a long-lived server that would use a larger single pool.

**`bufferCommands: false`:** Fails immediately if DB is not connected (instead of queuing operations silently). Surfaces connectivity issues as 500s, which are easier to debug than timeout-after-10s.

---

### API Design

All routes follow REST conventions with a few pragmatic additions:

**Contacts**
- `GET /api/contacts?tab=X&page=N&search=X&status=X&approvalStatus=X&template=X` — filtered, paginated
- `GET /api/contacts/stats` — aggregation pipeline (one query, not six countDocuments)
- `POST /api/contacts` — bulk insert array
- `PATCH /api/contacts` — bulk update via bulkWrite (one roundtrip for N updates)
- `PATCH /api/contacts/:id` — single contact update
- `DELETE /api/contacts/:id` — soft delete (sets `deleted: true`)
- `POST /api/contacts/retry-failed` — reset all failed to queued+approved
- `POST /api/contacts/reset-for-send` — reset selected IDs for re-send

**Jobs**
- `GET /api/jobs/active` — returns first job in pending/processing/paused; auto-cancels 24h+ stale jobs
- `POST /api/jobs/:id/repair` — fix stuck jobs (status=processing, all items done)
- Other CRUD + state transitions (`/pause`, `/resume`, `/cancel`, `/retry-failed`)

**Non-REST affordances (justifiable):**
- `POST /api/config` — credential storage (no resource, it's an action)
- `POST /api/check-mailbox` — trigger action (idempotent-ish due to deduplication)
- `POST /api/send` — legacy single-send (used as fallback)

---

### Send Pipeline — Data Flow

```
POST /api/jobs
  ├─ validate: approved contacts exist
  ├─ snapshot credentials (senderEmail, senderName, senderAppPassword) → SendJob
  ├─ build items[] from approved contacts (subject/body rendered from template + overrides)
  └─ send Inngest event:
       sequential → email/batch.start
       bulk       → email/bulk.start
       drip       → email/drip.start

Inngest Cloud receives event:
  [sequential] sendEmailBatch:
    - load pending items from DB
    - fan-out N × email/single.send events (1.5s stagger)
    - return immediately

  [sequential worker] sendSingleEmail:
    - load contact + job
    - cooldown check (skip if sent < 2h ago)
    - build transporter from job credentials
    - sendMail()
    - update Contact: status, messageId, lastSentAt
    - update SendJob.items[x]: atomic findOneAndUpdate with positional $
    - $inc processedCount
    - check if all items done → set job.status = 'done'
    - Inngest retries: 2

  [bulk] sendEmailBulk:
    - load all pending items
    - set job.status = 'processing'
    - chunk items into groups of chunkSize
    - for each chunk:
        - open pooled SMTP transporter
        - for each item in chunk:
            - cooldown check
            - sendMail()
            - update Contact + SendJob item atomically
            - $inc processedCount
        - close transporter
        - check pause/cancel flag (abort if set)
    - set job.status = 'done'

  [drip] sendEmailDrip:
    - load pending items
    - calculate delay = 3600000ms / ratePerHour
    - fan-out N × email/single.send events (delay[i] = i × intervalMs)
    - return immediately
    - reuses sendSingleEmail worker
```

---

### Atomic Job Item Updates (Race Condition Prevention)

```js
SendJob.findOneAndUpdate(
  { _id: jobId, 'items.contactId': contactId },
  {
    $set: {
      'items.$.status': 'sent',
      'items.$.messageId': msgId,
      'items.$.processedAt': new Date()
    },
    $inc: { processedCount: 1 }
  }
)
```

The **positional `$` operator** matches the specific array element where `contactId` matches. This is critical in sequential and drip modes where multiple Inngest workers run concurrently — each worker touches only its own item, not the full `items` array. Without this, a naive `job.save()` after modifying `job.items[i]` would race with another worker's `job.save()`, causing one update to overwrite the other's changes.

---

### Bounce & Reply Detection

```
GitHub Actions cron (*/5 * * * *)
  │ POST https://{app}/api/check-mailbox
  ▼
server.js /api/check-mailbox
  │
  ├─ load Settings.lastMailboxCheckAt
  ├─ connect ImapFlow → imap.gmail.com:993
  ├─ pre-load ALL contacts into Maps:
  │    emailMap: email → contact
  │    msgIdMap: messageId → contact
  │
  ├─ BOUNCE SCAN (multipart/report, mailer-daemon, postmaster)
  │    since: max(lastMailboxCheckAt - 5min buffer, 7 days ago)
  │    for each message:
  │      extract Final-Recipient email
  │      extract Diagnostic-Code reason
  │      lookup emailMap → update Contact{status:'bounced', bounceReason}
  │
  ├─ REPLY SCAN (all messages)
  │    since: max(lastMailboxCheckAt - 5min buffer, 30 days ago)
  │    for each message:
  │      simpleParser() → inReplyTo, references, from, text
  │      if inReplyTo in msgIdMap → match contact
  │      else if references overlap with sent messageIds → match
  │      else subject heuristic ("Re:", "Auto-reply")
  │      extract snippet (first 400 chars, stop at reply delimiter)
  │      update Contact{status:'replied', repliedAt, replySnippet}
  │
  └─ update Settings.lastMailboxCheckAt = now
```

**Performance:** All contacts loaded once into Maps before scanning. No per-message DB query. O(messages) complexity, not O(messages × contacts).

---

### Credential Storage (Stateful Problem in Stateless Infrastructure)

This is the trickiest architectural tension in the app:

**The problem:** Vercel is stateless. In-memory state (like `mailer.transporter`) is lost between cold starts. Bulk sends are long-running. If the Inngest function picks up on a different (cold) Vercel instance, the transporter is gone.

**The solution (as built):** At `POST /api/jobs`, the job is created with a credential snapshot: `{ senderEmail, senderName, senderAppPassword }` stored on the SendJob document in MongoDB. Inngest functions read credentials from the job document, not from in-memory state. This means:

1. Inngest functions are fully self-contained — they load credentials from DB, not from a specific Vercel instance
2. The in-memory `mailer.transporter` is only a warm-instance optimisation (verified config path), not load-bearing
3. Job credentials survive server restarts, cold starts, and multi-instance deployments

**Remaining gap:** `POST /api/config` still stores the configured transporter in `mailer.js` module scope. This works if the same Vercel instance handles the next request, but fails across instances. The fix is to always fall back to `job.senderAppPassword` (already implemented) and treat in-memory state as a cache, not source of truth.

---

## Frontend Architecture

### Technology Choice: Vanilla JS

No React, no Vue, no Svelte. All pages are plain HTML + one shared JS file (`js/app.js`) exposed as `window._app`.

**Why this works here:**
- Single user, simple data flows, no concurrent state changes between views
- Pages are largely independent (each page initialises its own state from API calls)
- No build step = instant development, zero dependency churn
- Total JS bundle: ~470 lines (app.js) + inline page scripts. Sub-50KB.

**Where it shows strain:**
- No reactivity framework means manual DOM updates everywhere: `document.getElementById('x').innerHTML = ...`
- No component model means copy-paste for similar patterns (e.g., 3 pages have their own pagination implementation)
- State is lost on page navigation (no shared memory between pages — each page re-fetches from API)

---

### Shared Module: `window._app`

All pages load `js/app.js` which sets `window._app`. Every HTML page's inline script calls `await window._app.init()` to get state.

```
window._app.state = {
  contacts: Contact[],
  templates: { [key]: Template },
  sender: { name, company, email, customVariables, resume, lastMailboxCheckAt }
}
```

**What `init()` does:**
1. Parallel fetch: `GET /api/contacts`, `GET /api/templates`, `GET /api/settings`
2. Populate `state.*`
3. Call `initTheme()`, `initMobileNav()`
4. Set up `window._app.sjw` (send-job widget) if active job exists

**API methods exposed:** createContacts, updateContact, bulkUpdateContacts, deleteContact, createTemplate, updateTemplate, deleteTemplate, saveSettings, uploadResume, deleteResume, renderTemplate, allVariables, toast, btnLoad, avatarEl, statusBadge, checkMailbox, initSendJobWidget, etc.

---

### Page Architecture (Per Page)

Each HTML page follows this pattern:
```html
<script>
  (async () => {
    await window._app.init();
    // page-specific setup using window._app.state
    renderTable();
    setupEventListeners();
  })();
</script>
```

Pages are intentionally isolated — no cross-page state sharing via localStorage or cookies (except theme preference). This avoids subtle stale-data bugs but means every navigation pays a round-trip cost.

---

### Template Variable Rendering (Frontend)

```js
renderTemplate(tplKey, contact) {
  const tpl = state.templates[tplKey];
  const vars = {
    name: contact.name,
    company: contact.company,
    role: contact.role,
    sender: state.sender.name,
    senderCompany: state.sender.company,
    // custom variables (empty string if undefined)
  };
  return {
    subject: tpl.subject.replace(/\{\{(\w+)\}\}/g, k => vars[k] ?? ''),
    body:    tpl.body.replace(   /\{\{(\w+)\}\}/g, k => vars[k] ?? '')
  };
}
```

Rendering happens twice:
1. **Frontend (step2.html)** — for preview only; result NOT sent to server
2. **Backend (POST /api/jobs)** — server re-renders template with contact data and stores final subject/body on each SendJob item

This means what you see in step2 preview is not exactly what gets sent — the server renders independently. If custom variable values differ between client and server state, the sent email could differ from the preview. Currently not a problem because custom vars have no per-contact values, but worth noting for future.

---

### Send-Job Widget

The widget (`_sjw` functions in app.js) is a floating overlay injected into the DOM on every page load (except step3). It operates on its own 3-second poll interval.

```
init: GET /api/jobs/active
  ├─ no active job → noop
  └─ active job → inject widget DOM + start polling

poll (every 3s): GET /api/jobs/:id
  ├─ update progress bar + counters
  ├─ if job.status === 'done':
  │    show "Complete" state
  │    schedule auto-dismiss (8s)
  ├─ if allItemsDone && job.status === 'processing':
  │    POST /api/jobs/:id/repair (stuck job fix)
  └─ if status === 'cancelled' | 'done':
       stop polling
```

Widget actions:
- Pause/Resume → `POST /api/jobs/:id/pause` or `/resume`
- Close (X) → `POST /api/jobs/:id/cancel` + dismiss
- Collapse → CSS toggle (still polls in background)

---

### Theme System

```css
:root { --bg: #fff; --text: #1a1a1a; ... }
[data-theme="dark"] { --bg: #0f0f0f; --text: #e5e5e5; ... }
```

`initTheme()` reads `localStorage('outreach-theme')` and sets `document.documentElement.dataset.theme`. All components use CSS variables — no JS needed to re-render on theme switch.

---

### CSS Architecture

Single file: `css/style.css` (~720 lines).

```
:root variables (light theme)
[data-theme="dark"] overrides
Base reset + typography
Layout: sidebar + main
Component: stat cards, tables, badges, buttons, modals, toasts, widget
Page-specific: charts, file upload zones, step indicators
Responsive breakpoints: 900px, 700px, 480px
```

No CSS framework (no Tailwind, no Bootstrap). Custom variables + utility classes. Consistent spacing scale using `--spacing-*` variables.

**Trade-off:** Fast to load, easy to customise. Harder to maintain as pages grow — no component isolation, global scope means one `.btn` change affects all buttons everywhere.

---

### Responsive Design

| Breakpoint | Layout Change |
|-----------|---------------|
| < 900px | Stat cards go 2-column |
| < 700px | Sidebar hides → hamburger toggle, sidebar becomes fixed overlay |
| < 480px | Stat cards go 1-column, table horizontal scroll |

---

## Infrastructure

### Inngest (Background Jobs)

Inngest is the architectural backbone for sending. Key properties:
- **Durable execution:** Inngest steps survive server restarts. If Vercel cold-starts a new instance mid-job, Inngest replays from the last checkpoint.
- **No long-running function:** Vercel caps at 60s per invocation. Inngest breaks jobs into steps; each step is a separate invocation.
- **Retry with backoff:** sendSingleEmail retries 2× on failure.
- **Local dev server:** `inngest-cli dev` runs locally; no cloud signup needed for development.

**Event flow:**
```
app → POST /api/inngest (serve endpoint) → Inngest Cloud
Inngest Cloud → POST /api/inngest (function trigger) → app
```

Both directions use the same `/api/inngest` endpoint, which is how Inngest's serve middleware works.

---

### Vercel Configuration

```json
{
  "builds": [{
    "src": "server.js",
    "use": "@vercel/node",
    "config": {
      "maxDuration": 60,
      "includeFiles": ["*.html", "css/**", "js/**", "sample-contacts.csv"]
    }
  }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

All static files (HTML, CSS, JS) are bundled inside the serverless function and served by Express. There's no CDN layer — every asset request hits the function. For a personal tool with one user, this is fine. For any meaningful traffic, these should be on Vercel's CDN (via `public/` directory routing).

---

### GitHub Actions Cron

```yaml
name: Check Mailbox
on:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: curl -X POST ${{ secrets.VERCEL_APP_URL }}/api/check-mailbox
```

Simple and reliable for a personal tool. GitHub Actions provides reliable cron with no additional infrastructure. The 5-minute interval is the minimum GitHub allows.

**Dependency:** `VERCEL_APP_URL` secret must be set in the repo. If it's not set, the cron silently does nothing (curl with empty URL fails silently).

---

## Environment Variables Reference

| Variable | Where Used | Required |
|----------|-----------|----------|
| `MONGODB_URI_DEV` | db.js | Yes (dev) |
| `MONGODB_URI_PROD` | db.js | Yes (prod) |
| `NODE_ENV` | db.js (selects URI) | No (defaults to dev) |
| `GMAIL_EMAIL` | mailer.js, server.js | No (pre-config) |
| `GMAIL_APP_PASSWORD` | mailer.js, server.js | No (pre-config) |
| `SENDER_NAME` | server.js | No |
| `INNGEST_EVENT_KEY` | inngest.js | Yes (prod) |
| `INNGEST_SIGNING_KEY` | inngest-fns.js | Yes (prod) |
| `GEMINI_API_KEY` | (unused) | No |
| `PORT` | server.js | No (3000) |
