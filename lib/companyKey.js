// One name for a company across every module: `d:<domain>` when its email domain is
// known, else `n:<normalised name>` — the same keys Discover's Hiring now and
// "Worth searching" use, so a link from any of them opens the same Company page.

const { normalizeDomain, isFreeMail } = require('./emailPatterns');
const { keyOf } = require('./discovery/hiringCompanies');

/** {domain, company} → key, or null when neither says anything. */
function keyFor({ domain, company } = {}) {
  const d = normalizeDomain(domain || '');
  if (d && !isFreeMail(d)) return `d:${d}`;
  const nk = keyOf(company || '');
  return nk ? `n:${nk}` : null;
}

/** A key from a URL → { domain } or { nameKey }, or null if it isn't one. */
function parseKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('n:')) {
    const nk = s.slice(2);
    return /^[a-z0-9]{1,120}$/.test(nk) ? { nameKey: nk } : null;
  }
  const d = normalizeDomain(s.startsWith('d:') ? s.slice(2) : s);
  return d && !isFreeMail(d) ? { domain: d } : null;
}

module.exports = { keyFor, parseKey, keyOf };
