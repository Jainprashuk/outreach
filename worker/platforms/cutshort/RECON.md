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
