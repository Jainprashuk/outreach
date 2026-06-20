# Future Enhancements

> Prioritised roadmap from a PM + engineering lens. Each item includes rationale, rough complexity, and impact estimate.

---

## Priority 1 — High Impact, Low–Medium Effort

### 1.1 OAuth2 Gmail Integration
**Problem:** App Passwords require 2FA and are invisible to non-technical users. One wrong revoke and every job silently fails.  
**Solution:** Gmail OAuth2 via `googleapis` npm package. Store refresh token in Settings. Auto-refresh access token before each send.  
**Impact:** Removes the biggest onboarding friction; eliminates credential re-entry on every restart.  
**Complexity:** Medium (OAuth consent screen + token storage + refresh logic).  
**Edge case to handle:** Token revocation mid-job → surface clear error, prompt re-auth.

---

### 1.2 Scheduled Send Time ("Send at X")
**Problem:** Drip controls rate but not start time. You can't say "start Monday 9am IST".  
**Solution:** Add a "Schedule start" datetime picker on step3. Store `scheduledAt` on SendJob. Inngest `step.sleep()` until that time before beginning the fan-out.  
**Impact:** Lets you prep campaigns on weekends and auto-send at optimal times.  
**Complexity:** Low (Inngest already handles delayed steps natively).

---

### 1.3 Per-Contact Custom Variable Values
**Problem:** Custom variables defined in Settings have no per-contact value. `{{customVar}}` renders as empty string for all contacts unless the template body hacks around it.  
**Solution:** Add a `customFields: Map` field to Contact schema. Populate from CSV extra columns at import. Show/edit on contact detail drawer.  
**Impact:** Unlocks true dynamic personalisation per contact beyond name/company/role.  
**Complexity:** Low–Medium (schema change + CSV parser + step2 render update).

---

### 1.4 AI Email Draft Generation (Gemini API key is already in env)
**Problem:** `GEMINI_API_KEY` is set but unused. Writing cold email copy is the hardest part.  
**Solution:** On templates.html, add "Generate with AI" button. Pass role, company, sender context to Gemini Flash. Return 3 subject + body variants. Let user pick + edit.  
**Impact:** Dramatically reduces time-to-first-send for new users.  
**Complexity:** Low (API key already available; single fetch call).  
**Warning:** Rate-limit the button (one call per 10 s) to avoid accidental cost burn.

---

### 1.5 Reply Read/Unread Management UI
**Problem:** `replyRead` field exists in the schema but there's no UI to mark replies as read or view full reply content.  
**Solution:** Add a "Replies" tab or drawer on dashboard. Show unread badge count on nav. Click to expand full reply + mark as read. Reply to them inline (compose window that triggers a single send).  
**Impact:** Makes the product a lightweight CRM loop, not just a sender.  
**Complexity:** Low (field exists, just needs UI).

---

## Priority 2 — High Impact, Medium Effort

### 2.1 A/B Template Testing
**Problem:** No way to know if Template A outperforms Template B beyond gut feel.  
**Solution:** On step1, allow assigning two templates to a contact batch with a 50/50 split. Track reply rate + bounce rate per template key. Show comparison chart in Settings or a new Analytics page.  
**Impact:** Data-driven iteration on copy = compound improvement over time.  
**Complexity:** Medium (Contact needs `templateVariant` field; stats API needs group-by template).

---

### 2.2 Contact Tagging & Segmentation
**Problem:** All contacts are in one flat list. No way to group by "YC companies", "Series A", "SF only", etc.  
**Solution:** Add `tags: [String]` to Contact schema. Tag picker on import + contact edit. Filter by tag in dashboard. Send to "only tagged X" from step1.  
**Impact:** Enables multi-campaign management and precise targeting.  
**Complexity:** Medium (schema + index + filter API + UI).

---

### 2.3 Unsubscribe Link & Suppression List
**Problem:** No opt-out mechanism. Legally required in most jurisdictions for commercial emails. Repeated sends to opted-out contacts risk Gmail account suspension.  
**Solution:** Auto-append `{{unsubscribeLink}}` footer. Backend endpoint `/unsubscribe?token=X` sets `Contact.status = 'unsubscribed'`. Never re-send to unsubscribed contacts. Show suppression count in stats.  
**Impact:** Legal compliance + reputation protection.  
**Complexity:** Medium (token generation + endpoint + schema status addition).  
**Note:** This should be Priority 1 if used for anything resembling commercial outreach.

---

### 2.4 Follow-Up Automation
**Problem:** Follow-ups are manual (re-import contacts, pick follow-up template, re-approve). Tedious for 100+ contacts.  
**Solution:** On done.html or dashboard, "Create follow-up campaign" button. Auto-populate step1 with contacts from previous campaign that did NOT reply within N days. Pre-assign `follow-up` template. Skip bounced + unsubscribed.  
**Impact:** Removes the most repetitive part of outreach; 2x–3x reply rates with follow-ups.  
**Complexity:** Medium (new campaign concept referencing parent campaignId on Contact).

---

### 2.5 Gmail Push Notifications (replace cron polling)
**Problem:** GitHub Actions cron fires every 5 min; replies/bounces have up to 5-min latency. Cron also costs Actions minutes.  
**Solution:** Use Gmail API's Push Notifications (`users.watch()`) to receive webhooks on new mail. Fire `check-mailbox` on each webhook instead of cron.  
**Impact:** Near-real-time reply detection; eliminates Actions usage.  
**Complexity:** Medium–High (requires OAuth2 first; Pub/Sub webhook endpoint).

---

