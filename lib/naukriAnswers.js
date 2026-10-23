// Resolving a Naukri screening question to the text the worker should type.
//
// Pure and dependency-free on purpose: the worker calls it while driving Chrome,
// and the config UI's "test this question" box calls it through
// POST /api/naukri/config/test-answer. Both must agree exactly, or the tester
// lies to you — so there is one implementation and no second copy.
//
// The rule that matters: no match means SKIP. Guessing at a screening question
// is how you end up telling a recruiter something untrue in writing, and unlike
// a bad email it is attached to your profile permanently.

// {{placeholder}} -> the profile field it names. Deliberately a fixed map rather
// than free property access, so a typo'd placeholder fails loudly at match time
// instead of quietly resolving to "undefined" inside an application.
const PLACEHOLDERS = {
  fullName:              (p) => p.fullName,
  email:                 (p) => p.email,
  phone:                 (p) => p.phone,
  noticePeriodDays:      (p) => p.noticePeriodDays,
  currentCtcLpa:         (p) => p.currentCtcLpa,
  expectedCtcLpa:        (p) => p.expectedCtcLpa,
  totalExperienceMonths: (p) => p.totalExperienceMonths,
  // Derived, because every Naukri form asks in years and nobody stores years.
  totalExperienceYears:  (p) => (p.totalExperienceMonths == null
    ? null
    : Math.floor(p.totalExperienceMonths / 12)),
  currentCompany:      (p) => p.currentCompany,
  currentDesignation:  (p) => p.currentDesignation,
  currentLocation:     (p) => p.currentLocation,
  preferredLocations:  (p) => (p.preferredLocations || []).join(', '),
  willingToRelocate:   (p) => (p.willingToRelocate ? 'Yes' : 'No'),
  highestQualification:(p) => p.highestQualification,
  skills:              (p) => (p.skills || []).join(', '),
};

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// For MATCHING only, never for what gets typed. Punctuation goes, so a pattern
// "current ctc" matches "Current CTC (in LPA)?" and "current-ctc" alike. Kept:
// + # . inside words, which carry meaning in skills ("c++", "c#", "node.js").
const matchable = (s) => norm(s)
  .replace(/[^a-z0-9+#.]+/g, ' ')
  .replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ── reworded questions ──────────────────────────────────────────────────────
// The same question comes in many wordings: "Notice period?", "What is your
// notice period (in days)?", "Please mention your notice period". A rule only
// matches by substring, so each wording used to need its own rule, or the AI.
//
// meaningKey() keeps the words that carry the meaning and drops the rest:
// filler ("please", "your", "what is") and units ("lpa", "in days") go,
// equivalent words become one ("salary"/"compensation" → ctc, "reactjs" →
// react, "yrs" → years). Two questions with the SAME key ask the same thing.
//
// What it never touches: skills, numbers, negations ("not", "no", "never")
// and words like day/night, current/expected — the words whose difference IS
// the question. "Years of React" and "years of React Native" keep different
// keys, and so do "current CTC" and "expected CTC".
const FILLER = new Set(('please kindly mention enter provide specify share state give tell us me my your yours you do does did ' +
  'have has had what whats which where when is are was were be been being the a an of in on for to with as at by how many much ' +
  'can could would will should may might total overall approx approximately exact exactly kindly if any ' +
  'lpa lakh lakhs lac lacs inr rs rupees per annum pa ctc_unit in_days numbers number numeric value only digits').split(' '));
const SAME = {
  salary: 'ctc', compensation: 'ctc', package: 'ctc', pay: 'ctc', remuneration: 'ctc',
  yrs: 'years', yr: 'years', year: 'years',
  exp: 'experience', experienced: 'experience', expertise: 'experience',
  'reactjs': 'react', 'react.js': 'react', 'nodejs': 'node', 'node.js': 'node', 'vuejs': 'vue', 'vue.js': 'vue',
  'nextjs': 'next', 'next.js': 'next', 'expressjs': 'express', 'express.js': 'express',
  js: 'javascript', ts: 'typescript', golang: 'go',
  relocation: 'relocate', relocating: 'relocate', relocated: 'relocate',
  located: 'location', city: 'location', based: 'location',
  degree: 'qualification', education: 'qualification',
  currently: 'current', presently: 'current', present: 'current',
  month: 'months', mos: 'months', days: 'days', joining: 'join', join: 'join',
  dont: 'not', don: 'not', cannot: 'not', cant: 'not', never: 'never',
};
function meaningTokens(text) {
  const t = matchable(String(text || '').replace(/\byes\s*\/\s*no\b/gi, ' '));
  const out = new Set();
  for (const raw of t.split(' ')) {
    if (!raw || raw === 't' || raw === 's') continue;   // the halves of "don't", "it's"
    const w = SAME[raw] || raw;
    if (!FILLER.has(w)) out.add(w);
  }
  return out;
}
/** Two texts ask the same thing: their meaning words are identical. */
const meaningKey = (text) => [...meaningTokens(text)].sort().join(' ');

// A rule's pattern may list alternatives: "current ctc|current salary".
const alternatives = (pattern) => String(pattern || '').split('|').map(matchable).filter(Boolean);

// Substitute {{placeholders}}. Returns { text, missing[] } — `missing` names the
// placeholders that resolved to nothing, which makes the rule unusable rather
// than merely imperfect.
function fillPlaceholders(answer, profile = {}) {
  const missing = [];
  const text = String(answer == null ? '' : answer).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => {
    const get = PLACEHOLDERS[key];
    if (!get) { missing.push(key); return whole; }
    const value = get(profile);
    if (value == null || value === '') { missing.push(key); return whole; }
    return String(value);
  });
  return { text, missing };
}

// Match `question` against the answer bank. First enabled rule with an
// alternative that is a substring of the question wins — order is the user's,
// set by dragging rows, so this must not sort or score. Both sides go through
// matchable(), so punctuation and spacing never decide a match.
//
// Returns:
//   { matched: true,  rule, index, answer, kind }
//   { matched: false, reason: 'no-rule' | 'unresolved-placeholders', missing[] }
function resolveAnswer(question, config = {}) {
  const q = matchable(question);
  if (!q) return { matched: false, reason: 'no-rule', question: '' };

  const rules = Array.isArray(config.answers) ? config.answers : [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || rule.enabled === false) continue;
    if (!alternatives(rule.pattern).some(alt => q.includes(alt))) continue;

    const { text, missing } = fillPlaceholders(rule.answer, config.profile || {});
    // A rule that quotes a profile field you haven't filled in is worse than no
    // rule: it would type "{{expectedCtcLpa}}" into a recruiter's form.
    if (missing.length) {
      return { matched: false, reason: 'unresolved-placeholders', missing, rule, index: i, question };
    }
    return { matched: true, rule, index: i, answer: text, kind: rule.kind || 'text', question };
  }

  // No rule contains it word for word. A rule written for the same question
  // in other words still answers it: the meaning words must be identical
  // (meaningKey), never merely similar — similar is only ever a suggestion
  // (similarRules), shown under Needs answer for you to accept.
  const key = meaningKey(question);
  if (key) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule || rule.enabled === false) continue;
      const alt = String(rule.pattern || '').split('|').find(a => meaningKey(a) === key);
      if (!alt) continue;
      const { text, missing } = fillPlaceholders(rule.answer, config.profile || {});
      if (missing.length) continue;
      return { matched: true, rule, index: i, answer: text, kind: rule.kind || 'text', question, via: 'reworded', similarTo: alt.trim() };
    }
  }

  return { matched: false, reason: 'no-rule', question };
}

