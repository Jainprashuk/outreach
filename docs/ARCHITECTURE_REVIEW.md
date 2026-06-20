# Architecture Review — Goods & Bads

> An honest engineering assessment of the architectural choices in Outreach: what's done well, what's fragile, and what needs to change at scale.

---

## What the Architecture Gets Right

### 1. Inngest for Background Jobs — Excellent Fit
Using Inngest is the single best architectural decision in this codebase.

Vercel serverless functions have a 60-second timeout. A 400-email bulk send at 0.3s/email takes 120 seconds. Without Inngest, this would require a persistent server (defeating the Vercel model), a job queue like BullMQ + Redis, or running Node.js locally forever.

Inngest solves it cleanly:
- Steps are durable — they survive cold starts, instance evictions, and server restarts
- Each `step.run()` is a separate invocation (60s limit per step, not per job)
- Local dev server (`inngest-cli dev`) means zero cloud dependency during development
- Retry logic (2× on failure) is declarative — no manual retry state machine needed

The trade-off — Inngest adds an external service dependency — is the right call for this architecture.

---

### 2. Credential Snapshot Pattern on SendJob — Solves the Stateless Problem Correctly
The decision to snapshot `senderEmail`, `senderName`, `senderAppPassword` onto the SendJob document at creation time is architecturally sound.

**Why it matters:** Inngest functions run on arbitrary Vercel instances. If credentials are only in `mailer.js` module scope (in-memory), function invocations on cold instances have no access. By storing credentials in MongoDB (the only shared state across instances), every Inngest worker can access them independently, regardless of which Vercel instance picks up the event.

This is the correct solution to the "stateful work on stateless infrastructure" problem.

---

### 3. Atomic `findOneAndUpdate` with Positional `$` for Concurrent Workers
The SendJob item update pattern is correctly designed:
```js
SendJob.findOneAndUpdate(
  { _id: jobId, 'items.contactId': contactId },
  { $set: { 'items.$.status': 'sent', ... }, $inc: { processedCount: 1 } }
)
```

This is the right approach for concurrent workers. Each worker touches only its own item; `$inc` on processedCount is atomic. There's no read-modify-write race condition. This shows MongoDB expertise — the naive approach (`job.items[i].status = 'sent'; job.save()`) would cause data corruption under concurrency.

---

### 4. Serverless-Aware DB Connection Pattern
The shared-promise pattern for DB connections is exactly what serverless MongoDB best practices prescribe:
- Single `connect()` per warm instance (not per request)
- Shared promise prevents N parallel cold-start connections
- `bufferCommands: false` surfaces connectivity failures immediately
- Pool size of 5 is appropriate for serverless (doesn't exhaust Atlas free tier's connection limit)

Most serverless+MongoDB tutorials miss the shared-promise pattern. Getting it right here prevents both connection limit exhaustion and request timeouts.

---

### 5. Single Aggregation for Stats (vs Multiple countDocuments)
`GET /api/contacts/stats` uses one `$group` pipeline instead of 6 separate `countDocuments` calls. For a collection with thousands of contacts, this is the difference between 6 sequential round-trips (~120ms) and one query (~20ms). The aggregation also produces a consistent snapshot (all counts from the same scan), avoiding the race where a contact changes status between the second and third countDocuments call.

---

### 6. IMAP Scan with Pre-Loaded Maps
```js
const emailMap = new Map(contacts.map(c => [c.email, c]));
const msgIdMap = new Map(contacts.map(c => [c.messageId, c]));
```

Loading all contacts once into O(1) maps before scanning the inbox is the right approach. The alternative — querying the DB per email message — would be O(n × m) where n=messages, m=DB latency. With 50 messages in the inbox and 500 contacts in DB, that's 50 DB queries vs 1. At 5,000 messages in a 30-day window, the difference is massive.

---

### 7. Soft Deletes — Right Default for User Data
Using `deleted: true` flag instead of hard-delete prevents accidental data loss in a single-user tool where there's no confirmation dialog guarding the delete button. It also preserves audit trail — if a contact was sent to and then deleted, the sent count doesn't mysteriously decrease. The `{ deleted: { $ne: true } }` filter on all queries is lightweight with the existing index on `createdAt`.