### 2.6 Multi-User / Team Support
**Problem:** Settings is a singleton. Two users on the same deployment share templates, contacts, credentials — it's a personal tool that can't be shared with a team.  
**Solution:** Add `userId` (or `workspaceId`) to all schemas. Auth layer (Clerk or simple email magic-link). Settings, Templates, Contacts, Jobs scoped per user.  
**Impact:** Unlocks product as a SaaS vs personal tool.  
**Complexity:** High (schema migration + auth layer + data partitioning).  
**Note:** If this is ever a goal, add `userId` now — retrofitting is painful.

---

## Priority 3 — Medium Impact, Low Effort (Quick Wins)

### 3.1 Browser Timezone for Activity Chart
**Problem:** SMTP chart hardcodes IST (`Asia/Kolkata`). Anyone not in IST sees wrong hour labels.  
**Solution:** Pass browser timezone from frontend; bucket hours server-side using that timezone.  
**Complexity:** Low (one `Intl.DateTimeFormat().resolvedOptions().timeZone` call + API param).

---

### 3.2 Duplicate Contact Detection at Import
**Problem:** Importing the same CSV twice creates duplicate contacts. App deduplicates within a single import session but not against existing DB contacts.  
**Solution:** Before `POST /api/contacts`, check imported emails against DB. Return `skipped` count in response. Show it in the import toast.  
**Complexity:** Low (one `$in` query before bulk insert; schema has email index).

---

### 3.3 CSV Export
**Problem:** No way to export current contact list (e.g., to share with a colleague or back up).  
**Solution:** "Export CSV" button on contacts.html. Stream contact fields as CSV from `/api/contacts/export`.  
**Complexity:** Low (no new dependency needed; manual CSV construction or `json2csv`).

---

### 3.4 Template Preview in Step 1
**Problem:** On step1.html, you pick a template by name but can't preview what it looks like until step2.  
**Solution:** Template picker dropdown shows a popover preview of subject + body (rendered with placeholder values).  
**Complexity:** Low (templates already in `window._app.state`).

---

### 3.5 Keyboard Shortcuts
**Problem:** Power users navigating 200+ contacts use mouse exclusively.  
**Solution:** `j`/`k` to navigate rows, `a` to approve, `e` to edit, `r` to reject on step2. `?` opens shortcut help modal.  
**Complexity:** Low (pure frontend).

---

### 3.6 Contact Import Progress Bar
**Problem:** Importing 500 contacts takes a few seconds; the submit button just shows a spinner with no indication of progress.  
**Solution:** Backend streams newline-delimited JSON (`text/event-stream`) with `{imported: N, total: M}`. Frontend renders a progress bar.  
**Complexity:** Low–Medium (SSE or chunked transfer).

---

## Priority 4 — Longer-Term / Architectural

### 4.1 Email Service Provider (ESP) Abstraction
**Problem:** Hard-coded Nodemailer + Gmail SMTP. If Gmail blocks the account or the user wants SendGrid/Postmark for higher deliverability, there's no escape hatch.  
**Solution:** `lib/mailer.js` already abstracts transport creation. Add a `provider` field to Settings (`gmail | sendgrid | postmark`). Switch transporter implementation per provider. SendGrid/Postmark webhooks replace IMAP polling for delivery events.  
**Complexity:** High (each provider has different auth + webhook model).

---

### 4.2 Campaign / Batch Concept
**Problem:** There's no concept of a named "campaign". All contacts live in one flat pool. Hard to track "round 1 intro" vs "round 2 follow-up" performance.  
**Solution:** `Campaign` model: `{ name, templateKey, status, createdAt }`. Contacts linked to a campaign at import. Stats, jobs, replies all scoped per campaign. Campaign list page as homepage instead of flat contact list.  
**Complexity:** High (large schema + UI rework).

---

### 4.3 Deliverability Score / Warmup Mode
**Problem:** New Gmail accounts sending 400 cold emails get flagged immediately.  
**Solution:** "Warmup" mode: starts at 5/day, +5/day each day, caps at 50/day. Track warmup progress. Surface deliverability tips (SPF, DKIM, custom domain).  
**Complexity:** Medium (scheduler + Settings warmup config).

---

### 4.4 Template Version History
**Problem:** Editing a template is destructive — no rollback, no diff view.  
**Solution:** Store `versions: [{ subject, body, updatedAt }]` array (last 10). "Restore previous version" button in template editor.  
**Complexity:** Low–Medium (schema addition + UI panel).

---

### 4.5 Mobile App (PWA)
**Problem:** Responsive web works but feels like a desktop tool on mobile. No offline access, no push notifications for replies.  
**Solution:** Progressive Web App manifest + service worker. Push notification via Web Push API when new reply detected.  
**Complexity:** Medium (PWA wrapping; push subscription management).

---

## Technical Debt Items (Not Features, But Important)

| Item | Why | Effort |
|------|-----|--------|
| Remove in-memory credential storage (`mailer.transporter`) | Vercel multi-instance: env set on instance A is not visible on instance B | Low (already partially solved by per-job credential snapshot) |
| Sequential mode deprecation warning | Sequential has fundamental Gmail auth limit flaw; UI should steer users to Bulk | Low |
| Replace hardcoded IST timezone | Any user outside India sees wrong chart | Low |
| `GEMINI_API_KEY` env var — use or remove | Dead env vars confuse future developers | Low |
| Add `userId` scaffold now | Retrofitting multi-user on existing schemas is expensive | Medium |
| Move `senderAppPassword` to encrypted field | Plain-text in MongoDB is a risk if DB is ever exposed | Medium |
