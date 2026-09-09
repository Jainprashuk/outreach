const { fetchJson } = require('../http');
const R = require('./result');
const { normText, uniqStrings, toDate, looksRemote } = require('./normalise');

const BASE = 'https://www.themuse.com/api/public/jobs';
const MAX_BYTES = 8 * 1024 * 1024;
// 20 rows/page. Five pages is a sensible slice of a query that can run to 900+
// pages — this is a discovery feed, not an exhaustive mirror.
const MAX_PAGES = 5;

// Verified live. Passing TWO category params silently disables the filter and
// returns the whole firehose (page_count jumps to ~5030), so exactly one
// category per saved search — enforced here, not just in the UI.
const CATEGORIES = [
  'Software Engineering', 'Data and Analytics', 'Science and Engineering',
  'Management', 'Account Management', 'Sales', 'Human Resources and Recruitment',
  'Healthcare', 'Legal Services', 'Energy Generation and Mining',
  'Installation, Maintenance, and Repairs',
];
const LEVELS = ['Entry Level', 'Mid Level', 'Senior Level'];

/**
 * A keyword/category SEARCH, not a company board — so it is a partial view by
 * construction and must never drive close detection (see SOURCE_META.closes).
 *
 * @param {string} token   slug identifying the saved search (attribution only)
 * @param {{query?: object, signal?: AbortSignal, deadline?: object}} opts
 */
async function fetchBoard(token, { query, signal, deadline } = {}) {
  const q = query || {};
  const params = new URLSearchParams();

  if (q.category) {
    if (!CATEGORIES.includes(q.category)) {
      return R.error(`Unknown Muse category '${q.category}'`);
    }
    params.set('category', q.category);
  }
  if (q.level) {
    if (!LEVELS.includes(q.level)) return R.error(`Unknown Muse level '${q.level}'`);
    params.set('level', q.level);
  }
  if (q.location) params.set('location', normText(q.location));
  // Verified: jobs?company=SpaceX really filters (120 pages, SpaceX only). This
  // is what makes the company dropdown meaningful.
  if (q.company) params.set('company', normText(q.company));

  const out = [];
  let pages = 0;
  let total = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (deadline && deadline.remaining() < 6000) break;
    params.set('page', String(page));

    const res = await fetchJson(`${BASE}?${params}`, { signal, maxBytes: MAX_BYTES });
    if (!res.ok) {
      // A later page failing is not a reason to throw away earlier pages.
      if (out.length) break;
      return R.fromFailedFetch(res);
    }
    const rows = res.data && res.data.results;
    if (!Array.isArray(rows)) {
      if (out.length) break;
      return R.error('Unexpected response shape (no `results` array)', res.status, { bytes: res.bytes });
    }
    if (total === null) total = res.data.page_count || null;
    pages++;
    out.push(...rows);
    if (rows.length === 0 || (res.data.page_count && page >= res.data.page_count)) break;
  }

  if (out.length === 0) return R.empty({ pages });
  return R.ok(out.map(mapJob), { pages, upstreamPages: total });
}

function mapJob(j) {
  const locations = uniqStrings((j.locations || []).map(l => l && l.name));
  const location = locations[0] || '';
  const remote = looksRemote({ location, locations }) ||
    locations.some(l => /flexible/i.test(l));
  const page = (j.refs && j.refs.landing_page) || '';
  return {
    sourceId: String(j.id),
    title: normText(j.name),
    company: normText(j.company && j.company.name),
    // Muse's "category" is the closest thing it has to a department.
    department: normText((j.categories || [])[0] && j.categories[0].name),
    team: '',
    location,
    locations,
    remote,
    workplaceType: remote ? 'remote' : '',
    // Muse exposes seniority levels, not employment types — leaving this empty
    // is more honest than mapping one onto the other.
    employmentType: '',
    country: '',
    url: page,
    applyUrl: page,
    requisitionId: '',
    postedAt: toDate(j.publication_date),
    sourceUpdatedAt: null,
  };
}

module.exports = { kind: 'muse', fetchBoard, MAX_BYTES, CATEGORIES, LEVELS };
