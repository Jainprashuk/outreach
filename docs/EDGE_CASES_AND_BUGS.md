# Edge Cases & Probable Bugs

> Findings from a thorough code review — each item includes the exact failure scenario, where in the code the issue lives, and a suggested fix. Severity rated: Critical / High / Medium / Low.

---

## Critical

### EC-1: App Password Stored Plaintext in MongoDB
**File:** `models/SendJob.js` — field `senderAppPassword`  
**Scenario:** MongoDB Atlas connection string leaks (misconfig, breach, compromised team member). Every job document exposes the Gmail App Password in plaintext.  
**Impact:** Full Gmail account access for every credential stored.  
**Fix:** Encrypt `senderAppPassword` at rest using `crypto.createCipheriv` before storing; decrypt in Inngest functions before use. Alternatively, store a short-lived token reference and rotate after each job.  
**Note:** This is acceptable risk for a solo personal tool, but critical if shared or if Atlas is multi-tenant.

---

### EC-2: Sequential Mode Fails Silently on > ~20 Contacts
**File:** `inngest-fns.js` → `sendEmailBatch`  
**Scenario:** User picks Sequential mode and imports 100 contacts. The function fans out 100 `email/single.send` events at 1.5s intervals = 100 separate `nodemailer.createTransport()` + SMTP AUTH calls within ~2.5 minutes. Gmail rate-limits SMTP AUTH at ~20–30 within a short window → subsequent AUTH calls return `535 5.7.8 Username and Password not accepted`.  
**Impact:** 80+ contacts silently fail with `authentication failed` error. User sees failed status but may not understand why.  
**Fix (UI):** Show a warning on step3 when mode=sequential and approvedCount > 20: "Sequential mode is not recommended for > 20 emails — switch to Bulk."  
**Fix (backend):** In `sendEmailBatch`, check item count; if > 20, automatically switch to bulk behavior or reject the event with a clear message stored on the job.

---

### EC-3: `GET /api/jobs/active` Auto-Cancel Logic is Side-Effect in a GET
**File:** `routes/jobs.js`  
**Scenario:** The widget calls `GET /api/jobs/active` every 3 seconds. Inside that route, there's auto-cancel logic that terminates jobs stuck for 24+ hours. GET requests should not have side effects (REST principle).  
**Impact (correctness):** If a job is at exactly 24h and two requests arrive simultaneously, both read the same job and both try to cancel it. `findByIdAndUpdate` is atomic, so the double-cancel itself is safe — but the response to the first caller gets `job.status='cancelled'` while the second also sees it, causing two "job cancelled" toasts to fire.  
**Impact (unexpected):** A paused job at 24.5h will be auto-cancelled the next time any page loads. User may not expect a paused job to be cancelled while they're away.  
**Fix:** Move the auto-cancel to a dedicated scheduled Inngest function that runs hourly, or at minimum to a `POST /api/jobs/cleanup` endpoint. Make GET truly read-only.

---

## High

### EC-4: Reply Detection False Negative — `inReplyTo` vs Stored `messageId` Format Mismatch
**File:** `server.js` → `/api/check-mailbox`  
**Scenario:** SMTP sends an email; nodemailer returns `messageId` like `<abc123@gmail.com>`. This is stored on Contact. When a reply comes in, `mail.inReplyTo` contains the same `<abc123@gmail.com>`. The map lookup `msgIdMap.get(mail.inReplyTo)` works only if the format matches exactly.  
**Problem:** Some email clients strip or add angle brackets inconsistently. If stored `messageId` is `abc123@gmail.com` (no brackets) but inReplyTo is `<abc123@gmail.com>`, the Map lookup misses.  
**Impact:** Reply not detected; contact stays in "sent" status despite having replied.  
**Fix:** Normalise both the stored messageId and the lookup key: `strip both of angle brackets before storage and before lookup`.

---

