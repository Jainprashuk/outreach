# Product Features

> Comprehensive inventory of every user-facing capability in Outreach as of June 2026.

---

## 1. Contact Management

### Import
- **CSV upload** — drag-drop or file picker; auto-detects headers (`name`, `email`, `company`, `role`, `template`); skips duplicates by email within the same import session
- **Manual entry** — form per contact (name, email, company, role, template picker); add multiple before submitting
- **Sample CSV download** — one-click to get the expected column format

### List & Filtering (contacts.html + index.html)
- **Tab-based views** — All / Sent / Bounced / Replied / Remaining (not yet sent) / Pending (awaiting approval)
- **Live search** — client-side filter on name + email within the current page
- **Inline status filter** — dropdown: Any status / Queued / Sent / Failed / Bounced / Replied
- **Approval filter** — Any / Pending / Approved / Rejected
- **Template filter** — filter by which template was assigned
- **Pagination** — 25 contacts per page, next/prev controls, total count shown

### Editing & Deletion
- **Inline edit** — click pencil icon to edit name / company / role / template assignment per row
- **Soft delete** — contacts never permanently removed; deleted flag hides them from all views
- **Bulk select** — checkboxes + "select all on page" + floating bulk-action bar
- **Bulk delete** — remove selected contacts in one call
- **Bulk send selected** — reset selected contacts to approved and enter the send flow for just those

### Stats Cards (Dashboard)
- Total imported / Sent / Bounced / Replied / Remaining (queued+approved) / Pending approval
- Derived live from in-memory state (no extra DB call after initial load)

---

## 2. Template System

### Management (templates.html)
- **Create template** — name, subject, body; key auto-slugified from name
- **Edit template** — update name, subject, body in modal
- **Delete template** — single button, immediate
- **3 built-in defaults** — `intro-v2`, `follow-up`, `cold` (seeded at startup, not deletable via seed but can be deleted by user)

### Variable System
- **Built-in variables** — `{{name}}`, `{{company}}`, `{{role}}`, `{{sender}}`, `{{senderCompany}}`
- **Custom variables** — user-defined in Settings; regex-validated names; blocked list prevents overwriting built-ins
- **Clickable variable picker** — click a chip to insert `{{varName}}` at cursor position in subject/body editor
- **Live preview** — template body rendered with real contact data on step2.html

### Per-Contact Overrides
- **Edit on step2** — override subject and/or body per individual contact without changing the base template
- **Overrides persisted** — `editedSubject` / `editedBody` fields survive page refresh, stored in DB

---

## 3. Approval Workflow (step2.html)

- **Rendered preview** — see exactly how the email will look for each contact (variables interpolated)
- **Approve / Reject per contact** — single-click buttons
- **Bulk approve all** — approve entire pending list with one click
- **Edit & approve** — open edit modal, modify, save + auto-approve in one flow
- **Reject with reason** — rejected contacts skipped at send time
- **Filtered entry** — when coming from "send selected" on contacts.html, step2 shows only those specific IDs
- **Progress to step3** — navigates automatically when at least one contact is approved

---

## 4. Email Sending

### Three Send Modes

| Mode | Best For | Auth Calls | Retry |
|------|----------|------------|-------|
| Sequential | < 10 emails, need auto-retry | 1 per email | Auto (2×) |
| Bulk (default) | All batch sizes | ~3–4 per 400 emails | Manual |
| Drip | Spam-safe, slow campaigns | Reuses single | Auto (2×) |

**Sequential**
- Fan-out individual Inngest events per contact, 1.5 s staggered
- Per-email automatic retry (up to 2 attempts)
- Not suitable for batches > 20 (Gmail "Too many login attempts")

**Bulk**
- Single Inngest step, one pooled SMTP connection for entire batch
- Configurable chunk size (default 20; user sets at step3)
- Progress written to DB after each email → live widget updates
- Pause and cancel checked at every chunk boundary

**Drip**
- Configurable rate: 1–60 emails per hour (UI slider on step3)
- Fan-out events time-sliced over hours; redirects to dashboard immediately
- Background execution; no real-time step3 log (Inngest widget tracks it)

### Step 3 UX
- Gmail credential entry (email + App Password) — skipped if pre-configured via env
- Chunk size picker (bulk only)
- Drip rate picker (drip only)
- Resume attachment checkbox (appears if resume is uploaded in Settings)
- Send summary (approved count, pending count, total, mode)
- Real-time per-contact send log (bulk + sequential only)
- "Run in background" button → dismiss to dashboard

### Send-Job Widget (all pages)
- Floating overlay, bottom-right corner
- Auto-appears if an active job exists on any page (except step3)
- Live progress bar + X/Y sent + Z failed counters
- Pause / Resume toggle
- Collapse to pill / expand to full
- Auto-dismiss 8 s after completion
- Close button → cancels the job

---

## 5. Bounce & Reply Detection

- **Automated IMAP scan** — GitHub Actions cron fires every 5 min → `POST /api/check-mailbox`
- **Manual trigger** — "Check for bounces/replies" button on dashboard (immediate)
- **Bounce detection** — parses `multipart/report` messages from mailer-daemon/postmaster; extracts recipient email + diagnostic code
- **Reply detection** — matches by `In-Reply-To` / `References` messageId; fallback to `Re:` subject heuristic
- **Reply snippet** — stores first ~400 chars of reply (stops at reply-quote delimiter)
- **Replied badge + snippet preview** — dashboard shows replied contacts with snippet visible on hover / expansion
- **Unread reply indicator** — `replyRead` flag tracks which replies the user has seen
- **Deduplication** — only scans emails since last check time (stored in Settings); prevents re-processing
- **Lookback windows** — bounces: 7 days; replies: 30 days

---

## 6. Settings & Configuration

### Sender Identity
- Sender name (used in `From:` header and `{{sender}}` variable)
- Sender company (used in `{{senderCompany}}` variable)
- Gmail address (pre-fills step3 credential form)

### Resume Management
- Upload PDF or Word doc (max 5 MB)
- Attach to outgoing emails via checkbox on step3
- Download current resume
- Delete resume

### Custom Variables
- Create / edit / delete merge-tag variables
- Validation: alphanumeric + underscore, must start with letter
- Conflict detection against built-in variable names
- Values filled per-contact at template render time (or left as empty string if not set)

### SMTP Activity Chart
- 24-hour bar chart (SVG) showing emails sent per hour
- Interactive hover tooltip with exact count
- Resets visually each day
- IST timezone (hardcoded)

---

## 7. Dashboard (index.html)

- Full stats row with six cards
- Tab-filtered contact table (same tabs as contacts.html)
- Quick-action buttons: "Add More Contacts", "Resume Sending" (if active job exists), "Retry Failed", "Check Mailbox"
- Auto mailbox check every 15 min in foreground, 10 min on tab-focus
- Inline contact edit from dashboard table
- Completion screen (`done.html`) with batch summary after send job finishes

---

## 8. Cross-Cutting UX

- **Light / Dark theme** — toggle in sidebar, persisted to localStorage
- **Mobile responsive** — hamburger sidebar on < 700 px; 2-col stat grid on < 900 px
- **Toast notifications** — success / error / info, 4 s auto-dismiss, stacked
- **Skeleton screens** — animated placeholder on page load (no flash of empty)
- **Avatar chips** — initials + color based on first letter of name
- **Status badges** — color-coded pill for contact / job status
- **Button loading states** — spinner + disabled while async ops in flight
- **Error recovery flows** — retry failed contacts (reset to queued + approved, restart job)
