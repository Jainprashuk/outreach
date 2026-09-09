const { fetchJson } = require('../http');
const R = require('./result');
const { normText, uniqStrings, toDate, normEmploymentType } = require('./normalise');

const BASE = 'https://jobicy.com/api/v2/remote-jobs';
const MAX_BYTES = 8 * 1024 * 1024;
const COUNT = 100;   // verified maximum useful page size

// Verified live: Jobicy returns HTTP 400 for any value outside its own
// vocabulary (geo=india is a 400, not an empty result), and lib/http maps a 400
// to kind 'error' — which closes nothing. Listing the valid values here keeps
// that 400 out of the common path.
const INDUSTRIES = [
  'engineering', 'dev', 'data-science', 'devops', 'design', 'product',
  'marketing', 'sales', 'support', 'finance', 'hr', 'writing', 'legal',
  'business', 'management', 'admin', 'education', 'healthcare',
];
const LEVELS = ['any', 'junior', 'mid-level', 'senior', 'executive'];

/** A remote-only SEARCH feed. Partial view — never drives close detection. */
async function fetchBoard(token, { query, signal } = {}) {
  const q = query || {};
  const params = new URLSearchParams({ count: String(COUNT) });

  if (q.industry) {
    if (!INDUSTRIES.includes(q.industry)) {
      return R.error(`Unknown Jobicy industry '${q.industry}'`);
    }
    params.set('industry', q.industry);
  }
  if (q.level && q.level !== 'any') {
    if (!LEVELS.includes(q.level)) return R.error(`Unknown Jobicy level '${q.level}'`);
    params.set('level', q.level);
  }
  if (q.geo) params.set('geo', normText(q.geo).toLowerCase());
  if (q.tag) params.set('tag', normText(q.tag));

  const res = await fetchJson(`${BASE}?${params}`, { signal, maxBytes: MAX_BYTES });
  if (!res.ok) return R.fromFailedFetch(res);

  const jobs = res.data && res.data.jobs;
  if (!Array.isArray(jobs)) {
    return R.error('Unexpected response shape (no `jobs` array)', res.status, { bytes: res.bytes });
  }
  if (jobs.length === 0) return R.empty({ bytes: res.bytes });

  return R.ok(jobs.map(mapJob), { bytes: res.bytes });
}

function mapJob(j) {
  // jobGeo is a single comma-separated string, e.g.
  // "Czechia,  Estonia,  Hungary, ... USA" — split it into real locations.
  const locations = uniqStrings(String(j.jobGeo || '').split(','));
  return {
    sourceId: String(j.id),
    title: normText(j.jobTitle),
    company: normText(j.companyName),
    department: normText((j.jobIndustry || [])[0]),
    team: '',
    location: locations[0] || normText(j.jobGeo),
    locations,
    remote: true,                 // every Jobicy listing is remote by definition
    workplaceType: 'remote',
    employmentType: normEmploymentType((j.jobType || [])[0]),
    country: '',
    url: normText(j.url),
    applyUrl: normText(j.url),
    requisitionId: '',
    postedAt: toDate(j.pubDate),
    sourceUpdatedAt: null,
    // Jobicy is the only source here that publishes pay.
    salaryMin: Number.isFinite(j.salaryMin) ? j.salaryMin : null,
    salaryMax: Number.isFinite(j.salaryMax) ? j.salaryMax : null,
    salaryCurrency: normText(j.salaryCurrency),
    salaryPeriod: normText(j.salaryPeriod),
  };
}

module.exports = { kind: 'jobicy', fetchBoard, MAX_BYTES, INDUSTRIES, LEVELS };