---

### 8. Three Independent Send Modes — Separation of Concerns
Sequential, Bulk, and Drip are implemented as three distinct Inngest functions rather than one monolithic function with branching logic. Each mode has a clean interface: one trigger event, one responsibility. This makes each mode independently testable and debuggable. If Bulk has a bug, Sequential is unaffected.

---

## What the Architecture Gets Wrong

### 1. In-Memory State in a Stateless Environment
**Files:** `lib/mailer.js`, `server.js` (global variables)

```js
// mailer.js
let transporter = null;
let appPassword = null;
```

This is the fundamental mismatch in the architecture. Vercel spawns many instances. State stored in module scope (`mailer.transporter`, `mailer.appPassword`) is visible only to the instance that set it. Any other instance — including Inngest worker invocations — starts with null state.

The credential snapshot on SendJob partially solves this, but `POST /api/config` still stores the "verified transporter" in module scope. If the next request hits a different instance, there's no verified transporter, and the in-memory state cannot be recovered without the user re-POSTing credentials.

**Correct approach:** All shared state must live in MongoDB. `mailer.js` module scope should hold only the transport factory function, never a stateful transporter instance.

---

### 2. Static Assets Served Through Serverless Function (No CDN Layer)
**File:** `vercel.json`

All `*.html`, `css/**`, `js/**` files are bundled into the serverless function and served by Express. Every request for `style.css` cold-starts a Node.js instance, queries for nothing, reads a file from the bundle, and returns it. This is:
- 3–5× slower than Vercel's Edge CDN for static assets
- Wastes invocation time and compute budget
- Increases cold-start frequency (more invocations = more cold starts)

**Correct approach:** Move static files to a `public/` directory. Vercel automatically serves them from its Edge CDN with zero compute cost. Only API routes (`/api/*`) should route to the serverless function.

---

### 3. All Requests Route Through One Express App (No Route Isolation)
**File:** `vercel.json`

```json
{ "src": "/(.*)", "dest": "server.js" }
```

Every request — HTML pages, API calls, Inngest webhook, static files — hits the same Express function. This means:
- A spike in IMAP scan requests (if the cron misfires and runs 10×) starves API requests
- A long-running `/api/check-mailbox` (IMAP connect + scan can take 10–30s) blocks other requests on the same instance
- No independent scaling of different concerns

**Better approach (with Vercel):** Split into separate serverless functions: `api/[...route].js` for API, `api/inngest.js` for Inngest, and use Vercel's built-in static file serving. Each function scales independently.

---

### 4. No Request Validation Layer
**Files:** All route files

Routes do ad-hoc validation inline:
```js
if (!name || !email) return res.status(400).json({ error: 'Missing fields' });
```

There's no schema validation library (zod, joi, express-validator). This means:
- Validation rules are scattered across files
- Easy to forget a validation in one route but remember it in another
- Type coercion bugs (e.g., `chunkSize` arriving as string "20" instead of number 20)
- No canonical error response format — some routes return `{ error: 'msg' }`, others return different shapes

**Impact now:** Low (single user, no hostile inputs).  
**Impact at scale:** High (API becomes inconsistent, hard to test, injection-prone).

---

### 5. Frontend State Reloaded on Every Page Navigation
**File:** `js/app.js` → `init()`

Every page navigation calls `window._app.init()` which fires three parallel API requests (contacts, templates, settings). With 1,000 contacts, `GET /api/contacts` returns a full page of data plus a count query — 2 DB calls per page load.

Navigate through 10 pages in a session = 30 API calls, 20 DB queries. All for data that hasn't changed.

**Impact now:** Acceptable (personal tool, fast Atlas connection).  
**Impact at scale or on slow connections:** Sluggish navigation, unnecessary DB load.

**Better approach:** 
- Cache settings and templates in `sessionStorage` (they change rarely)
- Use `ETag` / `Last-Modified` headers on API responses for conditional GETs
- Only contacts need fresh data on every load (they change frequently)

