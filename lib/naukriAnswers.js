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

// Match `question` against the answer bank. First enabled rule whose pattern is
// a substring of the question wins — order is the user's, set by dragging rows,
// so this must not sort or score.
//
// Returns:
//   { matched: true,  rule, index, answer, kind }
//   { matched: false, reason: 'no-rule' | 'unresolved-placeholders', missing[] }
function resolveAnswer(question, config = {}) {
  const q = norm(question);
  if (!q) return { matched: false, reason: 'no-rule', question: '' };

  const rules = Array.isArray(config.answers) ? config.answers : [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || rule.enabled === false) continue;
    const pattern = norm(rule.pattern);
    if (!pattern || !q.includes(pattern)) continue;

    const { text, missing } = fillPlaceholders(rule.answer, config.profile || {});
    // A rule that quotes a profile field you haven't filled in is worse than no
    // rule: it would type "{{expectedCtcLpa}}" into a recruiter's form.
    if (missing.length) {
      return { matched: false, reason: 'unresolved-placeholders', missing, rule, index: i, question };
    }
    return { matched: true, rule, index: i, answer: text, kind: rule.kind || 'text', question };
  }

  return { matched: false, reason: 'no-rule', question };
}

// Should the worker apply to a job whose questions it could not fully answer?
// Honours config.onUnknownQuestion, which defaults to 'skip' and should stay
// that way.
function shouldSkipOnUnknown(config = {}) {
  return (config.onUnknownQuestion || 'skip') !== 'apply-anyway';
}

module.exports = { resolveAnswer, fillPlaceholders, shouldSkipOnUnknown, PLACEHOLDERS };
