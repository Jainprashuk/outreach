// Deciding whether a harvested Naukri row is worth putting in front of you.
//
// Pure, and shared by the worker (which drops rows before they are ever stored)
// and by the Filters config card (which replays it against your last harvest to
// show "would have kept 18 of 47" before you commit to a change). One
// implementation, so the preview cannot disagree with the behaviour.
//
// Every rejection carries a reason string. A filter you can't see the effect of
// is a filter you stop trusting, and then you stop using the review queue.

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// Indian cities that Naukri and everyone else spell differently. Typing
// "Bangalore" and getting one result out of a hundred Bengaluru listings reads
// as a broken filter, not as a spelling lesson — so both names mean both.
// Grouped, not mapped one way, because you may type either.
const CITY_ALIASES = [
  ['bangalore', 'bengaluru'],
  ['gurgaon', 'gurugram'],
  ['bombay', 'mumbai'],
  ['calcutta', 'kolkata'],
  ['madras', 'chennai'],
  ['poona', 'pune'],
  ['trivandrum', 'thiruvananthapuram'],
  ['baroda', 'vadodara'],
  ['mysore', 'mysuru'],
  ['delhi', 'new delhi', 'ncr'],
];

// Every spelling of the place the user typed, including what they typed.
function cityVariants(input) {
  const v = norm(input);
  if (!v) return [];
  const group = CITY_ALIASES.find(g => g.some(name => v === name || v.includes(name)));
  return group ? [...new Set([v, ...group])] : [v];
}
const someIncludes = (haystack, needles) =>
  (needles || []).some((n) => norm(n) && haystack.includes(norm(n)));

// Naukri prints salary as free text ("8-12 Lacs PA", "Not disclosed"). Pull the
// LOWER bound in LPA, or null when the listing doesn't say. Null must never be
// treated as zero: "Not disclosed" is most of the board, and filtering it out by
// accident would empty your queue.
function parseSalaryLpa(text) {
  // Commas out first: Indian digit grouping means "1,00,000" would otherwise
  // read as 1, and "50,000" as 50 — both plausible LPA figures, so the mistake
  // would pass a filter silently rather than failing.
  const t = norm(text).replace(/,/g, '');
  if (!t || t.includes('not disclosed')) return null;
  const m = t.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // "50,000 - 1,00,000 PA" style monthly/annual rupee figures, not lacs.
  if (/lac|lakh|lpa/.test(t)) return n;
  if (n > 1000) return n / 100000;
  return n;
}

// "3 days ago" / "30+ days ago" / "Just now" -> age in days, or null.
function parsePostedAgeDays(text) {
  const t = norm(text);
  if (!t) return null;
  if (/just now|today|few hours|hours ago/.test(t)) return 0;
  const m = t.match(/(\d+)\s*\+?\s*(day|week|month)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'week') return n * 7;
  if (m[2] === 'month') return n * 30;
  return n;
}

// { keep: true } | { keep: false, reason: string }
function evaluateJob(job = {}, filters = {}) {
  const title = norm(job.title);
  const company = norm(job.company);
  const location = norm(job.location);

  if ((filters.titleInclude || []).length && !someIncludes(title, filters.titleInclude)) {
    return { keep: false, reason: 'title matched none of your include terms' };
  }
  if (someIncludes(title, filters.titleExclude)) {
    return { keep: false, reason: 'title matched an exclude term' };
  }
  if (someIncludes(company, filters.companyExclude)) {
    return { keep: false, reason: 'company is on your blocklist' };
  }

  if ((filters.locations || []).length) {
    const remoteOk = filters.remoteOnly !== true && /remote/.test(location);
    // Expanded through the alias table, so a config saying "Bangalore" still
    // matches the "Bengaluru" Naukri actually prints.
    const wanted = filters.locations.flatMap(cityVariants);
    if (!someIncludes(location, wanted) && !remoteOk) {
      return { keep: false, reason: 'location not in your list' };
    }
  }
  if (filters.remoteOnly && !/remote|work from home/.test(location)) {
    return { keep: false, reason: 'not remote' };
  }

  // Experience is a band on both sides. Keep the job when the two bands overlap
  // at all — a "3-8 Yrs" listing is a real match for someone with 4 years, and
  // requiring containment would throw away most of the board.
  const jobMin = job.experienceMin, jobMax = job.experienceMax;
  const wantMin = filters.minExperienceYears, wantMax = filters.maxExperienceYears;
  if (wantMax != null && jobMin != null && jobMin > wantMax) {
    return { keep: false, reason: `needs ${jobMin}+ yrs, above your ${wantMax}` };
  }
  if (wantMin != null && jobMax != null && jobMax < wantMin) {
    return { keep: false, reason: `tops out at ${jobMax} yrs, below your ${wantMin}` };
  }

  if (filters.minSalaryLpa != null) {
    const lpa = parseSalaryLpa(job.salaryText);
    // Undisclosed salary is kept. Most of Naukri doesn't publish pay, and
    // dropping those would be a filter that silently removes the good jobs too.
    if (lpa != null && lpa < filters.minSalaryLpa) {
      return { keep: false, reason: `pay from ${lpa} LPA, below your ${filters.minSalaryLpa}` };
    }
  }

  if (filters.maxPostedAgeDays != null) {
    const age = parsePostedAgeDays(job.postedText);
    if (age != null && age > filters.maxPostedAgeDays) {
      return { keep: false, reason: `posted ${age} days ago` };
    }
  }

  if (filters.skipAlreadyApplied && job.alreadyApplied) {
    return { keep: false, reason: 'already applied on Naukri' };
  }

  return { keep: true };
}

// Replay over a list. Returns { kept[], dropped[{job, reason}], counts }.
function applyFilters(jobs = [], filters = {}) {
  const kept = [], dropped = [];
  for (const job of jobs) {
    const verdict = evaluateJob(job, filters);
    if (verdict.keep) kept.push(job);
    else dropped.push({ job, reason: verdict.reason });
  }
  return { kept, dropped, counts: { total: jobs.length, kept: kept.length, dropped: dropped.length } };
}

module.exports = { evaluateJob, applyFilters, parseSalaryLpa, parsePostedAgeDays, cityVariants, CITY_ALIASES };
