// Reads a person out of ONE search-engine result for a LinkedIn profile. Pure.
//
// Only the result's title and snippet are used — what the search engine shows to
// anyone — never the LinkedIn page itself. Titles come in a few shapes:
//   "Rahul Sharma - Engineering Manager - Acme | LinkedIn"
//   "Rahul Sharma – Acme | LinkedIn"
//   "Rahul Sharma - Engineering Manager at Acme - LinkedIn"
//
// The rule that keeps this honest is the company check: a profile that mentions the
// company only as a past employer ("Ex-Acme", "formerly at Acme") is dropped, because
// guessing a current address for someone who left is a guaranteed bounce.

const { isPlausibleName, stripAccents } = require('../emailPatterns');

const COMPANY_SUFFIXES = /\b(private limited|pvt\.? ?ltd\.?|pvt|ltd\.?|limited|inc\.?|llc|llp|corp\.?|corporation|co\.|technologies|technology|labs|solutions|software|services|systems|india|global|group)\b/g;
const PAST = /\b(ex|former|formerly|previously|prev|past|alumni|alum|retired)\s*(at|@|of)?\s*$/;

/** "Acme Technologies Pvt. Ltd." → "acme". Lowercase, accents and suffixes removed. */
function normCompany(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normText(s) {
  return ` ${stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * Does `text` name the company as a CURRENT employer? Checks every mention; one
 * current mention is enough, and a mention preceded by "ex"/"former" doesn't count.
 *
 * @param {string} text
 * @param {string[]} needles  normalised company names (e.g. ["acme", "acme corp"])
 */
function mentionsCurrent(text, needles) {
  const hay = normText(text);
  for (const needle of needles.filter(Boolean)) {
    const n = ` ${needle} `;
    let from = 0;
    while (true) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      const before = hay.slice(Math.max(0, i - 25), i + 1);
      if (!PAST.test(before)) return true;
      from = i + 1;
    }
  }
  return false;
}

/** linkedin.com/in/<slug>, or null when the URL is not a profile. */
function profileUrl(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : null;
}

/**
 * @param {{title: string, url: string, snippet?: string}} result
 * @param {{companyName: string, domain: string}} company
 * @returns {null | {name: string, title: string, linkedin: string}}
 */
function parseLinkedInResult(result, { companyName, domain }) {
  const linkedin = profileUrl(result && result.url);
  if (!linkedin) return null;

  const raw = String(result.title || '')
    .replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, '')
    .replace(/\s*\.\.\.\s*$/, '')
    .trim();
  if (!raw) return null;

  const parts = raw.split(/\s+[-–—|]\s+/).map(s => s.trim()).filter(Boolean);
  const name = parts[0].split(',')[0].replace(/\([^)]*\)/g, ' ').trim();
  if (!isPlausibleName(name)) return null;

  const stem = String(domain || '').split('.')[0];
  const needles = [...new Set([normCompany(companyName), stem].filter(n => n && n.length >= 2))];

  // Title and company are everything after the name. "Engineering Manager at Acme"
  // carries both in one part.
  const rest = parts.slice(1);
  const text = `${rest.join(' - ')} ${result.snippet || ''}`;
  if (!mentionsCurrent(text, needles)) return null;

  // The job title is the first part that isn't just the company, with any
  // "at <company>" tail removed.
  let title = '';
  for (const part of rest) {
    const t = part.replace(/\s+(at|@)\s+.*$/i, '').trim();
    if (t && !needles.includes(normCompany(t))) { title = t; break; }
  }

  return { name: name.replace(/\s+/g, ' ').trim(), title: title.slice(0, 160), linkedin };
}

/** True when a person's title matches any of the roles that were searched for. */
function matchesRoles(title, roles) {
  if (!roles || !roles.length) return false;
  const t = normText(title);
  return roles.some(r => {
    const words = normText(r).trim().split(' ').filter(w => w.length > 1);
    return words.length > 0 && words.every(w => t.includes(` ${w} `));
  });
}

module.exports = { parseLinkedInResult, normCompany, mentionsCurrent, matchesRoles, profileUrl };
