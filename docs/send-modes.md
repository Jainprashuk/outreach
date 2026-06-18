# Send Modes

## Sequential

Each email is sent as a **separate Inngest event** (`email/single.send`), staggered 1.5 s apart.

```
email/batch.start
    │
    ├─ sendEmailBatch (orchestrator)
    │       loads pending items → fan-out
    │
    ├─ email/single.send  (contact A)  @ t=0      → new SMTP conn → AUTH → send → close
    ├─ email/single.send  (contact B)  @ t=1500ms → new SMTP conn → AUTH → send → close
    ├─ email/single.send  (contact C)  @ t=3000ms → new SMTP conn → AUTH → send → close
    └─ ...
```

- **N emails = N SMTP AUTH commands** — Gmail rate-limits repeated logins from the same IP
- Triggers "Too many login attempts" on batches of ~20+ contacts
- Inngest retries each email independently (up to 2 retries) on failure
- Pause / cancel takes effect between any two emails

**When to use:** Only if you need per-email Inngest-level automatic retries and are sending very small batches (< 10).

---

## Bulk (Recommended)

All emails are sent inside a **single Inngest step** using one **pooled SMTP connection**.

```
email/bulk.start
    │
    └─ sendEmailBulk (single step.run)
            │
            ├─ Open 1 pooled SMTP connection (maxConnections: 1)
            ├─ AUTH once with App Password
            │
            ├─ loop over pending items:
            │     check job status (pause/cancel)
            │     sendMail()  ← reuses open connection, no re-auth
            │     update SendJob item in MongoDB (sent / failed)
            │     update Contact status in MongoDB
            │
            │   (if Gmail drops connection mid-batch, nodemailer auto-reconnects — 1 more AUTH)
            │
            ├─ transporter.close()
            └─ job.status = 'done'
```

- **1 AUTH regardless of batch size** — "Too many login attempts" never triggers
- Progress written to MongoDB after each email — widget updates live
- Respects pause/cancel: checks job status before every send
- Per-email failures are recorded individually; the batch continues
- No automatic per-email Inngest retry — failed emails must be retried manually via the dashboard

**When to use:** Default choice for all batch sizes.

---

## For large batches (400 contacts example)

| Step | What happens |
|---|---|
| POST /api/jobs | SendJob created with 400 items, sendMode='bulk' |
| Inngest fires | `email/bulk.start` event |
| SMTP open | 1 connection, 1 AUTH |
| Emails 1–~120 | Sent through same connection |
| Gmail drops connection | nodemailer auto-reconnects (1 more AUTH) |
| Emails 121–~240 | Sent through new connection |
| Repeat until 400 done | ~3–4 AUTH attempts total for 400 emails |
| job.status = 'done' | Widget shows final result |

Sequential at 400 contacts = 400 AUTH attempts in ~10 min → guaranteed "Too many login attempts" block mid-batch.

**Gmail daily limit:** Regular Gmail allows **500 emails/day**. Google Workspace allows **2,000/day**. Factor this in before sending large batches.

---

## Side-by-side

| | Sequential | Bulk |
|---|---|---|
| Inngest events | N (one per contact) | 1 |
| SMTP connections | One per email | One pooled for entire batch |
| AUTH attempts (400 emails) | 400 | ~3–4 |
| "Too many login attempts" risk | High | None |
| Inngest retry on failure | Per email (auto, up to 2×) | Manual via dashboard |
| Pause / cancel | Between any two emails | Between any two emails |
| Live progress | Yes | Yes |
| Best for | < 10 emails, need auto-retry | Everything else |
