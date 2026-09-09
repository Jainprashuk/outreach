const { fetchJson } = require('../http');
const R = require('./result');
const {
  normText, uniqStrings, toDate, titleCaseSlug, looksRemote,
  normEmploymentType, normWorkplaceType,
} = require('./normalise');

const URL_FOR = (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`;

// Ashby is why the byte cap exists: verified 2.1MB for 71 jobs (~30KB each of
// descriptionHtml + descriptionPlain, all of which we discard). A very large
// board could exceed even this — the failure mode is a clean 'error', which
// closes nothing, rather than a partial read.
const MAX_BYTES = 24 * 1024 * 1024;

async function fetchBoard(token, { signal, label } = {}) {
  const res = await fetchJson(URL_FOR(token), { signal, maxBytes: MAX_BYTES });
  if (!res.ok) return R.fromFailedFetch(res);

  const jobs = res.data && res.data.jobs;
  if (!Array.isArray(jobs)) {
    return R.error('Unexpected response shape (no `jobs` array)', res.status, { bytes: res.bytes });
  }

  // The isListed filter is mandatory and MUST run before the empty/ok decision:
  // unlisted postings are private drafts. A board whose every posting is
  // unlisted is therefore 'empty', which is correct — nothing is publicly
  // listed. `filtered` lets the UI explain a drop that isn't a real closure.
  const listed = jobs.filter(j => j && j.isListed === true);
  const filtered = jobs.length - listed.length;
  if (listed.length === 0) return R.empty({ bytes: res.bytes, filtered });

  const company = label || titleCaseSlug(token);
  const postings = listed.map(j => mapJob(j, company));

  return R.ok(postings, { bytes: res.bytes, filtered });
}

function mapJob(j, company) {
  const location = normText(j.location);
  const secondary = Array.isArray(j.secondaryLocations)
    ? j.secondaryLocations.map(s => s && s.location)
    : [];
  const locations = uniqStrings([location, ...secondary]);
  const workplaceType = normWorkplaceType(j.workplaceType);
  const country = normText(j.address && j.address.postalAddress && j.address.postalAddress.addressCountry);

  // descriptionHtml / descriptionPlain dropped here — never stored.
  return {
    sourceId: String(j.id),
    title: normText(j.title),
    company,
    department: normText(j.department),
    team: normText(j.team),
    location,
    locations,
    remote: j.isRemote === true || looksRemote({ workplaceType, location, locations }),
    workplaceType,
    employmentType: normEmploymentType(j.employmentType),
    country,
    url: normText(j.jobUrl),
    applyUrl: normText(j.applyUrl) || normText(j.jobUrl),
    requisitionId: '',
    postedAt: toDate(j.publishedAt),
    sourceUpdatedAt: null,
  };
}

module.exports = { kind: 'ashby', fetchBoard, MAX_BYTES, URL_FOR };
