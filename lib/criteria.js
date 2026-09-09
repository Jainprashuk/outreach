// "What I actually want" — one saved profile, applied when a sync stores postings.
//
// Why this exists: a board like Stripe lists 600+ roles and you care about maybe
// twenty. Filtering in the UI means storing 600 rows you will never read; this
// filters BEFORE the write.
//
// The important subtlety is in lib/postingSync.js: a posting excluded by these
// rules is still LISTED by the board, so it must not be treated as closed. The
// sync stamps lastSeenAt for everything the board listed and only upserts the
// matching subset — otherwise changing your keywords would "close" half a board.

// Defaults: engineering/software plus data/ML/AI. Multi-word for the data terms
// on purpose — a bare "data" matches "Director, Data Governance" and drags in a
// lot of non-engineering noise.
const DEFAULT_INCLUDE = [
  'engineer', 'developer', 'programmer', 'software', 'sde',
  'backend', 'back end', 'back-end', 'frontend', 'front end', 'front-end',
  'fullstack', 'full stack', 'full-stack',
  'platform', 'infrastructure', 'devops', 'sre', 'site reliability', 'architect',
  'data engineer', 'data scientist', 'data science', 'analytics engineer',
  'machine learning', 'deep learning', 'ml engineer', 'mlops',
  'ai engineer', 'applied scientist', 'research scientist',
  'nlp', 'computer vision', 'llm',
];

// A blocklist, and it WINS over the include list — so "Solution Engineer
// (Pre-Sales)" is dropped even though it contains "engineer". That is the
// behaviour you want for a job feed; flip a term out of here if you disagree.
const DEFAULT_EXCLUDE = [
  'sales', 'recruiter', 'recruiting', 'account executive', 'account manager',
  'customer success', 'customer support', 'marketing', 'veterinary',
  'claims', 'nurse', 'teacher', 'driver', 'warehouse', 'barista', 'legal counsel',
];

const DEFAULTS = {
  enabled: false,          // opt-in: never silently drop postings on an upgrade
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDE,
  locations: [],           // empty = anywhere
  remoteOnly: false,
};

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

const cleanList = (list, fallback = []) => {
  if (!Array.isArray(list)) return fallback;
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = norm(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

/** Merge a stored/partial criteria object onto the defaults. */
function normaliseCriteria(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!c.enabled,
    include: cleanList(c.include, DEFAULT_INCLUDE),
    exclude: cleanList(c.exclude, DEFAULT_EXCLUDE),
    locations: cleanList(c.locations, []),
    remoteOnly: !!c.remoteOnly,
  };
}

/**
 * Does this normalised posting match the profile?
 *
 * @param {object} p  a NormalisedPosting (adapter output) or a stored JobPosting
 * @param {object} criteria  already through normaliseCriteria
 * @returns {boolean}
 */
function matchesCriteria(p, criteria) {
  if (!criteria || !criteria.enabled) return true;

  // INCLUDE matches the TITLE ONLY, deliberately. Matching the department too
  // is circular for search sources: Jobicy sets department from the industry you
  // searched for, so a "data-science" search makes every row's department say
  // "Data Science & Analytics" and the include list then matches everything —
  // which let "Director, Data Governance" through in testing.
  const title = norm(p.title);

  // EXCLUDE still looks at the department and team, because a role sitting in a
  // Sales org is one you want dropped however its title reads.
  const context = norm([p.title, p.department, p.team].filter(Boolean).join(' | '));

  if (criteria.exclude.some(term => context.includes(term))) return false;
  if (criteria.include.length && !criteria.include.some(term => title.includes(term))) return false;

  if (criteria.remoteOnly && !p.remote) return false;

  if (criteria.locations.length) {
    const where = norm([p.location, ...(Array.isArray(p.locations) ? p.locations : [])]
      .filter(Boolean).join(' | '));
    // Remote roles satisfy any location rule — they are open to you wherever
    // you are, and excluding them would be the wrong answer.
    const remoteish = p.remote || where.includes('remote') || where.includes('anywhere') || where.includes('worldwide');
    if (!remoteish && !criteria.locations.some(loc => where.includes(loc))) return false;
  }

  return true;
}

/** Split a comma/newline separated textarea into a term list. */
const parseTerms = (text) => cleanList(String(text == null ? '' : text).split(/[,\n]/));

module.exports = {
  DEFAULTS, DEFAULT_INCLUDE, DEFAULT_EXCLUDE,
  normaliseCriteria, matchesCriteria, parseTerms,
};
