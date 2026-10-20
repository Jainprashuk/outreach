# Instahyre recon (Phase 0)

Fill this in from DevTools on the logged-in debug Chrome, then copy each confirmed
value into `meta.js` (everything marked `verify` there). Until then the driver
reads any job-shaped JSON from the site's own pages, so a wrong guess harvests
nothing and the run fails loudly. **It cannot apply:** `capabilities.apply` is
false in `lib/platforms.js`, and the driver refuses a real apply anyway.

How to check: open the page in the debug Chrome → DevTools → Network → filter
**Fetch/XHR** → reload → click the request that carries the job list → Preview.

## Verified 2026-10-20 (logged in; read-only page loads from the debug Chrome)

- **Session cookie:** `sessionid` (httpOnly, ~7 weeks) + `csrftoken`; `cf_clearance` = Cloudflare in front.
- **API host:** `https://www.instahyre.com/api/v1/…` (e.g. `candidate_misc/profile/candidate/<id>`,
  `candidate_opportunities/candidate_matching/fetch_navbar_count` → `{ success, count: 51 }`).
- **Blocker:** `/candidate/opportunities/` (with or without `?matching=true`) redirects to
  `/candidate/onboard/` — the 4-step profile setup (skills, job preferences, resume, privacy). The
  driver now stops with that message instead of reporting zero jobs.

Still to do (after setup is finished): the opportunities feed request + fields, applications feed, apply flow.

## 5.1 Session
- [ ] Cookie(s) that mark a logged-in session (Application → Cookies → https://www.instahyre.com)
      — guessed in meta.js: `sessionCookies`
- [ ] Which one is short-lived vs a refresh token
- [ ] Login wall: URL ________ · visible text ________ (→ `guardMarkers.loginUrls` / `loginText`)

## 5.2 Challenges
- [ ] Captcha / block / re-login URLs ________ (→ `guardMarkers.urls`)
- [ ] On-screen challenge text, lowercase ________ (→ `guardMarkers.text`)

## 5.3 Listing feeds
- [ ] Recommended / matched feed request: `________` (page: `feeds[0].url`)
- [ ] Search results request: `________` (page: `searchUrl()`)
- [ ] Pagination: page param / cursor / infinite scroll / "Load more"
- [ ] Stable job id field: `________`
- [ ] Anything server-rendered only (no JSON)? → would need DOM selectors

## 5.4 Job fields (→ `meta.fields`, only where the defaults in shared/feed.js miss)
| Field | JSON path | Text or number |
|---|---|---|
| title | | |
| company | | |
| location | | |
| experience band | | |
| salary | | |
| skills / tags | | |
| posted date | | |
| job URL | | |
| description | | |
| applies on company site | | |
| recruiter reached out | | |

## 5.5 Application history (→ `applications`)
- [ ] "My applications" page URL ________ and its JSON request ________
- [ ] Status values (viewed, shortlisted, rejected, contacted, …) → mapped by
      `statusTimeline()` in shared/feed.js; add any word it misses
- [ ] Recruiter-initiated interest — a separate feed?

## 5.6 Apply flow (→ `applyFlow`)
- [ ] One click / modal with questions / redirect to company site
- [ ] How questions are rendered (form fields, chatbot, free text)
- [ ] What "already applied" looks like
- [ ] Any per-application note / cover message

## 5.7 Profile refresh
- [ ] Does Instahyre rank by profile recency? If yes, a refresh step is worth building
      (today: no refresh capability).

## Decision
- [ ] **apply in scope** or **harvest + track only**: ________

## Verified runs
| Date | Run | Result |
|---|---|---|
| | stub harvest + track (`npm run instahyre-worker:stub`) | |
| | real harvest | |
| | real track | |
| | dry run apply | |

## Real apply — verified 2026-10-21 (one real application)

- "Apply now" = `<a ng-if…><button ng-click="submitChoice(opp, true)">` in `.apply-button` (the only one on a listing). Playwright's `click()` refuses it (reads the `<a>` as covering it), so the driver clicks the centre with the mouse after an `elementFromPoint` check.
- Request: `POST /api/v1/candidate_opportunities/candidate_matching/apply/` `{ job_id, is_interested: true }` → `{ opp_id, applied_on, message: "Successfully stored interest in opportunity." }`.
- After it, the page may open "Want to apply to other similar jobs at …?" (`apply_bulk/`) — blocked at the network by the driver, modal cancelled.
- Applied listing: the button is replaced by "Application sent!\n on October 21, 2026" (whitespace folded before matching).
- First real application: job 404930, Backend Developer @ CynLr.