// Rules that are CLOSE to `question` without asking the same thing — offered
// under Needs answer as "you answered something like this", never used on
// their own. Jaccard overlap of meaning words, at least `min`, best first;
// a rule must share a word that is not generic ("years", "experience").
const GENERIC = new Set(['years', 'experience', 'current', 'months', 'days', 'not', 'no']);
function similarRules(question, config = {}, { min = 0.5, max = 3 } = {}) {
  const q = meaningTokens(question);
  if (!q.size) return [];
  const out = [];
  const rules = Array.isArray(config.answers) ? config.answers : [];
  rules.forEach((rule, i) => {
    if (!rule || rule.enabled === false) return;
    let best = null;
    for (const alt of String(rule.pattern || '').split('|')) {
      const r = meaningTokens(alt);
      if (!r.size) continue;
      const shared = [...r].filter(w => q.has(w));
      if (!shared.some(w => !GENERIC.has(w))) continue;
      const score = shared.length / new Set([...q, ...r]).size;
      if (score >= min && score < 1 && (!best || score > best.score)) best = { alt: alt.trim(), score };
    }
    if (!best) return;
    const { text, missing } = fillPlaceholders(rule.answer, config.profile || {});
    if (missing.length || !text.trim()) return;
    out.push({ pattern: best.alt, answer: text, score: Math.round(best.score * 100), index: i });
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, max);
}

// Should the worker apply to a job whose questions it could not fully answer?
// Honours config.onUnknownQuestion, which defaults to 'skip' and should stay
// that way.
function shouldSkipOnUnknown(config = {}) {
  return (config.onUnknownQuestion || 'skip') !== 'apply-anyway';
}

// ── choosing an option ──────────────────────────────────────────────────────
// A radio or checkbox question offers labels; the answer bank gives a value.
// The old rule was "first label that CONTAINS the value", under which "No"
// picked "Not applicable" and "3" picked "13 years". In order, and stopping at
// the first rule that gives exactly one option:
//   1. the label IS the value (ignoring case and punctuation)
//   2. for a number, the label's range holds it: "3-5 years", "5+", "less than 2"
//   3. every word of the value appears as a whole word in the label
// Two candidates at any step is ambiguity, and ambiguity returns null — the job
// is skipped and the question surfaces, rather than a guess being sent.

function numericRange(label) {
  // norm, not matchable: the hyphen in "3-5" is the range.
  const t = norm(label);
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = t.match(/(?:less than|below|under|upto|up to)\s*(\d+(?:\.\d+)?)/);
  if (m) return [-Infinity, Number(m[1]) - 1e-9];
  m = t.match(/(?:more than|above|over)\s*(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]) + 1e-9, Infinity];
  m = t.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (m) return [Number(m[1]), Infinity];
  const nums = t.match(/\d+(?:\.\d+)?/g);
  if (nums && nums.length === 1) return [Number(nums[0]), Number(nums[0])];
  return null;
}

