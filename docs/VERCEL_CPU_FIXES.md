# Reducing Vercel Active CPU: every fix, ranked

**Status:** proposal written 2026-10-07. The safe subset is now applied on branch `vercel-cpu-fixes`; see [VERCEL_CPU_CHANGES.md](VERCEL_CPU_CHANGES.md) for what changed, before and after, and what was deliberately left out.

**Goal:** get the `outreach` project well under the Vercel Hobby limit of 4h Fluid Active CPU per 30 days. Each fix must leave sending, recipients, templates, limits, auth and schema unchanged.

---

## 1. What is actually using the CPU

Sources:
- The production `activitylogs` collection over the last 30 days. It records every POST, PUT, PATCH and DELETE, but **not GETs**, and not cron requests.
- GitHub Actions run history.

| Source | Calls in 30 days | Still happening? |
|---|---|---|
| `POST /api/contacts/backfill-replies` (Mailbox "Backfill" loop) | **39,239**, ~1,770/hour on Sep 22–23 | **Yes.** It restarts whenever someone clicks Backfill |
| LinkedIn worker heartbeat `POST /api/scrapes/claim` | 28,440 | No. Worker last seen Oct 1 |
| Emails sent through Inngest (≈2 invocations each) | 6,566 sent, about 14K invocations | Yes. This is legitimate |
| Naukri worker heartbeat `POST /api/naukri/claim` | 9,764 | No. Worker last seen Oct 1 |
| Worker progress, result and finish calls | ~1,500 | Only during runs |
| Mailbox checks (Dashboard plus cron) | 321 + ~181 | Yes. Few calls, each one heavy |
| Frontend GET polling (send-job widget every 3s, Action Queue every 3 min, …) | **Not measured** | Yes. Most likely cause of the recent ~4.2K calls per 12h |

GitHub throttles scheduled workflows heavily. The `*/5` mailbox cron really fires about 6 times a day, so it is **not** a main cause.

---

## 2. P0: the Mailbox backfill infinite loop (a confirmed bug)

### The bug

`client/src/pages/Mailbox.tsx`, `runBackfill`:

```ts
while (true) {
  const { processed, remaining: left } = await backfillRepliesApi(20);
  ...
  if (processed === 0 || remaining === 0) break;
}
```

`routes/contacts.js`, `runBackfillBatch`, does `processed++` for **every row it touches**, even when that row still matches `needsBackfillFilter` afterwards. A row stays stuck when:

