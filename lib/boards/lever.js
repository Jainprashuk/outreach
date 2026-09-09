const { fetchJson } = require('../http');
const R = require('./result');
const {
  normText, uniqStrings, toDate, titleCaseSlug, looksRemote,
  normEmploymentType, normWorkplaceType,
} = require('./normalise');

const URL_FOR = (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`;
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Lever's error semantics are verified and load-bearing:
 *   unknown token (`netflix`)      -> HTTP 404      -> 'not-found', closes nothing
 *   valid but no open roles (`lever`) -> HTTP 200 [] -> 'empty', closes everything
 */
async function fetchBoard(token, { signal, label } = {}) {
  const res = await fetchJson(URL_FOR(token), { signal, maxBytes: MAX_BYTES });
  if (!res.ok) return R.fromFailedFetch(res);

  // The response is a BARE ARRAY, not an envelope.
  if (!Array.isArray(res.data)) {
    return R.error('Unexpected response shape (expected an array)', res.status, { bytes: res.bytes });
  }
  if (res.data.length === 0) return R.empty({ bytes: res.bytes });

  // No company field anywhere in the payload — the token IS the identity. This
  // is why JobBoard.label exists and why the add-board form pre-fills it.
  const company = label || titleCaseSlug(token);
  const postings = res.data.map(p => mapPosting(p, company));

  return R.ok(postings, { bytes: res.bytes });
}

function mapPosting(p, company) {
  // Every `categories` sub-field is optional — verified: leverdemo's rows carry
  // only location/team/allLocations, with no commitment and no department.
  const cat = p.categories || {};
  const location = normText(cat.location);
  const locations = uniqStrings([location, ...(Array.isArray(cat.allLocations) ? cat.allLocations : [])]);
  const workplaceType = normWorkplaceType(p.workplaceType);

  // `description`, `descriptionPlain`, `additional`, `lists`, `opening`,
  // `descriptionBody` and their *Plain twins are ~90% of the payload and are
  // deliberately dropped here so they are never held across the run.
  return {
    sourceId: String(p.id),
    title: normText(p.text),
    company,
    department: normText(cat.department),
    team: normText(cat.team),
    location,
    locations,
    remote: workplaceType === 'remote' || looksRemote({ workplaceType, location, locations }),
    workplaceType,
    employmentType: normEmploymentType(cat.commitment),
    country: normText(p.country),
    url: normText(p.hostedUrl),
    applyUrl: normText(p.applyUrl) || normText(p.hostedUrl),
    requisitionId: '',
    postedAt: toDate(p.createdAt),
    sourceUpdatedAt: null,
  };
}

module.exports = { kind: 'lever', fetchBoard, MAX_BYTES, URL_FOR };
