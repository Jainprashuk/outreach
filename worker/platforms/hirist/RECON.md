# Hirist recon (Phase 0)

Fill this in from DevTools on the logged-in debug Chrome, then copy each confirmed
value into `meta.js` (everything marked `verify` there). Until then the driver
reads any job-shaped JSON from the site's own pages, so a wrong guess harvests
nothing and the run fails loudly. **It cannot apply:** `capabilities.apply` is
false in `lib/platforms.js`, and the driver refuses a real apply anyway.

How to check: open the page in the debug Chrome → DevTools → Network → filter
**Fetch/XHR** → reload → click the request that carries the job list → Preview.

## Verified 2026-10-20 (logged out; read-only page loads from the debug Chrome)

- **Search:** `https://www.hirist.tech/search/<slug>-jobs?minexp=N` loads
  `GET https://gladiator.hirist.tech/job/search?query=<Words>&page=<0-based>&size=20&minexp=N`.
  Body: `{ data: [...], page, limit, count, totalJobs, totalPages, hasMore }`.
- **Keyword pages:** `/k/nodejs-jobs` (Hirist's own tag slugs only) → `/job/keyword/?keywordId=…`.
  An unknown slug returns 0 jobs, which is why searches use `/search/`.
- **Pagination:** numbered pages, `?page=2` on the page URL (→ API `page=1`). Scrolling loads nothing.
- **Location filter:** `loc=` takes Hirist's own location ids → not used; Filters → Locations apply instead.
- **Job fields:** `id`, `title` (often "Company - Role - Skills"), `jobdesignation`, `min`/`max` (years),
  `minSal`/`maxSal` (lakhs; 0 with `hideSal: 1` when hidden), `tags[].name`, `locations[].name`,
  `companyData.companyName`, `createdTime` (ms), `workFromHome`.
- **Listing URL:** not in the feed; `/j/<title-slug>-<id>` (title lowercased, `.` dropped, non-alphanumerics → `-`).
- **Login check:** `GET gladiator.hirist.tech/auth/validate` → 401 when logged out. No hirist.tech cookies while logged out.
- **Live driver run:** 1 search × 3 pages → 60 jobs read, 59 kept by filters, all fields filled.

Still to do (needs you logged in): session cookie name, "my jobs" / applications feed, apply flow.

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

## Verified 2026-10-21 (logged in)

- **Login cookie:** `hirist_seeker_enc` (and `HIRIST_CK1`). `PHPSESSID` / `chatSdkToken` exist logged out too, so they do not count. `GET gladiator.hirist.tech/auth/validate` returns `{ seekerId, token }`.
- **Logged-in home** redirects to `/jobfeed` ("My Jobfeed").
- **Job feed:** `GET /job/jobfeed?minexp=N&page=0&query=0` → `{ data: [50 jobs] }`, same job shape as search. `/jobfeed?page=2` loads API `page=1` (different jobs), so the numbered-page loop works. Live harvest: 100 feed + 32 search = 115 unique.
- **Applied jobs:** page `/applied-jobs`, feed `GET /job/applied-jobs?page=0&status=` → `{ data: { jobs: [], hasMore, count } }`. Row fields still to confirm on the first real application (page code reads `appliedData.recruiterActions`). Count: `GET /job/applied/count/`.
- **Trap:** unknown paths (`/my-jobs`, `/applied`, `/myjobs`…) HANG on `domcontentloaded` instead of 404ing. Only put verified URLs in meta.js.

## Real apply — verified 2026-10-21 (one real application)

- Pre-check from `GET /job/detail?jobcode=<id>`: `applyUrl` (company site — clicking would ALSO record an apply on Hirist, so skipped before clicking), `assessmentFlags`/`assessmentCompleted` (screening test), `applied`, `status`.
- Button `[data-track="apply-job"]` → `POST gladiator.hirist.tech/job/apply?jobcode=<id>`; afterwards it reads "Applied" (disabled). `/job/apply-multiple` blocked by the driver.
- Proof: `GET /job/applied/count/` went 0 → 1 with `lastAppliedJobId: 1679274`.
- Applied row (`/job/applied-jobs`): `{ id: <application id>, applicationDate: ms (5h30m BEHIND real time), jobDetail: { id: <job id>, title, … }, recruiterAction: [], app_status: 0, … }` — job id is `jobDetail.id`.
- First real application: job 1679274, Frontend Developer - React/Next.js (2-4 yrs) @ HiringBlaze.