### EC-5: Bulk Mode — Pause Check Only at Chunk Boundary
**File:** `inngest-fns.js` → `sendEmailBulk`  
**Scenario:** User sets `chunkSize: 100` and sends to 200 contacts. Pause check only fires between chunk 1 and chunk 2. If the user clicks Pause during chunk 1 (100 emails in progress), those 100 emails all send before the pause takes effect.  
**Impact:** User clicks Pause expecting it to stop immediately; instead the next 50–100 emails still go out.  
**Fix:** Reduce default chunk size to 20 (already done) and add an in-chunk check: after each `sendMail()`, re-fetch `job.status` from DB. This adds N DB reads per job but respects pause intent.  
**Alternative:** Move pause check to after each individual send (not each chunk). This is 1 DB read per email but ensures near-immediate response to pause.

---

### EC-6: Job Items Built at Send Time, Not at Approval Time — Template Drift
**File:** `routes/jobs.js` → `POST /api/jobs`  
**Scenario:**  
1. User approves contacts on step2 (no edits made — approves base template)
2. User goes to templates.html and changes the template body
3. User clicks "Send" on step3  
4. `POST /api/jobs` renders the template NOW (at send time) — picking up the NEW template body

**Impact:** The email sent differs from the approved preview. The approval step becomes meaningless if templates can change between approval and send.  
**Fix (correct):** Capture final rendered `subject` and `body` on the Contact at approval time (`PATCH /api/contacts` with `approvalStatus: 'approved'`). At send time, use those snapshots — never re-render.  
**Current partial mitigation:** Per-contact `editedSubject`/`editedBody` overrides are respected; but contacts approved without edits are re-rendered from the live template at send time.

---

### EC-7: `sendSingleEmail` — Credentials Fallback to In-Memory State Across Vercel Instances
**File:** `inngest-fns.js` → `sendSingleEmail`  
**Scenario:**  
1. User POSTs credentials to `POST /api/config` on Vercel instance A → mailer.js state updated on A
2. User creates job → job snapshot stores credentials (good)
3. Inngest triggers `sendSingleEmail` on Vercel instance B (cold start, mailer.js state empty)
4. Code falls back to `job.senderEmail + job.senderAppPassword` from DB — this works
5. BUT: if job was created BEFORE the credential snapshot fix (older jobs), `senderAppPassword` may be null  

**Actual Code Path:**
```js
const appPassword = job.senderAppPassword || mailer.appPassword;
```
If both are null/undefined, `nodemailer.createTransport` gets no auth → `sendMail()` throws `Missing credentials`.  
**Impact:** Silent failure — contact marked `failed`, no obvious error message about missing creds.  
**Fix:** Validate `senderAppPassword` is non-null before starting `sendSingleEmail`. Fail the event early with a clear `{ error: 'credentials_missing' }` before attempting any sends.

---

### EC-8: IMAP Scan — Error Handling Swallows Per-Message Failures
**File:** `server.js` → `/api/check-mailbox`  
**Scenario:** One malformed email in the inbox causes `simpleParser()` to throw. The outer try-catch logs it and continues — but the `lastMailboxCheckAt` is still updated, so that message is never re-processed.  
**Impact:** If the malformed message is the one preceding a real reply, the reply is permanently missed.  
**Fix:** Wrap each message parse in an individual try-catch. Catch per-message errors, log the UID, continue to next message. Only update `lastMailboxCheckAt` after successfully processing all messages (or track the last successfully processed UID instead of a timestamp).

---

### EC-9: Stats Endpoint Includes Deleted Contacts
**File:** `routes/contacts.js` → `GET /api/contacts/stats`  
**Scenario:** The stats aggregation pipeline groups by `status` but the match stage uses `{ deleted: { $ne: true } }`. Verify this is actually applied. If the match is missing from the aggregation, deleted contacts inflate the stats cards.  
**Impact:** Dashboard shows 150 total when only 120 are active.  
**Fix:** Double-check that `{ $match: { deleted: { $ne: true } } }` is the FIRST stage in the stats aggregation pipeline before the `$group`.

---

## Medium

