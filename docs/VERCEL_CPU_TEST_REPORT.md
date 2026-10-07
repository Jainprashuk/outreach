# Vercel CPU fixes: dev test report

**Branch tested:** `vercel-cpu-fixes`, working tree as of 2026-10-08
**Compared against:** `4371db7`, the commit the branch was cut from (the "old" behaviour)
**Environment:** local servers on the **dev database only** (`outreach_dev`). Production was never connected to.
**Related docs:** [VERCEL_CPU_FIXES.md](VERCEL_CPU_FIXES.md) (the plan) · [VERCEL_CPU_CHANGES.md](VERCEL_CPU_CHANGES.md) (what changed)

---

## 1. Verdict

**All 8 changes behave as designed, and nothing else in the app changed.**

| Area | Result |
|---|---|
| Existing test suites | 11 of 12 pass. The 12th (posting-sync) also fails on the old code: pre-existing, unrelated |
| Email sending, old vs new code | **12 of 12 scenarios identical**: same emails, same database writes |
| Real end-to-end send through Inngest | ✅ 2 of 2 delivered (to the SMTP stub), contacts and job updated correctly |
| Every page of the app (22 routes) | ✅ loads on old and new builds, 0 JS errors, 0 server errors |
| Request savings (measured, old → new) | Widget idle **101 → 10** per 5 min · Action Queue hidden **10 → 0** per 30 min · Setup guides hidden **26 → 0** per min · Backfill with stuck rows **182 → 2** requests |
| Data read per email send | **32,070 → 507 bytes** (100-email job) |
| Server cold-start CPU | **223 → 159 ms** median (−29%) |

