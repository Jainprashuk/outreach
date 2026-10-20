# Hirist recon (Phase 0)

Fill this in from DevTools on the logged-in debug Chrome, then copy each confirmed
value into `meta.js` (everything marked `verify` there). Until then the driver
reads any job-shaped JSON from the site's own pages, so a wrong guess harvests
nothing and the run fails loudly. **It cannot apply:** `capabilities.apply` is
false in `lib/platforms.js`, and the driver refuses a real apply anyway.

How to check: open the page in the debug Chrome → DevTools → Network → filter
**Fetch/XHR** → reload → click the request that carries the job list → Preview.

## 5.1 Session
- [ ] Cookie(s) that mark a logged-in session (Application → Cookies → https://www.hirist.tech)
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
- [ ] Does Hirist rank by profile recency? If yes, a refresh step is worth building
      (today: no refresh capability).

## Decision
- [ ] **apply in scope** or **harvest + track only**: ________

## Verified runs
| Date | Run | Result |
|---|---|---|
| | stub harvest + track (`npm run hirist-worker:stub`) | |
| | real harvest | |
| | real track | |
| | dry run apply | |