1. **It can never be completed.** The contact has `repliedAt` set but `lastSentAt` is null. The "no outbound thread entry" clause keeps matching, but the code only adds an outbound entry when `lastSentAt` is set. **Three production contacts are in this state right now.**
2. **Classification fails.** The AI provider refuses the call (for example Gemini's free tier, 20 requests a day). `replyClassifierOk` is set to `false`, so the row matches again.

The loop then never ends. It fires requests back-to-back with no delay, keeps going in a background tab, and stops only when the tab closes. Each call loads up to 20 full contact documents (including thread text and HTML), may call the AI provider, saves each document, and runs `countDocuments`.

The same rows are also re-processed on every mailbox cron tick, but that is bounded to one batch per tick.

### Fixes (any one stops the loop; apply all four for defence in depth)

| # | Change | Where | Changes app behaviour? |
|---|---|---|---|
| 2a | **Make the stop condition about progress.** Break when `remaining` does not go down between two calls, and cap iterations (e.g. `ceil(initialCount / 20) + 2`). | `Mailbox.tsx` `runBackfill` | No. A real backlog still drains fully, because each successful batch lowers `remaining`. |
| 2b | **Leave out rows that can't be completed.** Change the outbound clause to `{ lastSentAt: { $ne: null }, thread: { $not: { $elemMatch: { direction: 'outbound' } } } }`. A contact never emailed has no outbound message to recover. | `routes/contacts.js` `needsBackfillFilter` | No. These rows could never be fixed. The "N contacts need backfill" banner stops showing the three ghosts. |
| 2c | **Report rows that actually resolved.** Count a row as `processed` only if it no longer matches the filter after `save()`, i.e. it has both thread directions and `replyClassifierOk === true`. Return `stuck` as well. | `runBackfillBatch` | No. The client gets an honest number, so the existing `processed === 0` exit fires correctly. |
| 2d | **Don't call the classifier while it's rate-limited, and don't save unchanged rows.** If the classifier breaker reports every provider in cooldown, skip the classify step for the rest of the batch and return early. Call `save()` only when `contact.isModified()`. | `runBackfillBatch` | No. Classification is retried on a later tick, which already happens today. |

Optional safety net:
- **2e.** Have `POST /backfill-replies` refuse a call that arrives within ~2s of the previous one for the same user (in-memory per instance is enough). This caps the damage of any future client loop.

**Expected impact:** removes the single largest source in the 30-day window, about 39K invocations plus the AI calls and document saves behind them.

**Verify:**
- After deploy, `needsBackfillFilter` counts 0 in production; it is 3 today.
- Clicking Backfill makes one request and stops.
- The Logs page shows no `contacts / post /backfill-replies` bursts.

---

## 3. P0: worker heartbeats (when the Mac workers are running)

Both workers call `/claim` every **20s** (`pollMs` default in `worker/scrape-worker.js` and `worker/naukri-worker.js`). That is 4,320 calls a day each, around the clock under launchd `KeepAlive`, almost all answered `{ run: null }`.

| # | Change | Where | Changes app behaviour? |
|---|---|---|---|
| 3a | **Config only:** set `POLL_MS=90000` (or 120000) in the Mac's `.env` and restart the workers. | `.env` on the Mac | Slightly. A run queued by hand from the UI starts up to 90s later instead of 20s. Scheduled runs are unaffected (see the note below the table). |
| 3b | **Let the server tell the worker when to poll next.** `/claim` returns `nextPollMs`: short (20s) while a run is queued or running, or a manual run was requested recently; otherwise the time until the next scheduled occurrence, capped at a few minutes. The worker sleeps for `nextPollMs ?? CFG.pollMs`. | Both claim routes plus both workers | No. Runs start just as fast; only idle polling slows down. |
| 3c | **Back off while idle.** After N empty claims in a row, double the sleep up to a cap (e.g. 5 min), and reset after any claimed run. | Both workers | Same trade-off as 3a, but only when idle. |
| 3d | **Make each heartbeat cheaper.** Skip `worker.save()` when nothing but `lastSeenAt` changed and it was written less than a minute ago. Run `failStaleRuns` at most once a minute. Exclude the two `/claim` paths from `auditHttpMutations` when no run was claimed: they wrote ~38K Logs rows in 30 days that nobody reads. | `routes/scrapes.js`, `routes/naukri.js`, `lib/activityLog.js` | Logs page: heartbeat noise disappears; claimed runs are still logged. Panel "ready" status still updates every minute. |

Scheduled runs still fire on time under 3a: the claim handler creates the scheduled run when it notices one is due. So a scheduled run starts at most one poll interval after its slot. Pick an interval you're comfortable with.

**Expected impact:** 8,640 calls/day become ~1,000–1,900 with 3a, and a few hundred with 3b.

---

## 4. P1: frontend polling

None of these appear in the audit log because they are GETs. They are the most likely explanation for recent traffic while you are using the app.

| # | Poller | Today | Change | Changes app behaviour? |
|---|---|---|---|---|
| 4a | `SendJobWidget` → `/api/jobs/active-all` | Every 3s on every page, even with no job (pauses when the tab is hidden) | Poll every 3s **only while a job is active**; otherwise every 60s. Also poll immediately after this tab creates a job (Step 3, campaign "Run now"), via a small app event or by remounting. | No. Progress is still live during a send. A job started in *another* tab shows up within 60s instead of 3s. |
| 4b | `ActionQueueContext` → `/api/actions` | Every 3 min, **keeps running in hidden tabs** | Use `useVisibleInterval` (already in the codebase). | No. It refreshes the moment the tab becomes visible. |
| 4c | `ScraperSetupGuide`, `NaukriSetupGuide` | Every 5s × 2 requests, keeps running in hidden tabs | Use `useVisibleInterval`. | No. |
| 4d | `Logs` page | Every 3s | 10s, or 3s only for the first minute and then 15s. | Log rows appear a few seconds later. |
| 4e | `ScrapePanel`, `Naukri` page | Every 3s | 3s while a run is active; 30s otherwise. | No. Status is live during a run. |
| 4f | Dashboard silent mailbox check | On load if stale >10 min, then every 15 min while visible | Raise the staleness threshold to match the real cron cadence (~30–60 min), or rely on the cron alone and keep the manual button. | Replies and bounces may appear up to ~30 min later on the Dashboard unless you click Check. |
| 4g | Legacy `index.html` / `js/app.js` | 3s widget poll and a mailbox `setInterval`, neither paused when hidden | Redirect the legacy `.html` pages to `/app/`, or delete their timers. | No. `/` already redirects to the React app. |

**Expected impact:** one hour on the Dashboard drops from ~1,200 widget calls to ~60, and forgotten background tabs make zero calls.

---

## 5. P1: Inngest send path (legitimate work, made cheaper)

| # | Change | Where | Changes app behaviour? |
|---|---|---|---|
| 5a | **Drop the single `step.run('send')` wrapper in `sendSingleEmail`.** A function with one step costs 2 HTTP invocations (run the step, then finish). Without the step it costs 1. Retries stay at `retries: 2`, and the existing "item no longer pending → return" check keeps it safe to run twice. | `inngest-fns.js` | No. Same retries and the same one-send-per-item guarantee. About halves send invocations (~14K become ~7K a month). |
| 5b | **Load only the needed item.** `SendJob.findOne({ _id, 'items.contactId': contactId }, { 'items.$': 1, status: 1, userId: 1, sender…: 1, attachResume: 1 })` instead of loading every item's body for every email. | `sendSingleEmail` | No. |
| 5c | **Cache the resume buffer.** Keep it at module level, keyed by `userId` + `resume.uploadedAt`/`updatedAt`, so warm instances don't re-fetch the PDF for each email. | `lib/mailer.js` `getResumeAttachment` | No. A new upload changes the key. |
| 5d | **Build the HTML once.** `bodyToHtml(item.body)` runs twice per email (the email itself and the thread entry); compute it once. | `inngest-fns.js` | No. |

---

## 6. P2: mailbox scan (few calls, each one heavy)

| # | Change | Where | Changes app behaviour? |
|---|---|---|---|
| 6a | **Don't load all ~12K contacts up front.** Preload only the threadable set (`lastSentAt` or `repliedAt` set, or a thread exists), which is what `byEmail`/`byMessageId` need. Look up bounce recipients with one `Contact.find({ email: { $in: bouncedAddrs } })` after the scan. | `server.js` `checkMailboxForUser` | No. Bounce matching still covers any status. |
| 6b | **Skip the backfill batch on cron ticks once nothing remains.** Combined with fix 2b this is already near-free. Also skip it if the classifier breaker is open. | `checkMailboxForUser` | No. |
| 6c | **Persist the classifier cooldown.** The breaker (`lib/classify/breaker.js`) is in-memory, so each new Vercel instance forgets a 429 and spends a request to rediscover it. That is how a 20-request daily Gemini quota turned into 20K failed calls. Store the "blocked until" time in the existing `AppConfig` document, or skip a provider for the rest of the day after a daily-quota 429. | `lib/classify/*` | No. Fewer doomed requests; classification resumes when the quota resets. |
| 6d | Leave the GitHub cron at `*/5`. GitHub only delivers ~6 runs a day anyway; changing it to `*/30` changes little. | `.github/workflows/check-mailbox.yml` | No. |

---

## 7. P2: platform and runtime

| # | Change | Changes app behaviour? |
|---|---|---|
| 7a | **Load heavy modules lazily.** `imapflow` and `mailparser` load at the top of `server.js`; PDF and report libraries load through routes. `require()` them inside the handlers that use them so cold starts parse less code. | No. |
| 7b | **Lower function memory** in the Vercel project settings (e.g. 1024 MB). This cuts **GB-hours** (3.13 GB-h per 12h), not Active CPU. Check that weekly-report PDF generation still fits. | No, if PDFs still render. |
| 7c | **Spend alerts.** Watch Vercel → Usage, and add a weekly check: if any audit-log `meta.path` exceeds ~500 calls in a day, flag it on the admin page. That would have caught the backfill loop on day one. | No. |
| 7d | **Rate-limit middleware for owner POSTs.** A per-user, per-path in-memory limit (e.g. 1 request/second for heavy endpoints: backfill, check-mailbox, classify). This guards against any future client loop. | No, under normal use. |

---

## 8. Recommended order and expected result

| Step | Fixes | Effort | Removes |
|---|---|---|---|
| 1 | **2a + 2b + 2c** (backfill loop) | ~30 lines | The largest 30-day source, and the trap still armed in production |
| 2 | **3a** (`POLL_MS=90000`), before restarting the Mac workers | Config only | ~75% of heartbeat calls |
| 3 | **4a + 4b + 4c** (widget, Action Queue, setup guides) | ~40 lines | Most GET polling while the app is open or forgotten |
| 4 | **5a** (single Inngest step) | ~5 lines | ~50% of send invocations |
| 5 | 2d, 3b/3d, 5b–5d, 6a–6c | Moderate | Per-call CPU |
| 6 | 7a–7d | Small | Cold starts, GB-hours, future regressions |

Steps 1–4 alone should take a month like the last one from **~95K+ invocations to roughly 20–25K**. Most of what remains is legitimate email sending. That should put Active CPU comfortably under 2h a month, though this is an estimate; confirm it in Vercel → Usage a week after deploying.

## 9. What none of these change

- Email content, subjects, templates or attachments
- Who gets emailed, plus the cooldown, blocklist, interview and reply-guard checks
- Drip rate, campaign daily limits and release hours
- Gmail credentials, provider configuration and authentication
- Database schema. 6c reuses the existing `AppConfig`; no new collections or fields are required.

## 10. How to verify after each step

1. **Count audit-log calls per path per day** (read-only):
   ```js
   db.activitylogs.aggregate([
     { $match: { createdAt: { $gte: new Date(Date.now() - 864e5) } } },
     { $group: { _id: '$meta.path', n: { $sum: 1 } } },
     { $sort: { n: -1 } }
   ])
   ```
2. **Check GET traffic.** In Vercel → Logs, filter by path: `/api/jobs/active-all`, `/api/actions`, `/api/inngest`.
3. **Check sending.** Vercel → Usage → Fluid Active CPU should trend down day over day. Sent counts per day in `activitylogs` (`email/sent`) should stay the same; that confirms sending is unaffected.
