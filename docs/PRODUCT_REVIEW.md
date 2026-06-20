# Product Review — Goods & Bads

> Honest assessment from a 10-year PM lens: what this product gets right, what it gets wrong, and where the risk lives.

---

## What the Product Gets Right

### 1. The Core Workflow is Intuitive
Step 1 → Step 2 → Step 3 is the clearest possible funnel: import, review, send. First-time users don't need documentation. The numbered steps + sidebar nav make the current position obvious. This is a design win that many internal tools miss — they dump users into a single screen and expect them to figure it out.

### 2. Approval Step is Underappreciated
Most bulk-send tools skip the approval layer entirely. Forcing a human review of every personalised email before sending is the right call for cold outreach — it catches `{{name}}` rendering as blank, wrong templates, embarrassing typos. The per-contact override (edit subject/body without touching the base template) is especially powerful and not commonly seen in tools at this price point ($0).

### 3. Three Send Modes Matching Real-World Constraints
Sequential / Bulk / Drip maps directly to the real Gmail rate-limit landscape:
- Sequential = small personal sends
- Bulk = batch production sends with one SMTP connection
- Drip = spam-avoidance for large campaigns

This isn't over-engineering — each mode exists because of a genuine Gmail constraint. Users who know their domain (cold emailers) will immediately understand which mode to pick. The docs/send-modes.md reinforces it.

### 4. Bounce + Reply Tracking Closes the Loop
Most self-hosted send tools stop at "email sent". Having IMAP-based bounce and reply detection turns this from a fire-and-forget tool into a lightweight CRM loop. Storing `replySnippet` makes the dashboard actionable without opening Gmail.

### 5. The Send-Job Widget is a Genuinely Good UX Pattern
A floating widget that follows you across pages, shows live progress, and lets you pause/cancel without going back to step3 is a real UX win. Most tools force you to stay on the send screen. This lets users navigate to other tasks while a 200-email job runs.

### 6. Settings Activity Chart is a Power-User Delight
The 24-hour hourly SMTP bar chart in Settings is unexpectedly useful. It answers "did my job actually run?" without needing to count DB rows. Small feature, high trust-building value.

### 7. Retry Failed + Repair Flows
Having explicit "retry failed" and "repair stuck jobs" affordances shows the product was built by someone who actually runs campaigns and knows what goes wrong. Most tools silently leave you in a broken state.

---

## What the Product Gets Wrong (or Needs Work)

### 1. No Unsubscribe Mechanism — This is a Compliance Gap
This is the biggest omission. Cold emails sent without an unsubscribe option violate CAN-SPAM (US), CASL (Canada), and GDPR (EU). It's not just legal risk — Gmail itself now requires one-click unsubscribe for bulk senders. Without it, repeated sends to the same list risk Gmail account suspension, which would break the entire tool.

**This is not cosmetic. It should be P0 before any scale.**

---

### 2. Custom Variable Values Are Not Per-Contact
Custom variables defined in Settings apply globally. There's no way to set `{{projectUrl}}` to different values per contact. The `{{name}}`, `{{company}}`, `{{role}}` built-ins come from Contact fields, but any custom variable always renders as empty unless the user manually edits each email in step2. This undercuts the promise of the variable system significantly for anything beyond the three built-in fields.

---

### 3. Follow-Ups Are Completely Manual
The most important email in outreach is the follow-up. There's no "create follow-up for non-responders" button. Users have to: export contacts who didn't reply, re-import them, pick the follow-up template, re-approve. That's 15–20 minutes of manual work for what should be a 2-click flow. Given that follow-ups drive a large portion of replies, this is a significant productivity gap.

---

### 4. No Campaign Grouping — Flat Contact Pool is a Scaling Problem
All contacts live in one list. After running 5 campaigns over 3 months, the dashboard is 1,500 contacts with no way to say "show me only the YC batch" or "compare intro campaign vs follow-up campaign". The tag/campaign concept needs to be added before the contact list becomes unusable.

---

### 5. App Password UX is Fragile for Non-Technical Users
The product requires users to: enable 2FA on Gmail, go to Google Account > Security > App passwords, generate one, copy-paste it. For a solo developer-user this is fine. For anyone else, it's a blocker. OAuth2 (sign in with Google) would reduce onboarding friction from ~10 minutes to 30 seconds.

---

### 6. Reply Management Has No UI Despite Having the Data
The `replyRead`, `replySnippet`, `repliedAt` fields are all stored but there's no dedicated replies inbox. You see "replied" in a tab but can't mark as read, compose a response, or sort by most recent. The product stores the data but doesn't let you act on it. The gap between "data exists" and "data is useful" is always a UX problem.

---

### 7. Done Screen is Weak
`done.html` shows 4 numbers (sent, failed, total, pending) and 3 buttons. After running a 200-email campaign, users deserve more: which emails bounced, who replied, template performance breakdown, a shareable summary. The completion moment is a high-engagement time — the product should capitalise on it.

---

### 8. No Contact Detail View
There's no page or drawer showing the full timeline for a single contact: when they were imported, which emails were sent to them (and when), whether they bounced or replied, the reply snippet. You can see status in a table row, but you can't drill into a contact's history. This makes debugging ("why did Jane's email fail?") require going to the DB directly.

---

### 9. IST Timezone Hardcode is a Hidden Bug
The activity chart in settings.html renders hours in IST regardless of where the user is. Someone running this in London sees a chart where "peak send" appears at 3:30am. A 1-line fix (`Intl.DateTimeFormat().resolvedOptions().timeZone`) that hasn't shipped.

---

### 10. Gemini API Key Advertised But Never Wired
`GEMINI_API_KEY` appears in the environment but does nothing. When a user discovers it (e.g., reading the env file), they may expect AI features that don't exist. Dead env vars either become zombie maintenance burden or mislead future developers into thinking AI is "already built".

---

## Risk Summary

| Risk | Severity | Likelihood |
|------|----------|------------|
| Gmail account suspension (no unsubscribe, high send volume) | Critical | Medium |
| App Password revoked mid-campaign | High | Low–Medium |
| Contact list becomes unmanageable (no campaigns/tags) | Medium | High (after 3+ campaigns) |
| Multi-instance Vercel credential loss (in-memory state) | High | Low (per-job credentials partially solve this) |
| Sequential mode Gmail auth failure on > 20 emails | High | High (if user doesn't read send-mode docs) |
| Reply detection false negative (heuristic matching) | Low–Medium | Medium |

---

## Overall Verdict

This is a **high-quality personal tool** that solves the exact problem it sets out to solve — structured, reviewed, tracked cold email sends. The send pipeline, Inngest orchestration, and bounce/reply detection show genuine engineering maturity. The UX is cleaner than most internal tools built at 10× the effort.

The product is **not production-ready for anyone beyond the solo developer-user** without: an unsubscribe mechanism, per-contact custom variable values, and follow-up automation. Those three gaps define the ceiling of what the tool can accomplish today.
