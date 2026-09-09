// Shared normalisers for the board adapters. Kept in their own module rather
// than in index.js so the adapters can import them without a require cycle
// (index.js requires the adapters).

/** Board slug as the user might paste it: a bare token, or a whole board URL. */
const normaliseToken = (raw) => {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Tolerate a pasted board URL — the token is the first path segment after the host.
  const m = s.match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
  if (m) s = m[1];
  return s.replace(/^\/+|\/+$/g, '').replace(/\s+/g, '').toLowerCase();
};

/** Anchored so a token can never inject a path segment or query into a URL template. */
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const isValidToken = (token) => TOKEN_RE.test(token);

const normText = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

/** Deduped, trimmed, empties dropped, original order kept. */
const uniqStrings = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = normText(item);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};

/**
 * Accepts ISO strings AND ms-epoch numbers — not defensive padding: Lever's
 * `createdAt` is verified ms epoch (1565990241800) while Greenhouse and Ashby
 * send ISO strings.
 */
const toDate = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Below ~1e11 it can only sensibly be a seconds epoch.
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 'acme-corp' -> 'Acme Corp'. The company fallback for Lever/Ashby, which expose none. */
const titleCaseSlug = (token) =>
  String(token || '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const EMPLOYMENT_TYPES = {
  fulltime: 'full-time', full: 'full-time', permanent: 'full-time',
  parttime: 'part-time',
  contract: 'contract', contractor: 'contract', contracttohire: 'contract', freelance: 'contract',
  intern: 'intern', internship: 'intern', trainee: 'intern', apprentice: 'intern',
  temporary: 'temporary', temp: 'temporary', seasonal: 'temporary',
};

// Substring fallback for free text, most specific first. Verified necessary:
// Lever's live commitment values include "Regular Full Time (Salary)", which no
// exact-match table would catch.
const EMPLOYMENT_PATTERNS = [
  ['internship', 'intern'], ['intern', 'intern'], ['apprentice', 'intern'], ['trainee', 'intern'],
  ['temporary', 'temporary'], ['seasonal', 'temporary'], ['temp', 'temporary'],
  ['contracttohire', 'contract'], ['contractor', 'contract'], ['contract', 'contract'], ['freelance', 'contract'],
  ['parttime', 'part-time'],
  ['fulltime', 'full-time'], ['permanent', 'full-time'],
];

/**
 * Lever's `categories.commitment` is free text; Ashby's `employmentType` is an
 * enum ('FullTime'). Anything unrecognised returns '' rather than a guess — the
 * filter panel renders that as "Not stated", which is honest.
 */
const normEmploymentType = (raw) => {
  const k = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return '';
  if (EMPLOYMENT_TYPES[k]) return EMPLOYMENT_TYPES[k];
  for (const [needle, value] of EMPLOYMENT_PATTERNS) {
    if (k.includes(needle)) return value;
  }
  return '';
};

const WORKPLACE_TYPES = {
  remote: 'remote', fullyremote: 'remote', remotefirst: 'remote',
  onsite: 'onsite', inoffice: 'onsite', office: 'onsite', inperson: 'onsite',
  hybrid: 'hybrid',
};

const normWorkplaceType = (raw) => {
  const k = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z]/g, '');
  return k && WORKPLACE_TYPES[k] ? WORKPLACE_TYPES[k] : '';
};

// "Remote" as a word, but not when it's being negated. A convenience flag only —
// `workplaceType` is the honest field, and it is empty for all of Greenhouse.
const REMOTE_RE = /\bremote\b/i;
const NOT_REMOTE_RE = /\b(?:no|non|not)[\s-]?remote\b/i;

const looksRemote = ({ workplaceType, location, locations } = {}) => {
  if (normWorkplaceType(workplaceType) === 'remote') return true;
  const hay = [location, ...(Array.isArray(locations) ? locations : [])]
    .filter(Boolean).join(' ; ');
  if (!hay || NOT_REMOTE_RE.test(hay)) return false;
  return REMOTE_RE.test(hay);
};

module.exports = {
  normaliseToken, isValidToken, TOKEN_RE, normText, uniqStrings, toDate,
  titleCaseSlug, normEmploymentType, normWorkplaceType, looksRemote,
};
