// How good a fit is a harvested Naukri job? 0–100, with the reasons.
//
// Pure and dependency-light, like naukriFilters.js beside it: /ingest scores
// every row it stores, the inbox sorts by it, and auto-approve gates on it.
// Filters decide whether a job is SHOWN; this decides how high, and whether it
// can skip the queue entirely. Every weight is in WEIGHTS so tuning is one edit.
//
// Missing information is neutral, never a penalty: most of Naukri hides pay and
// many profiles have no skills list, and scoring those as zero would sink good
// jobs for what the listing did not say.

const { matchable } = require('./naukriAnswers');
const { parseSalaryLpa, parsePostedAgeDays } = require('./naukriFilters');

const WEIGHTS = {
  title: 35,        // title shares the words of a search you set up
  skills: 30,       // your skills appear in the tags / description
  skillsFull: 5,    // matched skills for full marks
  experience: 15,   // the job's band holds your years
  fresh: 10,        // posted recently
  salary: 10,       // pay at or above what you expect
  external: -25,    // employer seen sending applicants to its own site
};

// Words that say nothing about the role and would make every title "match".
const STOP = new Set(['and', 'or', 'of', 'in', 'the', 'for', 'a', 'an', 'to', 'with', 'jobs', 'job', 'at', 'remote']);

const words = (s) => matchable(s).split(' ').filter(w => w && !STOP.has(w));
const hasWord = (haystack, phrase) => {
  const p = matchable(phrase);
  return !!p && ` ${haystack} `.includes(` ${p} `);
};

function titleFit(job, config) {
  const title = ` ${matchable(job.title)} `;
  const terms = [
    ...(config.searches || []).filter(s => s && s.enabled !== false).map(s => s.keywords || s.label),
    ...((config.filters && config.filters.titleInclude) || []),
  ].filter(Boolean);
  if (!terms.length) return { points: Math.round(WEIGHTS.title / 2), reason: null };

  let best = 0, bestTerm = '';
  for (const term of terms) {
    const w = words(term);
    if (!w.length) continue;
    const hit = w.filter(x => title.includes(` ${x} `)).length / w.length;
    if (hit > best) { best = hit; bestTerm = term; }
  }
  const points = Math.round(WEIGHTS.title * best);
  // Naukri picked a recommended job from your profile, not from your search
  // words, so a title that shares none of them is not evidence against it.
  // Half credit as a floor; skills and experience decide the rest.
  // A recruiter on the site reached out about this one (Instahyre's
  // recruiter-initiated interest): full title credit — a person already
  // decided you fit it.
  const site = job.platformLabel || 'Naukri';
  if ((job.origins || []).includes('recruiter') && best < 1) {
    return { points: WEIGHTS.title, reason: `A recruiter on ${site} picked you for this` };
  }
  const recommended = (job.origins || []).includes('recommended');
  if (recommended && best < 0.5) {
    return { points: Math.round(WEIGHTS.title / 2), reason: `Recommended by ${site} for your profile` };
  }
  if (best >= 1) return { points, reason: `Title matches your search "${bestTerm}"` };
  if (best > 0) return { points, reason: `Title partly matches "${bestTerm}"` };
  return { points: 0, reason: 'Title shares no words with your searches' };
}

function skillsFit(job, config) {
  const skills = ((config.profile && config.profile.skills) || []).filter(Boolean);
  if (!skills.length) return { points: Math.round(WEIGHTS.skills / 2), reason: null };
  const haystack = matchable([job.title, ...(job.tags || []), job.description].join(' '));
  const hits = skills.filter(s => hasWord(haystack, s));
  const points = Math.round(WEIGHTS.skills * Math.min(1, hits.length / WEIGHTS.skillsFull));
  if (!hits.length) return { points: 0, reason: 'None of your skills are mentioned' };
  const shown = hits.slice(0, 4).join(', ') + (hits.length > 4 ? ` +${hits.length - 4}` : '');
  return { points, reason: `${hits.length} of your skills: ${shown}` };
}

function experienceFit(job, config) {
  const months = config.profile && config.profile.totalExperienceMonths;
  const f = config.filters || {};
  // Your years: the profile if filled in, else the middle of your filter band.
  let years = months != null ? months / 12 : null;
  if (years == null && f.minExperienceYears != null && f.maxExperienceYears != null) {
    years = (f.minExperienceYears + f.maxExperienceYears) / 2;
  }
  const lo = job.experienceMin, hi = job.experienceMax;
  if (years == null || (lo == null && hi == null)) return { points: Math.round(WEIGHTS.experience / 2), reason: null };
  const min = lo == null ? -Infinity : lo;
  const max = hi == null ? Infinity : hi;
  if (years >= min && years <= max) return { points: WEIGHTS.experience, reason: `Your ${Math.floor(years)} yrs fit their ${lo ?? 0}–${hi ?? '+'}` };
  const off = years < min ? min - years : years - max;
  if (off <= 1) return { points: Math.round(WEIGHTS.experience / 2), reason: `Experience just outside their ${lo ?? 0}–${hi ?? '+'} yrs` };
  return { points: 0, reason: `Asks ${lo ?? 0}–${hi ?? '+'} yrs; you have ${Math.floor(years)}` };
}

function freshness(job) {
  const age = parsePostedAgeDays(job.postedText);
  if (age == null) return { points: Math.round(WEIGHTS.fresh / 2), reason: null };
  if (age <= 3) return { points: WEIGHTS.fresh, reason: 'Posted in the last 3 days' };
  if (age <= 7) return { points: Math.round(WEIGHTS.fresh * 0.7), reason: 'Posted this week' };
  if (age <= 14) return { points: Math.round(WEIGHTS.fresh * 0.4), reason: null };
  return { points: 0, reason: `Posted ${age} days ago` };
}

function salaryFit(job, config) {
  const want = (config.profile && config.profile.expectedCtcLpa) ?? (config.filters && config.filters.minSalaryLpa);
  const lpa = parseSalaryLpa(job.salaryText);
  if (want == null || lpa == null) return { points: Math.round(WEIGHTS.salary / 2), reason: null };
  if (lpa >= want) return { points: WEIGHTS.salary, reason: `Pay from ${lpa} LPA` };
  return { points: 0, reason: `Pay from ${lpa} LPA, below your ${want}` };
}

// { score: 0–100, reasons: string[] } — reasons best-first, neutral parts left out.
function scoreJob(job = {}, config = {}) {
  const parts = [titleFit(job, config), skillsFit(job, config), experienceFit(job, config), freshness(job), salaryFit(job, config)];
  let score = parts.reduce((a, p) => a + p.points, 0);
  const reasons = parts.filter(p => p.reason).sort((a, b) => b.points - a.points).map(p => p.reason);
  if (job.likelyExternal) {
    score += WEIGHTS.external;
    reasons.push('Employer usually applies on its own site');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

module.exports = { scoreJob, WEIGHTS };
