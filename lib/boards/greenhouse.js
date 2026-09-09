const { fetchJson } = require('../http');
const R = require('./result');
const {
  normText, uniqStrings, toDate, titleCaseSlug, looksRemote, normEmploymentType,
} = require('./normalise');

const JOBS_URL  = (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`;
const DEPTS_URL = (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/departments`;

const MAX_BYTES = 12 * 1024 * 1024;
// Below this much remaining budget the department enrichment is skipped rather
// than risking the run's tail on a nice-to-have.
const ENRICH_MIN_REMAINING_MS = 8000;

/**
 * @param {string} token
 * @param {{signal?: AbortSignal, deadline?: {remaining: () => number}, label?: string}} [opts]
 * @returns {Promise<import('./result')>} BoardFetchResult
 */
async function fetchBoard(token, { signal, deadline, label } = {}) {
  // ?content=true is deliberately NOT used: it adds multi-MB of description HTML
  // that nothing here reads, since this feature never mines descriptions.
  const res = await fetchJson(JOBS_URL(token), { signal, maxBytes: MAX_BYTES });
  if (!res.ok) return R.fromFailedFetch(res);

  // Shape guard. A board serving something that isn't {jobs: [...]} is an ERROR,
  // never 'empty' — an API change must stop the feed, not wipe it.
  const jobs = res.data && res.data.jobs;
  if (!Array.isArray(jobs)) {
    return R.error('Unexpected response shape (no `jobs` array)', res.status, { bytes: res.bytes });
  }
  if (jobs.length === 0) return R.empty({ bytes: res.bytes });

  // /jobs carries no `departments` key (verified — it only appears under
  // ?content=true), so department comes from a second, BEST-EFFORT call. Keeping
  // the authoritative posting set on /jobs means an enrichment failure can never
  // perturb the diff.
  let deptById = null;
  let enrichError;
  const budgetOk = !deadline || deadline.remaining() > ENRICH_MIN_REMAINING_MS;
  if (budgetOk) {
    const d = await fetchDepartments(token, { signal });
    deptById = d.map;
    enrichError = d.error;
  } else {
    enrichError = 'Skipped — not enough time left in the run';
  }

  const fallbackCompany = label || titleCaseSlug(token);
  const postings = jobs.map(j => mapJob(j, { deptById, fallbackCompany }));

  return R.ok(postings, { bytes: res.bytes, ...(enrichError ? { enrichError } : {}) });
}

// Never call /offices — verified 28MB for stripe. `location.name` is already on
// each job, so it buys nothing.
async function fetchDepartments(token, { signal }) {
  const res = await fetchJson(DEPTS_URL(token), { signal, maxBytes: MAX_BYTES, retries: 0 });
  if (!res.ok) return { map: null, error: `Department lookup failed: ${res.error}` };

  const departments = res.data && res.data.departments;
  if (!Array.isArray(departments)) return { map: null, error: 'Department lookup returned an unexpected shape' };

  // Nested `jobs` arrays give a complete jobId -> department.name map (verified
  // 619 rows / 619 unique ids, exactly matching /jobs).
  const map = new Map();
  for (const dept of departments) {
    const name = normText(dept && dept.name);
    if (!name || !Array.isArray(dept.jobs)) continue;
    for (const job of dept.jobs) {
      if (job && job.id != null && !map.has(String(job.id))) map.set(String(job.id), name);
    }
  }
  return { map, error: null };
}

function mapJob(j, { deptById, fallbackCompany }) {
  const location = normText(j.location && j.location.name);
  const locations = uniqStrings([location]);
  return {
    sourceId: String(j.id),
    title: normText(j.title),
    company: normText(j.company_name) || fallbackCompany,
    department: (deptById && deptById.get(String(j.id))) || '',
    team: '',
    location,
    locations,
    remote: looksRemote({ location, locations }),
    // Greenhouse exposes neither keylessly. Left empty rather than guessed —
    // the UI renders that as "Not stated".
    workplaceType: '',
    employmentType: normEmploymentType(j.employment_type),
    country: '',
    // Greenhouse's absolute_url IS the application page.
    url: normText(j.absolute_url),
    applyUrl: normText(j.absolute_url),
    requisitionId: normText(j.requisition_id),
    postedAt: toDate(j.first_published) || toDate(j.updated_at),
    sourceUpdatedAt: toDate(j.updated_at),
  };
}

module.exports = { kind: 'greenhouse', fetchBoard, MAX_BYTES, JOBS_URL, DEPTS_URL };
