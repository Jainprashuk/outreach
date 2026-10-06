// Turns a person's name into their likely work email, and a known (name, email) pair
// back into the format a company uses. Pure — no database and no network — so every
// rule here is proven by scripts/test-email-patterns.js.
//
// The one rule that matters most: when a known address could have come from more than
// one format, inferPattern answers null. A wrong format applied to a whole company is a
// burst of bounces on the sender's Gmail; an unknown one only means a weaker guess.

// Each builder gets a parsed name and returns the local part, or null when the name
// lacks a part the format needs. Order is the display order, not a preference.
const PATTERNS = {
  'first.last': (n) => (n.first && n.last ? `${n.first}.${n.last}` : null),
  first:        (n) => n.first || null,
  firstlast:    (n) => (n.first && n.last ? `${n.first}${n.last}` : null),
  flast:        (n) => (n.first && n.last ? `${n.first[0]}${n.last}` : null),
  firstl:       (n) => (n.first && n.last ? `${n.first}${n.last[0]}` : null),
  first_last:   (n) => (n.first && n.last ? `${n.first}_${n.last}` : null),
  'f.last':     (n) => (n.first && n.last ? `${n.first[0]}.${n.last}` : null),
  'last.first': (n) => (n.first && n.last ? `${n.last}.${n.first}` : null),
};
const PATTERN_KEYS = Object.keys(PATTERNS);

// With only an initial for a first name ("R. Sharma") the full-first-name formats
// would produce "r.sharma" and call it first.last — the initial formats are the only
// honest ones.
const INITIAL_SAFE = new Set(['flast', 'f.last']);

// The order a guess falls back through when there is no evidence at all.
const FALLBACK_ORDER = ['first.last', 'first', 'firstlast', 'flast'];

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'er', 'ca', 'cs', 'adv', 'prof', 'sir', 'shri', 'smt', 'capt']);
const CREDENTIALS = new Set(['mba', 'pmp', 'cfa', 'phd', 'cpa', 'acca', 'frm', 'csm', 'shrm', 'scp', 'cp', 'ms', 'msc', 'bsc', 'btech', 'mtech', 'be', 'me', 'jr', 'sr', 'ii', 'iii']);
// Words that turn up where a name should be — a company page, a hiring post, a
// "LinkedIn Member" placeholder. Any of them means this is not a person.
const NOT_A_NAME = new Set([
  'hiring', 'jobs', 'job', 'careers', 'career', 'team', 'recruitment', 'recruiting', 'linkedin',
  'member', 'company', 'official', 'page', 'group', 'hr', 'talent', 'acquisition', 'pvt', 'ltd',
  'limited', 'inc', 'llc', 'technologies', 'solutions', 'services', 'india', 'private', 'admin',
  // Automation that commits to GitHub under a name.
  'bot', 'ai', 'ci', 'build', 'builder', 'deploy', 'release', 'automation', 'github', 'actions',
  'dependabot', 'renovate', 'jenkins', 'service', 'system', 'root', 'test', 'devops',
]);

// Shared mailboxes: never a person, so never evidence of a person's format.
const ROLE_LOCALS = new Set([
  'careers', 'career', 'hr', 'hrd', 'jobs', 'job', 'info', 'hello', 'hi', 'contact', 'contactus',
  'talent', 'recruitment', 'recruiting', 'recruiter', 'recruiters', 'hiring', 'support', 'admin',
  'sales', 'team', 'office', 'mail', 'email', 'enquiry', 'enquiries', 'inquiry', 'inquiries', 'help',
  'press', 'media', 'marketing', 'noreply', 'no-reply', 'donotreply', 'privacy', 'legal', 'security',
  'billing', 'accounts', 'account', 'people', 'ta', 'business', 'partners', 'partnerships', 'ops',
  'operations', 'care', 'customercare', 'feedback', 'service', 'webmaster', 'founders', 'hey',
]);

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com',
  'zoho.com', 'gmx.com', 'yandex.com', 'mail.com',
]);

const stripAccents = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * Parse a display name into the parts a format is built from.
 *
 * @returns {null | {first: string, middle: string[], last: string|null,
 *                   initialOnly: boolean, lastInitialOnly: boolean, tokens: string[]}}
 */
