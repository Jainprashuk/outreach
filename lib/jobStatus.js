// One reading of what a job site's status words mean. The workers (ingest, via
// worker/platforms/shared/feed.js) and the Activity feed (routes/naukri.js) used
// to carry separate regexes that disagreed ("offer" was Contacted in one and
// unrecognised in the other). Both now call this.
//
// Ids are Naukri's status ids (lib/naukriQueue.js NAUKRI_STATUS): 1 applied ·
// 4 viewed · 6 shortlisted · 9 contacted · 7 not shortlisted, plus 99 for a
// status nothing here recognises (kept in the timeline under its own words, moves
// no stage). The site's own text is always kept for display, so "Interview
// scheduled" or "Offer" still read as such even though they count as Contacted.
const OTHER_STATUS = 99;

// Order matters: a negative ("not selected") must be tested before the positive
// word it contains.
const STATUS_RULES = [
  // "Contact Viewed" is the recruiter looking at YOUR contact details — a view, not a reply.
  [/(contact|resume|profile|application|cv)s?[\s_-]*(viewed|seen|downloaded)/i, 4, 'viewed', 'Application Viewed'],
  [/not[\s_-]*(shortlisted|selected|suitable|considered|moved|taken forward)|unsuitable|reject|declin|unsuccessful|closed by recruiter|position (filled|closed)/i, 7, 'not-shortlisted', 'Not Shortlisted'],
  [/contact|interview|assessment|offer|call|message|chat|invite|repl(y|ied)/i, 9, 'contacted', 'Contacted'],
  [/shortlist|accept|interested|selected|in[\s_-]?process/i, 6, 'shortlisted', 'Shortlisted'],
  [/view|seen|read|open|download/i, 4, 'viewed', 'Application Viewed'],
  [/appl|sent|submit/i, 1, 'applied', 'Applied'],
  // "No reply yet" words (Wellfound PENDING) are the applied state, not news.
  [/^\s*(pending|awaiting|waiting)\b/i, 1, 'applied', 'Applied'],
  // Closed with no verdict (Wellfound EXPIRED): known, shown, moves no stage.
  [/expire|withdrawn|listing closed/i, 99, 'closed', 'Closed'],
];

// text → { id, stage, label } | null when nothing matches (stage 'applied' = your own send).
function classifyStatus(text) {
  const t = String(text || '');
  const hit = STATUS_RULES.find(([rx]) => rx.test(t));
  return hit ? { id: hit[1], stage: hit[2], label: hit[3] } : null;
}

module.exports = { classifyStatus, OTHER_STATUS, STATUS_RULES };