### EC-10: Pagination Total Count and Filtered List Can Diverge
**File:** `routes/contacts.js` → `GET /api/contacts`  
**Scenario:** The route runs `countDocuments(query)` and `find(query).skip().limit()` in parallel. Between the two queries executing, a contact is deleted (soft delete). The count reflects N contacts but the find returns N-1. Pagination shows "Showing 25 of 100" but navigating to the last page shows only 24 items.  
**Impact:** Low (near-invisible to users, no data loss).  
**Fix (if desired):** Use `$facet` aggregation: `{ total: [{ $count: 'n' }], data: [{ $skip }, { $limit }] }` — both from a single query at one consistent point in time.

---

### EC-11: Step2 Contact IDs Passed via URL Query Param — URL Length Limit
**File:** `step2.html`, `step1.html`  
**Scenario:** Step1 navigates to `step2.html?mode=bulk&ids=id1,id2,...,idN`. With 500 contacts, the URL is `?ids=` + 500 × 25 chars = ~12,500 chars. Browsers limit URLs to 2,000–8,000 chars depending on implementation.  
**Impact:** For large imports (> ~200 contacts), step2 may open with a truncated ID list — silently showing fewer contacts than were imported.  
**Fix:** POST the selected IDs to a temporary session endpoint and return a short token. Step2 fetches contacts by token. Alternatively, store IDs in `sessionStorage` (not URL).

---

### EC-12: Cooldown Check Uses `lastSentAt` But Retry Flow Resets It
**File:** `inngest-fns.js` → `sendSingleEmail`  
**Scenario:** Contact is sent successfully at 9:00am. Job finishes. At 9:30am, user clicks "Retry failed" (which shouldn't affect this contact — it wasn't failed). But if user uses "reset-for-send" for the same contact within 2 hours, the cooldown kicks in, marks the contact as `failed` (skipped), and the job reports a failure.  
**Impact:** Confusing UX — "retry" shows a failure for a contact that was already successfully sent.  
**Fix:** In the retry flow, check `Contact.status === 'sent'` before including it in the retry batch. The current `reset-for-send` endpoint resets status to `queued+approved` for ALL selected contacts — it should preserve `sent` contacts and only reset `failed` / `bounced`.

---

### EC-13: `done.html` Fetches Latest Job — Wrong Job After Multiple Campaigns
**File:** `done.html`  
**Scenario:** User finishes Job A (100 contacts). Goes to done.html. Then goes back to step1, imports more contacts, starts Job B. Navigates to done.html. If URL doesn't have `?jobId=X`, done.html fetches "latest job" from `GET /api/jobs/latest`. If Job B just started, it shows Job B stats (0 sent, processing) instead of Job A completion summary.  
**Impact:** User sees wrong completion screen.  
**Fix:** Always navigate from step3 to `done.html?jobId=${job._id}`. The URL param path already works — ensure step3 always appends it.

---

### EC-14: Template Key Collision on Edit (Name Change)
**File:** `routes/templates.js` → `PATCH /api/templates/:key`  
**Scenario:** Template "Cold Email" (key: `cold-email`) is renamed to "Cold" (key: `cold`). A built-in template already has key `cold`. The PATCH updates `name` and `body` but what happens to the key?  
**If key is NOT updated on rename:** The key stays `cold-email`, the display name changes — contacts assigned to `cold-email` still work. ✓  
**If key IS updated on rename:** `cold` now conflicts with the seeded `cold` template → duplicate key error from the `unique` index.  
**Fix:** Confirm that PATCH never changes `key` (the slug). If key changes are needed, treat it as delete + create with a migration step for contacts referencing the old key.

---

### EC-15: Resume Binary Loaded Into Memory Per Settings Fetch (If Projection Missed)
**File:** `routes/settings.js`, `lib/mailer.js`  
**Scenario:** If any code path calls `Settings.findOne()` without `{ 'resume.data': 0 }` projection, the full resume binary (up to 5 MB) is loaded into memory on every request.  
**Impact:** 5 MB per request × concurrent requests = memory exhaustion on Vercel functions (256 MB limit).  
**Fix:** Add a Mongoose `pre('find')` middleware on Settings model that always excludes `resume.data` unless explicitly included. Or create `Settings.findOneExcludeResume()` helper and enforce its use.