function splitName(raw) {
  let s = stripAccents(raw);
  // A title fragment glued on ("Rahul Sharma - Engineering Manager", "Priya, PMP").
  s = s.split(/\s+[|•·]\s+|\s+[-–—]\s+|,/)[0];
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');
  // Letters, dots and joiners survive; emojis, digits and the rest become spaces.
  s = s.toLowerCase().replace(/[^a-z.'\s-]/g, ' ');

  let tokens = s
    .split(/[\s.]+/)
    .map(t => t.replace(/['-]/g, ''))  // O'Brien → obrien, Jean-Luc → jeanluc
    .filter(Boolean);

  while (tokens.length && HONORIFICS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && CREDENTIALS.has(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return null;

  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  return {
    first,
    middle: tokens.slice(1, -1),
    last,
    initialOnly: first.length === 1,
    lastInitialOnly: !!last && last.length === 1,
    tokens,
  };
}

/**
 * Stricter than splitName: is this plausibly a real person's full name? Used on names
 * read from search results and web pages, where a company or a slogan can sit in the
 * name position.
 */
function isPlausibleName(raw) {
  // A handle, not a name: "abdul00a", "ravi_k", "rsharma-dev".
  if (/[0-9_@]/.test(String(raw || '')) || /^[a-z-]+$/.test(String(raw || '').trim())) return false;
  const p = splitName(raw);
  if (!p || !p.last) return false;
  if (p.tokens.length > 4) return false;
  if (p.tokens.some(t => NOT_A_NAME.has(t))) return false;
  // At least one real word — "R. K." alone is not enough to build an address.
  return p.tokens.some(t => t.length >= 2) && p.first.length + p.last.length >= 4;
}

/** first|last — one person's identity within a company, for dedupe. */
function nameKey(raw) {
  const p = splitName(raw);
  if (!p) return null;
  return `${p.first}|${p.last || ''}`;
}

function localPartOf(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at <= 0) return null;
  return email.slice(0, at).toLowerCase().split('+')[0];
}

function domainOfEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase().trim() : '';
}

/** A shared mailbox like careers@ or hr.india@ — not a person. */
function isRoleAddress(emailOrLocal) {
  const local = String(emailOrLocal || '').includes('@') ? localPartOf(emailOrLocal) : String(emailOrLocal || '').toLowerCase();
  if (!local) return false;
  if (ROLE_LOCALS.has(local)) return true;
  const head = local.split(/[._-]/)[0];
  return ROLE_LOCALS.has(head);
}

/**
 * The format that reproduces this person's address, or null when none does or when
 * more than one could have.
 */
function inferPattern(name, email) {
  const p = splitName(name);
  let local = localPartOf(email);
  if (!p || !local || isRoleAddress(local)) return null;
  local = local.replace(/\d+$/, '');  // rahul.sharma2 is still first.last
  if (!local) return null;

  // Three-part Indian names: the address may use the middle name as the surname.
  const lasts = [p.last, ...p.middle].filter(Boolean);
  const variants = lasts.length ? lasts.map(last => ({ ...p, last })) : [p];

  const matches = new Set();
  for (const key of PATTERN_KEYS) {
    if (p.initialOnly && !INITIAL_SAFE.has(key)) continue;
    for (const v of variants) {
      if (PATTERNS[key](v) === local) matches.add(key);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/** Build an address from a name and a format, or null when the name can't fill it. */
function generateEmail(name, patternKey, domain) {
  const p = splitName(name);
  const build = PATTERNS[patternKey];
  if (!p || !build || !domain) return null;
  if (p.initialOnly && !INITIAL_SAFE.has(patternKey)) return null;
  const local = build(p);
  return local ? `${local}@${domain}` : null;
}

/**
 * acme.in from "https://www.Acme.in/about", "acme.in" or "someone@acme.in".
 * Returns null for anything that isn't a plausible domain.
 */
function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

const isFreeMail = (domain) => FREE_MAIL.has(String(domain || '').toLowerCase());

/**
 * Hunter reports a company's format as e.g. "{first}.{last}" or "{f}{last}". Map it to
 * ours, or null for a format we don't build.
 */
function fromHunterPattern(hp) {
  if (!hp) return null;
  const shape = String(hp)
    .replace(/\{first\}/g, 'F').replace(/\{last\}/g, 'L')
    .replace(/\{f\}/g, 'f').replace(/\{l\}/g, 'l');
  const map = {
    'F.L': 'first.last', F: 'first', FL: 'firstlast', fL: 'flast', Fl: 'firstl',
    F_L: 'first_last', 'f.L': 'f.last', 'L.F': 'last.first',
  };
  return map[shape] || null;
}

module.exports = {
  PATTERNS, PATTERN_KEYS, FALLBACK_ORDER, INITIAL_SAFE,
  splitName, isPlausibleName, nameKey, inferPattern, generateEmail,
  isRoleAddress, localPartOf, domainOfEmail, normalizeDomain, isFreeMail, fromHunterPattern,
  stripAccents,
};
