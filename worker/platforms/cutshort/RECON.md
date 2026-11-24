# Cutshort recon — 2026-10-28 (read-only, logged-in debug Chrome)

- Login cookie: `cutshort_authentication` (httpOnly). User: `GET /api/auth/user`.
- Matched list: `/profile/recommended-jobs` → client-side `/profile/all-jobs?matchesfor=<signal id>` →
  `GET /findjobs/q?page=N&matchesfor=<id>`, **5 a page**, body `{ results[], total_count, totalPages, page_size }`.
  Page 2+ only load when the **job list panel** (its own scrolling div) is scrolled with the pointer over it
  (`meta.scrollOverList`). 23 matched jobs for this account (5 pages); without `matchesfor` it is all 4132.
- Row: `_id`, `headline`, `company`, `public_url`, `expRange{min,max}`, `salaryRange{minVanity,maxVanity}` (rupees/yr),
  `allSkills[]`, `locations[]` (empty when remote) + `remoteType`, `comment` (plain description), `creationDate`,
  `lastUpdateDate`, `createdBy{name}` (the poster). No email/LinkedIn.
- Search is NOT URL-controlled: `?q=` / `?keywords=` only reorder, `?skills=` wants internal skill ids (`00668`),
  `?locations=` filters. Public `/jobs/<skill>-jobs` pages are server-rendered (`/backend-api/webpage/…` answers 400
  to a bare call). Hence feed-only (no `searchUrl`).
- Job page `/job/<Title>-<Company>-<shortId>`: buttons "Apply to this job" and "Apply now" (dry run finds "Apply now").
- Replies: Messages (`/profile/candidate-conversations?i=all`) → `GET /conversations-v2/candidate?page=1&user_role=candidate&context=<id>`.
  Empty for this account → row shape UNVERIFIED (read tolerantly in `applications.rowsFrom`).
- NOT mapped: the apply request / any screening form → `capabilities.apply` stays false.
- Cloudflare Turnstile is present on pages (`cf-turnstile-response`); `cf_clearance` cookie set. A challenge = hard stop.

## Real apply — mapped 2026-10-28 (one real application, then one more through the driver)
- Public page's "Apply to this job" only navigates to `/profile/all-jobs?jobid=<id>`; the driver opens that URL
  (`applyFlow.listingUrl`). Its "Apply now" opens a dialog: "You are applying for … To <recruiter>", message box
  (left empty), resume, "Follow <company>" toggle, Send / Cancel.
- Send = `POST /sendreply/jobsignal { signalid: <job id>, message, seekerSignalContext, type:'jobsignal', source:'all_jobs' }`
  → `{ Response:'OK', message:{…} }`; the button becomes "View conversation". Counted only on that answer for that id.
- The Follow toggle is pre-ticked and sends `POST /follow/company` (follow/unfollow): clicked once to untick, so an
  application does not follow the company.
- An applied job still shows "Apply now"; its dialog reads "You already have an active conversation on this job"
  (`confirm.already`) — skipped, nothing sent. `GET /api/auth/ats/my-applications-for-job/<id>` returns the application.
- Replies verified: `GET /conversations-v2/candidate?…&convo_status=awaiting|shortlisted|nottakenforward`,
  `{ results[] }`, row `jobSignal._id`; the default tab ("Interested in you") is recruiters writing first.

## Status audit 2026-11-02 (scripts/audit-platform-status.js, read-only)

Read 10 applications. The tab buttons read 'Shortlisted1' / 'Closed1' (the count is glued on), so the old word-boundary regexes never clicked them. The Shortlisted tab asks for conversations-v2/candidate WITHOUT convo_status. 'Interested in you' is convo_status=unread, with jobseekersignal rows that have no jobSignal. Seen: Shortlisted 1, Not shortlisted 1.

## Post-apply questionnaire — mapped 2026-11-24 (read-only, scripts/recon-cutshort-questionnaire.js)

- Seconds after `POST /sendreply/jobsignal`, the recruiter's bot ("Voila") posts a **[Questionnaire]** into the thread.
  It does not block the application: the application already stands.
- List: Messages → Pending reads `conversations-v2/candidate?…&convo_status=awaiting`; a row whose `lastMsgText` is
  `"[Questionnaire]"` has one. Row `_id` = the `?thread=` id; `jobSignal._id` = our `sourceId`. Later pages are the
  same URL with `page=N` (8 rows a page).
- Thread: `GET /loadthread-v2/<thread>` → `thread.messages[]`; the questionnaire is the message with
  `responseType: 'screening'`: `questions[{ question: { title, options[{_id,label}], responseType 'mcq'|'text',
  isMandatory }, responseStringArray }]`, `screeningSubmitted` (+ `screeningSubmittedOn`). Opening a thread also
  `POST /markthreadasread`.
- Cutshort PRE-SELECTS your last answer to the same question (in `responseStringArray`) even on an unsubmitted form —
  e.g. "I am not okay with this location" on a remote job. Nothing is sent until Submit.
- Page: `form > ol > li` per question. Choice: `fieldset > legend` + options as `[tabindex=0]` divs holding the label
  text (no native radios; a "Clear" link per question). Text: `label` + `textarea`. One `button[type=submit]` "Submit";
  afterwards the thread reads "Questionnaire submitted!". Class names are generated hashes.
- Seen on 2026-11-24: 20 questionnaire threads, 12 unsubmitted; questions repeat — location OK (remote / city),
  notice period, "This job offers ₹xL - ₹yL / yr. Does this work for you?", years of <skill>, how soon can you join,
  one free-text "Current CTC (in LPA) and in-hand salary per month?".
- NOT yet observed: the submit request itself (filled through the driver on its first real sweep; success is read
  from the page saying "submitted").