function pickOption(value, options = []) {
  const labels = (options || []).map(o => String(o || '').trim()).filter(Boolean);
  const v = matchable(value);
  if (!v || !labels.length) return null;
  const only = (hits) => (hits.length === 1 ? hits[0] : null);

  const exact = labels.filter(l => matchable(l) === v);
  if (exact.length) return only(exact);

  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    const inRange = labels.filter((l) => {
      const r = numericRange(l);
      return r && n >= r[0] && n <= r[1];
    });
    // A number is only ever matched by range. Falling through to word matching
    // would let "3" pick "3 months notice" for a years question.
    return only(inRange);
  }

  const words = v.split(' ');
  const whole = labels.filter((l) => {
    const tokens = new Set(matchable(l).split(' '));
    return words.every(w => tokens.has(w));
  });
  return only(whole);
}

// ── starter rules ───────────────────────────────────────────────────────────
// The questions nearly every Naukri form asks, answered from your profile. Added
// only when you press "Add common rules" — never silently — and each one quotes
// a profile field, so a field you have not filled in leaves its rule unusable
// (and the job skipped) rather than typing a placeholder into a form.
//
// Patterns are deliberately narrow: "total experience", not "years of
// experience", because "years of experience in React" is a different question
// with a different answer.
const STARTER_RULES = [
  { pattern: 'notice period|serving notice', answer: '{{noticePeriodDays}}', kind: 'number' },
  { pattern: 'current ctc|current salary|current annual|current compensation', answer: '{{currentCtcLpa}}', kind: 'number' },
  { pattern: 'expected ctc|expected salary|expected annual|expected compensation', answer: '{{expectedCtcLpa}}', kind: 'number' },
  { pattern: 'total experience|total years of experience|overall experience|total work experience', answer: '{{totalExperienceYears}}', kind: 'number' },
  { pattern: 'current location|currently located|where are you based|current city', answer: '{{currentLocation}}', kind: 'text' },
  { pattern: 'relocate|relocation', answer: '{{willingToRelocate}}', kind: 'yesno' },
  { pattern: 'highest qualification|highest education|highest degree', answer: '{{highestQualification}}', kind: 'text' },
  { pattern: 'current company|current employer|currently working at', answer: '{{currentCompany}}', kind: 'text' },
  { pattern: 'current designation|current role|current job title', answer: '{{currentDesignation}}', kind: 'text' },
  // Off until you switch it on: "are you comfortable with night shifts?" is a
  // real question, and Yes is not a safe default for every one of them.
  { pattern: 'are you comfortable|are you okay with|are you ok with', answer: 'Yes', kind: 'yesno', enabled: false },
];

module.exports = {
  resolveAnswer, fillPlaceholders, shouldSkipOnUnknown, pickOption, numericRange, matchable,
  meaningKey, similarRules,
  PLACEHOLDERS, STARTER_RULES,
};