---

## Low / Cosmetic

### EC-16: Mobile Safari Input Zoom on Font-Size < 16px
**File:** `css/style.css`  
**Scenario:** Mobile Safari auto-zooms inputs with `font-size < 16px`. Some form inputs in the app use 14px. On iOS, the page zooms in on focus, doesn't zoom back out on blur.  
**Fix:** Set `font-size: 16px` on all `<input>` and `<textarea>` elements in the responsive CSS block.

---

### EC-17: `checkMailbox` Toast Shows Generic Count
**File:** `js/app.js` → `checkMailbox()`  
**Scenario:** After `POST /api/check-mailbox`, the response includes `{ bounced: N, replied: M }`. The toast shows "Found X bounces and Y replies" but doesn't tell the user if 0 bounces and 0 replies means "all clear" vs "scan failed silently".  
**Fix:** Differentiate toast: if both are 0, show "Mailbox scanned — no new activity". If > 0, show "Found X bounces, Y replies — dashboard updated."

---

### EC-18: Inngest Dev Mode Check Missing
**File:** `server.js` or `inngest.js`  
**Scenario:** In production, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` must be set. If they're missing (new deploy, secret misconfigured), Inngest will accept events locally but reject them from cloud, causing jobs to silently get stuck at `pending` indefinitely.  
**Fix:** On startup, if `NODE_ENV === 'production'` and either key is missing, log a loud warning: `[WARN] INNGEST_EVENT_KEY or INNGEST_SIGNING_KEY not set — background jobs will not run.`

---

### EC-19: No Rate Limit on `POST /api/check-mailbox`
**File:** `server.js`  
**Scenario:** The endpoint is called by GitHub Actions cron (trusted), but it's also callable by anyone who knows the URL. No auth, no rate limit. A bad actor (or accidental loop) hammering this endpoint would:  
1. Repeatedly open IMAP connections to the Gmail account
2. Update `lastMailboxCheckAt` to now → future legitimate cron checks a very narrow window, missing bounces
3. Potentially trigger Gmail's IMAP rate limits  
**Fix:** Add a simple secret header check: `if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return 403`. Send this header from GitHub Actions.

---

### EC-20: `bulkWrite` on Empty Array Throws in Older MongoDB Drivers
**File:** `routes/contacts.js` → `PATCH /api/contacts`  
**Scenario:** If `updates` array is empty (user clicks bulk approve with nothing selected), `Contact.bulkWrite([])` is called. Some MongoDB driver versions throw on empty operations array.  
**Fix:** Guard: `if (!updates || updates.length === 0) return res.json({ ok: true, matched: 0 })`.

---

## Summary Table

| ID | Severity | Category | Fix Effort |
|----|----------|----------|-----------|
| EC-1 | Critical | Security | Medium |
| EC-2 | Critical | Product Correctness | Low |
| EC-3 | High | Architecture | Low |
| EC-4 | High | Feature Correctness | Low |
| EC-5 | High | UX / Feature | Low |
| EC-6 | High | Data Integrity | Medium |
| EC-7 | High | Reliability | Low |
| EC-8 | High | Data Loss | Low |
| EC-9 | High | Data Integrity | Low |
| EC-10 | Medium | UX | Medium |
| EC-11 | Medium | Feature Limit | Medium |
| EC-12 | Medium | UX Confusion | Low |
| EC-13 | Medium | UX | Low |
| EC-14 | Medium | Data Integrity | Low |
| EC-15 | Medium | Performance | Low |
| EC-16 | Low | Mobile UX | Low |
| EC-17 | Low | UX Polish | Low |
| EC-18 | Low | Ops | Low |
| EC-19 | Low | Security | Low |
| EC-20 | Low | Reliability | Low |
