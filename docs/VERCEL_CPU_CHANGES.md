# Vercel CPU fixes: what changed

**Branch:** `vercel-cpu-fixes` (not committed or deployed yet)
**Date:** 2026-10-07
**Plan this implements:** [VERCEL_CPU_FIXES.md](VERCEL_CPU_FIXES.md)

Only fixes that are safe **by design** were applied. Everything that would have changed how the app behaves was left out and is listed under [Not applied](#not-applied-and-why) with the reason.

---

## At a glance

| # | Change | File(s) | Saves | Behaviour change |
|---|---|---|---|---|
| 1 | The Mailbox backfill loop stops when it stops making progress | `client/src/pages/Mailbox.tsx` | The ~39K requests/month runaway loop | The button stops instead of looping forever |
| 2 | The backfill query skips rows it can never complete | `routes/contacts.js` | The cause of the loop; also 3 rows re-processed on every mailbox tick | The "N need backfill" banner no longer counts 3 contacts that could never be backfilled |
| 3 | Send-job widget: 3s polling only while a job is in flight | `client/src/components/SendJobWidget.tsx`, `client/src/lib/api.ts` | ~1,200 → ~120 requests/hour per open tab when idle | A job started **elsewhere** (campaign cron, another tab or device) appears within 30s instead of 3s |
| 4 | Action Queue refresh pauses in hidden tabs | `client/src/context/ActionQueueContext.tsx` | 480 requests/day per forgotten tab → 0 | None |
| 5 | Setup-guide modals pause in hidden tabs | `ScraperSetupGuide.tsx`, `NaukriSetupGuide.tsx` | 1,440 requests/hour while a hidden tab has one open → 0 | None |
| 6 | Each email send loads only its own item | `inngest-fns.js` | Loading the whole job (every email body) once per email | None (proven on prod data) |
| 7 | Email HTML is built once per send instead of twice | `inngest-fns.js` | A duplicate regex pass per email | None |
| 8 | The mail libraries load only when the mailbox scan runs | `server.js` | Cold-start CPU 379ms → 291ms (−23%) on every cold start | None |

---

## 1. Mailbox backfill loop: stop when no progress is made

**File:** `client/src/pages/Mailbox.tsx`, `runBackfill`

**Before**
```ts
while (true) {
  const { processed, remaining: left } = await backfillRepliesApi(20);
  processedTotal += processed;
  remaining = left;
  setBackfillProgress(processedTotal);
  if (processed === 0 || remaining === 0) break;
}
```

**After**
```ts
let prevLeft: number | null = null;
let maxRounds = Infinity;
for (let round = 0; round < maxRounds; round++) {
  const { processed, remaining: left } = await backfillRepliesApi(20);
  processedTotal += processed;
  if (prevLeft === null) maxRounds = Math.ceil((left + processed) / 20) + 2;
  const shrank = prevLeft === null || left < prevLeft;
  prevLeft = left;
  remaining = left;
  setBackfillProgress(processedTotal);
  if (processed === 0 || remaining === 0 || !shrank) break;
}
```

**Why.** The server's `processed` counts rows it *touched*, not rows it *fixed*. A row that stays stuck (its classification failed, or it can never be completed; see #2) is counted as processed every time. So the loop never ended: it fired a new request as soon as the last returned, for as long as the tab was open. That was 39,239 calls in 30 days, ~1,770/hour all day on Sep 22–23.

**Now.** The loop also stops when a round does not shrink the backlog, and never runs more rounds than the backlog could need. The first round always runs, and "shrank" is judged against the server's own previous answer, so a real backlog still drains completely.

**Functionality.** A real backlog is processed exactly as before. The only difference is that rows that can't be fixed no longer cause an endless loop; they're retried by the mailbox cron as they always were.

---

## 2. Backfill query skips rows it can never complete

**File:** `routes/contacts.js`, `needsBackfillFilter`. It is used by the backfill count, the backfill batch and the `remaining` count.

**Before**
```js
$or: [
  { thread: { $not: { $elemMatch: { direction: 'outbound' } } } },
  { thread: { $not: { $elemMatch: { direction: 'inbound' } } } },
  { replyClassifierOk: { $ne: true } },
],
```

**After**
```js
$or: [
  { lastSentAt: { $ne: null }, thread: { $not: { $elemMatch: { direction: 'outbound' } } } },
  { thread: { $not: { $elemMatch: { direction: 'inbound' } } } },
  { replyClassifierOk: { $ne: true } },
],
```

**Why.** `runBackfillBatch` adds the missing outbound message only `if (contact.lastSentAt && …)`. A contact who replied but was never emailed by the app (no `lastSentAt`) matched "no outbound entry" forever, but nothing could ever add one. Three production contacts are in exactly this state, and they're what kept the loop in #1 alive. The query now asks for an outbound entry under the same condition the code uses to create one.

**Verified on production (read-only).** The old query matches 3 rows and the new one matches 0. The new set is a subset of the old one, and the 3 dropped rows all have no `lastSentAt`, already have their inbound message, and are already classified. So there was nothing left to backfill on them.

**Functionality.** The Mailbox banner "3 contacts have sends/replies from before this thread view existed" disappears; clicking it could never have fixed them. Every row that *can* be backfilled is still included.

---

## 3. Send-job widget polls fast only while a job is in flight

**Files:** `client/src/components/SendJobWidget.tsx`, `client/src/lib/api.ts`

**Before**
```ts
useVisibleInterval(poll, 3000, !isStep3);   // every 3s on every page, even with no job
```

**After**
```ts
const IDLE_POLL_MS = 30_000;
useVisibleInterval(poll, jobs.length > 0 ? 3000 : IDLE_POLL_MS, !isStep3);

useEffect(() => {                              // poll at once when this tab changes a job
  if (isStep3) return;
  const onChanged = () => { poll(); };
  window.addEventListener(JOBS_CHANGED_EVENT, onChanged);
  return () => window.removeEventListener(JOBS_CHANGED_EVENT, onChanged);
}, [poll, isStep3]);
```
And in `apiFetch` (`lib/api.ts`), after any successful POST, PUT, PATCH or DELETE to `/api/jobs…` or `/api/campaigns…`:
```ts
window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
```

**Why.** With nothing sending, the widget renders nothing, yet it asked the server every 3 seconds: ~1,200 function invocations per hour per visible tab.

**Jobs still appear immediately in these cases:**
- **Started from the Send wizard.** Step 3 navigates away when done, and every page mounts its own `Layout`, so the widget remounts and polls at once.
- **Started, resumed or paused from a campaign page in this tab.** `apiFetch` fires the event and the widget polls at once.
- **While a job is running.** 3s polling as before, so progress is just as live.
- **Pause, resume or cancel from the widget itself.** Unchanged; a job is in flight, so it's on 3s.

**Functionality (the one visible change in this set).** A job started *somewhere else* (the hourly campaign cron, another browser tab, another device) appears in the widget within **30s** instead of 3s. Sending itself is unaffected; this is display only.

---

## 4. Action Queue ("Needs you") refresh pauses in hidden tabs

**File:** `client/src/context/ActionQueueContext.tsx`

**Before**
```ts
reload().catch(() => {});
const t = setInterval(() => reload().catch(() => {}), REFRESH_MS);   // every 3 min, even hidden
```

**After**
```ts
reload().catch(() => {});
const t = setInterval(() => { if (visible()) reload().catch(() => {}); }, REFRESH_MS);
const onVisibility = () => {
  if (visible() && Date.now() - lastLoadAt.current >= REFRESH_MS) reload().catch(() => {});
};
document.addEventListener('visibilitychange', onVisibility);
```

**Why.** This provider is mounted on every page, so any forgotten background tab cost 480 requests a day.

**Functionality.** None. While visible it refreshes every 3 minutes as before. Coming back to a tab that missed a tick reloads immediately, so what's on screen is never staler than before. The reload after contact changes (the 400ms coalesced one) is untouched.

---

## 5. Setup-guide modals pause in hidden tabs

**Files:** `client/src/components/leads/ScraperSetupGuide.tsx`, `client/src/components/naukri/NaukriSetupGuide.tsx`

**Before**
```ts
useEffect(() => {
  load();
  const t = setInterval(load, 5000);
  return () => clearInterval(t);
}, [load]);
```

**After**
```ts
// Paused while the tab is hidden; refreshes the moment it is visible again.
useVisibleInterval(load, 5000);
```

`useVisibleInterval` already exists (`client/src/hooks/useVisibleInterval.ts`). It runs once on mount, every 5s while visible, and immediately when the tab becomes visible again.

**Functionality.** None. The checklist ticks over exactly as before while you're looking at it.

---

## 6. Each email send loads only its own item

**File:** `inngest-fns.js`, `sendSingleEmail`. This is the worker for every drip and campaign email.

**Before**
```js
const job = await SendJob.findById(jobId).lean();          // every item, every rendered body
...
const item = job.items.find(i => i.contactId === contactId && i.status === 'pending');
```

**After**
```js
const job = await SendJob.findById(jobId, {
  status: 1, userId: 1, attachResume: 1, senderEmail: 1, senderName: 1, senderAppPassword: 1,
  items: { $elemMatch: { contactId, status: 'pending' } },
}).lean();
...
const item = (job.items || []).find(i => i.contactId === contactId && i.status === 'pending');
```

**Why.** A 100-email drip loaded all 100 rendered emails once per email, which is 10,000 email bodies read and deserialised to send 100. `$elemMatch` returns the first item matching both conditions, which is exactly what `items.find()` picked. The `.find()` is kept as a second guard.

**Verified on production (read-only).** The old and new item selection were compared for every contact (plus a non-existent one) in the 60 most recent jobs: **3,730 comparisons, 0 mismatches**. All six job-level fields match too. Run it yourself with `NODE_ENV=prod node scripts/parity/cpu-fixes.js`.

**Functionality.** None. Same item, same checks, same retry, same one-send-per-item guarantee.

---

## 7. Email HTML built once per send

**File:** `inngest-fns.js`, in both `sendSingleEmail` and `sendEmailBulk`

**Before.** `bodyToHtml(item.body)` was called twice per email: once for the message, once for the thread entry stored on the contact.

**After**
```js
const bodyHtml = bodyToHtml(item.body); // sent and stored in the thread: render once
... html: bodyHtml ...                   // in sendMail
... html: bodyHtml ...                   // in the thread $push
```

**Functionality.** None. It's the same pure function on the same input, so the output is byte-identical.

---

## 8. Mail libraries load only when the mailbox scan runs

**File:** `server.js`

**Before**
```js
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
```

**After**
```js
// imapflow and mailparser are only needed by the mailbox scan, and cost ~95ms of CPU to
// load. Required on first use so the cold start of every other request skips them.
const simpleParser = (...args) => require('mailparser').simpleParser(...args);
...
  const { ImapFlow } = require('imapflow');   // inside checkMailboxForUser
  const client = new ImapFlow({ ... });
```

**Why.** Every route runs in the one `server.js` function, so every cold start (a worker poll, a page load) paid to load the IMAP and MIME parsers that only the mailbox scan uses.

**Measured locally.** CPU to load `server.js` fell from **379ms to 291ms**, and neither library is in the module cache after boot. `simpleParser` was smoke-tested through the wrapper. Nothing else in `lib/` or `routes/` requires these packages.

**Functionality.** None. The first mailbox scan on a fresh instance loads them (~95ms) instead of the boot doing it.

---

## Not applied, and why

| Plan item | Why it was left out |
|---|---|
| Remove `step.run` in `sendSingleEmail` (5a) | **No gain.** Inngest 4.5.1 enables checkpointing by default, so a one-step function already runs in a single request. My earlier plan assumed 2 invocations per email; that was wrong. |
| Raise the workers' poll interval, `POLL_MS` (3a) | It's a config on your Mac, not in the repo, and it delays manual runs, so the choice is yours. Both workers have been off since Oct 1. If you restart them, `POLL_MS=90000` in `.env` cuts their calls by 78%. |
| Server-side "next poll" hint and heartbeat throttling (3b–3d) | It changes how fast manual runs start and what the Logs page shows. |
| Skip classification while rate-limited, count only resolved rows (2c, 2d) | Not needed: fixes 1 and 2 already stop the loop, and `classifyReply` already skips providers in cooldown. |
| Server-side rate limit on backfill and other heavy POSTs (2e, 7d) | It could reject a legitimate click. |
| Slower Logs, ScrapePanel and Naukri polling (4d, 4e) | Visible data would update more slowly. Those pages already pause in hidden tabs. |
| Raise the Dashboard silent mailbox-check threshold (4f) | Replies would show up later. |
| Legacy `index.html` / `js/app.js` timers (4g) | Those pages aren't used (`/` redirects to `/app/`). |
| Resume attachment cache (5c) | A stale cache could attach an outdated resume. |
| Slimmer contact preload in the mailbox scan (6a) | It touches bounce matching; with ~6 scans a day the gain is small. |
| Persist the classifier cooldown (6c) | No longer urgent once the loop is gone. Worth doing if Gemini 429s pile up again. |
| Change the cron schedule (6d) | GitHub only delivers ~6 runs a day anyway. |
| Lower function memory (7b) | It affects GB-hours, not CPU. It's a dashboard setting you can try yourself. |

---

## Verification done

| Check | Result |
|---|---|
| Client type-check and build (`tsc --noEmit && vite build`) | ✅ passes; `client/dist` rebuilt |
| `node --check` on `server.js` and `inngest-fns.js` | ✅ |
| `server.js` loads; mail libraries not loaded at boot; `simpleParser` works lazily | ✅ 291ms CPU, both absent from cache |
| Send item-selection parity on prod (read-only) | ✅ 3,730 comparisons, 0 mismatches |
| Backfill query parity on prod (read-only) | ✅ old 3 → new 0; new ⊆ old; dropped rows unfixable |

Not done: sending a real email through the changed `sendSingleEmail` (that needs a deploy). After deploying, watch the first campaign batch in the widget and in Logs (`email / sent`).

---

## To ship

1. Review the diff: `git diff main...vercel-cpu-fixes`.
2. Commit **including `client/dist/`**. Vercel serves the committed build and does not build the client itself.
3. Deploy. Then over the next few days:
   - **Vercel → Usage → Fluid Active CPU** should trend down.
   - **Logs page:** no `contacts / post /backfill-replies` bursts.
   - **Daily `email / sent` counts** match before; this confirms sending is unaffected.
   - **Optional:** re-run `NODE_ENV=prod node scripts/parity/cpu-fixes.js`.

**Rollback:** each change is independent and small; `git revert` the commit, or any single file, restores the old behaviour.
