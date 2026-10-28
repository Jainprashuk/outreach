# Wellfound recon — 2026-10-28 (read-only, logged-in debug Chrome)

- Login cookie: `_wellfound` (httpOnly); not checked logged out. Cloudflare (`cf_clearance`) in front.
- Every call is `POST /graphql`; the operation is in the body (`operationName`).
- Job list: `/jobs` shows the account's saved search (here "Software Engineer · Mumbai · Full Time") →
  `JobSearchResultsX` with `filterConfigurationInput.page` 1, 2, 3… — each scroll loads the next page (plain wheel works).
  Body: `data.talent.jobSearchResults.{hasNextPage,totalStartupCount,startups.edges[].node}`. A node is a
  startup (`name`, `highConcept`, `highlightedJobListings[]`) or `PromotedResult{promotedStartup}`.
  Listing: `id`, `slug`, `title`, `locationNames[]`, `remote`, `compensation` ("₹8L – ₹13L • No equity", may be $),
  `liveStartAt` (seconds), `currentUserApplied`, `primaryRoleTitle`, `atsSource`. No experience band or description.
- Job URL: `/jobs/<id>-<slug>` (verified). Listing page: buttons "Apply" and "Apply now"; page calls
  `JobApplicationApplyButton`, `TrackView`, `CreateInteraction`.
- Search URLs `/role/l/<role>/<city>` are server-rendered: no `JobSearchResultsX` → feed-only (no `searchUrl`).
- Applied jobs: `/jobs/applications` → `OngoingApplicationList {page}`; the Archived tab (`/jobs/applications/archived`)
  → `ArchivedApplicationList`. Node: `jobListing{id,title}`, `startup{name}`, `status` (`REJECTED`, `EXPIRED`, …),
  `createdAt` (seconds). Only REJECTED / EXPIRED seen; other status words are read by regex in shared/feed.js.
- NOT mapped: the apply mutation / "Apply" modal (cover note) → `capabilities.apply` stays false.

## Real apply — mapped 2026-10-28 (one real application, then one more through the driver)
- "Apply" on the listing runs `JobApplicationApplyButton` (has `currentUserApplied`), `JobApplicationModal` (the job's
  `questions[{id,kind,question,required,options}]`), `CreateInteraction APPLY_ATTEMPT`, and opens a modal form ending in
  "Send application" (`data-test="JobApplicationModal--SubmitButton"`); question label = `form label.block`, text
  `div.font-medium`, answer `textarea[name="customQuestionAnswers[<id>][answer]"]`.
- Send = GraphQL mutation `CreateJobApplication { input: { jobListingId, startupId, customQuestionAnswers, userNote,
  questionResponseSets, product, sourceId } }` → `{ data.jobListing.currentUserApplied: true }`; the button becomes
  "✓ Applied". Counted only on that answer for that job id.
- Question kinds seen: LONG (textarea, optional). Other kinds (select / multi) are unseen: an unrecognised control stops
  with the markup in the reason rather than guessing.
- Applied jobs: Ongoing/Archived lists show the new application (track verified).