---

### 6. No Error Boundary on the Frontend
**File:** `js/app.js`, all HTML pages

Every page wraps its setup in `(async () => { ... })()` with no `try-catch`. If `init()` throws (network error, DB down, malformed response), the page shows a blank screen with no error message. The user has no idea what happened.

```js
// What exists:
(async () => {
  await window._app.init();
  renderTable();
})();

// What should exist:
(async () => {
  try {
    await window._app.init();
    renderTable();
  } catch (err) {
    showErrorScreen('Failed to load. Check your connection.', err);
  }
})();
```

---

### 7. Schema Coupling: Contact Stores Template Key (Not Template Snapshot)
**File:** `models/Contact.js` → `template` field

The `template` field stores the template key (e.g., `'cold-email'`). But template content can change after assignment. If a user:
1. Assigns "cold-email" template to 100 contacts
2. Edits "cold-email" body
3. Approves on step2 (preview shows OLD body — wait, actually step2 re-renders live template... so it shows NEW body)
4. Sends — also uses NEW body

There's no timestamp or version pin. The contact doesn't know which version of the template it was approved against. The approval becomes forward-incompatible with any template edit.

**Impact:** Silent correctness issue. The email sent can differ from what was previewed and approved.

---

### 8. GitHub Actions Cron Has No Authentication on the Target Endpoint
**File:** `server.js`, `.github/workflows/check-mailbox.yml`

The cron calls `POST /api/check-mailbox` with no authentication. The endpoint:
- Opens an IMAP connection (time + resource cost)
- Updates `lastMailboxCheckAt` (can manipulate scan window)
- Is publicly reachable

Any external party who discovers the URL can trigger it. See EC-19 in edge cases for full impact.

---

### 9. Embedding Items in SendJob Has Document Size Risk
**File:** `models/SendJob.js` → `items: [...]`

`items` is an embedded array, not a reference. Each item contains: contactId, to, name, subject, body, status, messageId, error, processedAt. The `body` field can be 500–1,500 characters of email body.

For a 400-contact job: 400 items × ~1,000 chars body = ~400KB per document. MongoDB's 16MB limit isn't close, but at 1,000+ contacts, this becomes:
- Large document reads every time the widget polls job status (every 3s)
- Entire `items` array loaded even when only `processedCount` and `status` are needed

**Impact now:** Negligible at < 500 contacts.  
**Impact at scale:** Polling a 5MB document every 3 seconds = 100KB/s per active job session.

**Fix:** Separate `SendJobItem` collection with reference from SendJob. Poll status via an aggregation that counts items by status rather than loading all items.

---

### 10. No Health Check Endpoint
**File:** `server.js`

There's no `GET /api/health` endpoint that returns DB connectivity status, Inngest connection, last mailbox check time, etc. Debugging "why is nothing sending?" requires checking:
- Vercel function logs
- MongoDB Atlas metrics
- Inngest dashboard
- GitHub Actions cron logs

A health endpoint would surface all of these in one place and could be checked by external monitoring.

---

## Architecture Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Background job orchestration | 9/10 | Inngest is the right tool, well-used |
| DB design | 7/10 | Good indexes, good atomics; embedding items is a minor risk |
| Concurrency safety | 8/10 | Positional $ operator correctly used; some edge cases remain |
| Statelessness | 5/10 | In-memory state still present in mailer.js |
| API design | 7/10 | Mostly RESTful; some mutations in GETs |
| Frontend architecture | 6/10 | Vanilla JS is appropriate; no error boundaries; state re-fetched too often |
| Security | 5/10 | App password plaintext; no cron auth; CORS open |
| Observability | 3/10 | No health endpoint, no structured logs, no APM |
| Scalability | 4/10 | Single-user design; static assets through function; items embedded |
| Developer experience | 8/10 | Clear structure, local Inngest dev, good .env.example |

**Overall: 6.2/10** — Solid for a personal tool. Needs focused work on statelessness, security, and observability before any multi-user use.