**Before deploying:** `main` has moved on since this branch was cut (`admin-daily-digest` was merged). Merge `main` into the branch, rebuild `client/dist`, and re-run the quick checks in [§9](#9-deploy-checklist).

---

## 2. Safety measures used

No email could reach a real person, and no write could reach production:

1. **Dev-only guard, loaded into every test process.** It forces `NODE_ENV=dev`, **deletes `MONGODB_URI_PROD` from the process**, and kills the process if it connects to any database other than `outreach_dev` (or a throwaway `*_test` database used by the lifecycle suite).
2. **SMTP stubbed.** `nodemailer.createTransport` is replaced by a recorder that writes each message to a local file and returns a fake message ID. The dev account holds a real Gmail app password, so this mattered.
3. **Resend stubbed.** Calls to `api.resend.com` (sign-in codes, lifecycle emails) are recorded and faked.
4. **Test contacts use reserved addresses** (`*.example.test`) and a unique tag, and are deleted afterwards.
5. **Session:** a dev session was minted with `scripts/mint-session.js --env=dev` and destroyed afterwards. It was confirmed dead: `/api/actions` returned 401 after logout.

**Totals captured by the stubs:** 14 SMTP messages and 9 Resend calls. All were stubbed and none left the machine.

### Incident during testing (found, contained, reverted)

An Inngest dev server was **already running** on port 8288 (started Oct 7, 00:40), wired to a local `node server.js` on port 3000 (started Oct 7, 19:02). Neither was started by me, and the server on 3000 has no SMTP stub.

- My first test server registered itself with that Inngest server, which re-pointed the app's functions from `:3000` to my stubbed `:4042`.
- **No send events were created while this was the case.** I checked the dev database: 0 send jobs, 0 email activity and 0 lifecycle emails in the 3-hour window. So nothing was sent or swallowed.
- **Reverted:** I re-registered `:3000` with 8288 (registration only) and confirmed 8288 points at `http://localhost:3000/api/inngest` again.
- The end-to-end send test then used a **separate Inngest dev server on port 8299**, connected only to the stubbed test server.

---

## 3. Static checks

| Check | Result |
|---|---|
| `node --check` on every changed server file (`server.js`, `inngest-fns.js`, `routes/contacts.js`, plus the other in-progress files in the tree) | ✅ |
| `tsc --noEmit` (whole client) | ✅ |
| `vite build` | ✅ (`client/dist` rebuilt earlier) |

---

## 4. Existing test suites (all on dev)

| Suite | Result | Notes |
|---|---|---|
| test-action-queue | ✅ 29 / 0 | |
| test-classifier | ✅ 38 / 0 | |
| test-email-patterns | ✅ 112 / 0 | |
| test-fanout | ✅ 11 / 0 | |
| test-lifecycle | ✅ 53 / 0 | Own throwaway database, created and dropped |
| test-posting-search | ✅ 27 / 0 | |
| test-token-isolation | ✅ 12 / 0 | Against the branch server |
| test-admin-isolation | ✅ 42 / 0 | Against the branch server |
| test-tenant-isolation | ✅ 20 / 0 | Against the branch server |
| test-auth-otp | ✅ 41 / 0 | Against the branch server; Resend stubbed |
| test-prospects | ✅ 49 / 0 | Against the branch server |
| test-posting-sync | ⚠️ 78 / 2 | **Pre-existing.** Old code fails the same checks (76 / 4). See [§8](#8-pre-existing-issues-found-not-caused-by-these-changes) |

---

## 5. Change-by-change results

### #1 + #2: Mailbox backfill loop and backfill query

**Server test (real HTTP, real database).** Three test contacts:
- **A:** replied, but never emailed by the app. This is the kind that can never be completed.
- **B:** emailed and replied, missing its outbound thread entry.
- **C:** emailed and replied, missing its inbound thread entry.

| | Old server | New server |
|---|---|---|
| "Need backfill" count | 3 (includes A) | 2 (A excluded) |
| Calls to `POST /backfill-replies` | 5, then the test's cap stopped it. Every call after the first returned `processed 1, remaining 1`: **A could never leave** | **1** (`processed 2, remaining 0`) |
| Count afterwards | 1 (A stuck forever) | 0 |
| B's thread after | inbound + **outbound added** | inbound + **outbound added** (identical) |
| C's thread after | outbound + **inbound added** | outbound + **inbound added** (identical) |
| A's thread after | unchanged | unchanged |

**Browser test (the real Mailbox page and "Backfill now" button).** The server was mocked to never drain (`processed 3, remaining 3`), the worst case. The button was clicked and requests counted for 8 seconds:

| | Old build | New build |
|---|---|---|
| POST requests in 8s | **182, still looping** | **2, then stopped** |
| Button usable again | No (stuck "loading") | Yes |

### #3: Send-job widget

Fake clock, so minutes of polling run in seconds, plus a visibility shim to simulate a tab switch.

| Situation | Old build | New build |
|---|---|---|
| Nothing sending, tab visible, 5 min | 101 requests | **10 requests** |
| Tab hidden, 5 min | 0 | 0 |
| A job write in this tab (event) | not picked up (0) | **picked up immediately (1)** |

**Real time, during the end-to-end send ([§6](#6-end-to-end-send-real-pipeline)):**

| Phase | Requests | Meaning |
|---|---|---|
| Idle, before the job, 15s | 0 | 30s cadence |
| After the job is created and the page changes | first poll within 2.5s | the job appears at once, as with Step 3 |
| While the job runs, 15s | 5 | 3s cadence, as before |
| After the job finished, 45s | 1 | back to 30s cadence |

The event only fires for job and campaign writes: 10 of 10 path checks (`/api/jobs…`, `/api/campaigns…` fire; `/api/contacts`, `/api/templates`, `/api/jobsx` do not).

### #4: Action Queue ("Needs you") refresh

| Situation | Old build | New build |
|---|---|---|
| Tab visible, 9 min | 3 refreshes | 3 refreshes (unchanged) |
| Tab hidden, 30 min | **10** | **0** |
| Return to the tab after missing refreshes | nothing until the next tick | **refreshes immediately (1)** |

### #5: Setup-guide modals (LinkedIn and Naukri)

Each modal was opened for real with its "Guide" button. Counts cover every poller on the page.

| Situation | Old build | New build |
|---|---|---|
| Modal open, tab visible, 60s | 45 requests | 45 requests (unchanged) |
| Modal open, tab hidden, 60s | **26** | **0** |

The figures are the same for both modals.

### #6 + #7: Email send loads one item; HTML built once

The **old** and **new** `sendSingleEmail` were run on identical fixtures in the dev database with SMTP stubbed. Everything was compared after normalising IDs and timestamps: every email (from, to, subject, text, HTML, threading headers, attachments) and every database write (job items, contact status, history notes, thread entries).

| # | Scenario | Old = New? | What happened (both) |
|---|---|---|---|
| S01 | Normal send, resume flag on | ✅ | 1 email, item sent, contact sent, job done |
| S02 | Follow-up | ✅ | Subject `Re: Original subject`, threaded with `In-Reply-To`, contact `follow-up-sent` |
| S03 | Item already sent | ✅ | No email, nothing changed |
| S04 | Job cancelled | ✅ | No email, nothing changed |
| S05 | Job paused | ✅ | Throws "Job paused — will retry" (so Inngest retries) |
| S06 | Contact not in the job | ✅ | No email, nothing changed |
| S07 | Same contact twice in one job | ✅ | Sends the **pending** copy (see [§8](#8-pre-existing-issues-found-not-caused-by-these-changes)) |
| S08 | Emailed 1h ago (cooldown) | ✅ | Skipped, contact restored to `sent` |
| S09 | They replied, no answer yet | ✅ | Skipped |
| S10 | Blocklisted domain | ✅ | Skipped, contact `blocked` |
| S11 | Gmail rejects the message | ✅ | Item and contact `failed` with the reason |
| S12 | 3-item job, plus a duplicate delivery | ✅ | 3 emails, job `done`; the duplicate sends **nothing** |

**HTML output is byte-identical**, including links, `&`, `"` and `<>` escaping.

**Data read from Mongo per send (100-email job):** old 32,070 bytes → new 507 bytes.

**Also verified on production data earlier (read-only):** 3,730 item-selection comparisons, 0 mismatches.

### #8: Mail libraries load on first use

| Check | Result |
|---|---|
| Cold-start CPU, 5 runs each | Old: 217 / 221 / 223 / 223 / 254 ms · New: 157 / 158 / 159 / 161 / 162 ms → **median −29%** |
| Libraries loaded at boot | Old: yes · New: **no** |
| Mailbox check on the branch server | ✅ `ok: true`, 522 messages scanned over IMAP (read-only: imapflow fetches with `BODY.PEEK`, so nothing is marked read) |
| `simpleParser` through the lazy wrapper | ✅ parses correctly |

---

## 6. End-to-end send (real pipeline)

**Path:** browser → `POST /api/jobs` (exactly as Send step 3) → local Inngest → drip function → **new** `sendSingleEmail` → SMTP stub → database.

| Check | Result |
|---|---|
| Job created | ✅ HTTP 200 |
| Both emails delivered (to the stub) | ✅ 2 of 2, correct subjects, HTML body |
| Job items | ✅ both `sent`, message IDs recorded |
| Job status | ✅ `done` |
| Contacts | ✅ both `sent`, outbound thread entry written, `lastSentAt` set |
| Widget behaviour | ✅ see [#3](#3-send-job-widget) |
| Cleanup | ✅ 0 test rows left |

---

## 7. Every page of the app

All 22 routes were loaded in Chrome on the **old** and the **new** build, while signed in as the dev account. Each page was checked for its HTTP status, uncaught JS errors, console errors and any server 5xx.

| Route | Old | New |
|---|---|---|
| `/` Dashboard, `/leads`, `/discover`, `/jobs`, `/naukri`, `/campaigns`, `/campaigns/new`, `/interviews`, `/contacts`, `/mailbox`, `/add-contacts`, `/export-contacts`, `/admin`, `/templates`, `/blocklist`, `/analytics`, `/settings`, `/logs`, `/send/step1`, `/send/step2`, `/send/step3`, `/send/done` | 22 / 22 OK | **22 / 22 OK** |

Every page returned 200 and rendered its heading, with 0 errors and 0 server errors on both builds.

---

## 8. Pre-existing issues found (not caused by these changes)

These showed up while testing. They behave the same on the old code and were **not** fixed here.

1. **Duplicate Settings document under concurrent posting syncs.** `test-posting-sync` creates two Settings rows when syncs run at the same time. It fails the same way on the old code. The test left an ownerless empty Settings row in dev; I checked it and deleted it, so dev is back to 1 Settings document.
2. **Status written to the wrong item when a job contains the same contact twice.** `_atomicItemUpdate` uses the positional `items.$` on `contactId`, which updates the *first* matching item: the already-sent copy, not the pending one. The email goes out correctly, but the pending copy stays `pending`. Identical in old and new code. Unlikely in practice, since jobs are built from unique contacts.
3. **A mailbox check on a long-unchecked account can exceed Vercel's 60s limit.** The dev account's scan took 97s locally because its last check was long ago. This isn't a concern in prod, where the cron keeps accounts fresh.

---

## 9. Deploy checklist

1. **Merge `main` into `vercel-cpu-fixes`.** `main` gained `admin-daily-digest` after the branch was cut.
2. **Separate other work.** The working tree also contains **uncommitted changes that are not part of this work**: invalid-email handling in `lib/contactImport.js`, `routes/contacts.js` (POST `/`), `routes/campaigns.js`, `routes/leads.js`, `lib/campaignRunner.js`, `AppContext.tsx`, `AddContacts.tsx` and `Step1.tsx`. They were present during these tests and caused no failures, but decide whether they ship with this change.
3. **Rebuild and commit the client.** `cd client && npm run build`, and commit **`client/dist`** with the source; Vercel doesn't build the client.
4. **Re-run the quick checks:** `tsc`, `node --check`, and `NODE_ENV=prod node scripts/parity/cpu-fixes.js`, which is read-only and should show 0 mismatches.
5. **After deploy:**
   - Watch the first campaign batch in the widget and in Logs (`email / sent`).
   - Check that Vercel → Usage → Fluid Active CPU trends down over the following days.

---

## 10. Not covered by these tests

- **Real Gmail SMTP delivery.** It was stubbed on purpose. The code path up to `sendMail` is identical in old and new versions (proved in [§5](#5-change-by-change-results)), and the transport code was not changed.
- **A real resume attachment.** The dev account has no resume file, so S01 ran with the flag on but nothing to attach. The resume code path was not changed.
- **The Vercel runtime itself.** All tests ran on local Node. The first production deploy is the confirmation, using the checklist above.
- **Live AI classifier calls.** Not needed: the backfill fixtures were already classified, and the classifier code was not changed.
