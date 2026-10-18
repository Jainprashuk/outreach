// Ordering, tidying and reply tracking for the Naukri queue. Pure functions,
// shared by the server (claim, ingest, lists) and the tests, so "what goes out
// next", "what gets tidied" and "what a recruiter did" each have one definition.

const { parsePostedAgeDays } = require('./naukriFilters');

const DAY = 86400000;

// How old a listing is, in days, as of `now`. Uses the posting date when
// Naukri gave one (Recommended jobs do), else "3 days ago" read relative to
// when we saw it. Null when neither says.
function ageDays(job, now = new Date()) {
  if (job.postedAt) {
    const t = new Date(job.postedAt).getTime();
    if (Number.isFinite(t)) return Math.max(0, (now.getTime() - t) / DAY);
  }
  const printed = parsePostedAgeDays(job.postedText);
  if (printed == null) return null;
  const seen = job.lastSeenAt ? new Date(job.lastSeenAt).getTime() : now.getTime();
  return printed + Math.max(0, (now.getTime() - seen) / DAY);
}

// ── apply early ─────────────────────────────────────────────────────────────
// The order an apply run takes Waiting jobs in. On Naukri the first day or two
// after a posting matters most, so freshest first rather than approved first:
//   1. anything you picked by hand (priority) — "apply to these" means these
//   2. by freshness band — today, this week, older, unknown
//   3. within a band, best fit first, then the oldest approval
const band = (age) => (age == null ? 3 : age <= 2 ? 0 : age <= 7 ? 1 : 2);

function queueOrder(jobs, now = new Date()) {
  return [...jobs]
    .map(j => ({ j, b: band(ageDays(j, now)) }))
    .sort((x, y) =>
      (y.j.priority || 0) - (x.j.priority || 0)
      || x.b - y.b
      || (y.j.score ?? -1) - (x.j.score ?? -1)
      || new Date(x.j.approvedAt || 0) - new Date(y.j.approvedAt || 0))
    .map(x => x.j);
}

// ── tidy the inbox ──────────────────────────────────────────────────────────
// Why a job waiting for review should be cleared away, or null to keep it.
// Never touches a job you restored by hand (tidyExempt).
function tidyReason(job, rules = {}, now = new Date()) {
  if (!rules || !rules.enabled || job.tidyExempt) return null;
  const age = ageDays(job, now);
  if (rules.maxAgeDays && age != null && age > rules.maxAgeDays) return `posted ${Math.floor(age)} days ago`;
  if (rules.minScore != null && job.score != null && job.score < rules.minScore) return `fit ${job.score}, below ${rules.minScore}`;
  if (rules.companySite && job.likelyExternal) return 'applies on the company site';
  return null;
}

// ── track replies ───────────────────────────────────────────────────────────
// Naukri's application statuses (applyapi/v5/history, verified live
// 2026-10-18) → one stage each, ranked so the furthest one wins.
const NAUKRI_STATUS = {
  1: 'applied', 2: 'applied',                     // Applied · Application Sent
  4: 'viewed', 10: 'viewed',                       // Application Viewed · Resume Viewed
  6: 'shortlisted',                                // Shortlisted
  9: 'contacted',                                  // Contacted By Email
  7: 'not-shortlisted',                            // Not Shortlisted
};
const STAGE_RANK = { applied: 0, viewed: 1, 'not-shortlisted': 2, shortlisted: 3, contacted: 4 };
const STAGE_LABEL = {
  applied: 'Sent', viewed: 'Viewed by recruiter', shortlisted: 'Shortlisted',
  contacted: 'Contacted by recruiter', 'not-shortlisted': 'Not shortlisted',
};

// One history row → { stage, at, timeline } — the furthest stage reached and
// when, plus every status as Naukri printed it. Unknown status ids are kept in
// the timeline but do not move the stage.
function readStatus(row) {
  const timeline = (row.status || [])
    .map(s => ({ id: Number(s.statusId), value: String(s.statusValue || ''), at: s.dateTime || s.modifiedDate || null }))
    .filter(s => s.value);
  let stage = 'applied', at = null;
  for (const s of timeline) {
    const st = NAUKRI_STATUS[s.id];
    if (st && STAGE_RANK[st] >= STAGE_RANK[stage]) { stage = st; at = s.at; }
  }
  return { stage, at, timeline };
}

module.exports = { ageDays, queueOrder, tidyReason, readStatus, NAUKRI_STATUS, STAGE_RANK, STAGE_LABEL };
