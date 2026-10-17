// Proves the Naukri fit score (lib/naukriScore.js) that sorts the inbox and
// gates auto-approve. Run with:  node scripts/test-naukri-score.js
//
// No database, no network — the scorer is pure.

const { scoreJob, WEIGHTS } = require('../lib/naukriScore');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

const config = {
  searches: [{ keywords: 'backend engineer', enabled: true }],
  filters: { titleInclude: [], minSalaryLpa: null },
  profile: { skills: ['node.js', 'mongodb', 'express', 'aws', 'docker'], totalExperienceMonths: 48, expectedCtcLpa: 15 },
};
const job = (extra = {}) => ({
  title: 'Backend Engineer', tags: ['Node.js', 'MongoDB', 'Express', 'AWS', 'Docker'],
  description: '', experienceMin: 3, experienceMax: 6, salaryText: '18-24 Lacs PA', postedText: '1 day ago',
  likelyExternal: false, ...extra,
});

console.log('\nscoreJob');
const best = scoreJob(job(), config);
ok('a perfect match scores 100', best.score === 100, `got ${best.score}`);
ok('reasons explain it', best.reasons.some(r => /search "backend engineer"/.test(r)) && best.reasons.some(r => /5 of your skills/.test(r)), best.reasons.join(' | '));

const external = scoreJob(job({ likelyExternal: true }), config);
ok('company-site employer loses 25', external.score === 100 + WEIGHTS.external, `got ${external.score}`);
ok('and says why', external.reasons.includes('Employer usually applies on its own site'));

const wrongTitle = scoreJob(job({ title: 'Sales Manager', tags: [] }), config);
ok('unrelated title and no skills scores low', wrongTitle.score < 50, `got ${wrongTitle.score}`);

const partial = scoreJob(job({ title: 'Senior Backend Developer' }), config);
ok('partial title match is between', partial.score > wrongTitle.score && partial.score < best.score, `got ${partial.score}`);

const undisclosed = scoreJob(job({ salaryText: 'Not disclosed' }), config);
ok('undisclosed pay is neutral, not zero', undisclosed.score === 100 - WEIGHTS.salary / 2, `got ${undisclosed.score}`);
const lowPay = scoreJob(job({ salaryText: '6-8 Lacs PA' }), config);
ok('pay below expected gets no salary points', lowPay.score === 100 - WEIGHTS.salary, `got ${lowPay.score}`);

const senior = scoreJob(job({ experienceMin: 10, experienceMax: 15 }), config);
ok('far-off experience band loses those points', senior.score === 100 - WEIGHTS.experience, `got ${senior.score}`);
const near = scoreJob(job({ experienceMin: 5, experienceMax: 8 }), config);
ok('one year off gets half', near.score === 100 - WEIGHTS.experience + Math.round(WEIGHTS.experience / 2), `got ${near.score}`);

const old = scoreJob(job({ postedText: '30+ days ago' }), config);
ok('a month-old post loses freshness', old.score === 100 - WEIGHTS.fresh, `got ${old.score}`);

const empty = scoreJob(job(), { searches: [], filters: {}, profile: {} });
ok('an empty profile is neutral, not punishing', empty.score >= 45 && empty.score <= 65, `got ${empty.score}`);

const skillWord = scoreJob(job({ tags: [], description: 'We use nodes and expressive APIs' }), config);
ok('skills match whole words only', skillWord.reasons.includes('None of your skills are mentioned'), skillWord.reasons.join(' | '));

const recOff = scoreJob(job({ title: 'Site Reliability Lead', origins: ['recommended'] }), config);
const searchOff = scoreJob(job({ title: 'Site Reliability Lead', origins: ['search'] }), config);
ok('recommended job with an off-search title keeps half the title points', recOff.score === searchOff.score + Math.round(WEIGHTS.title / 2), `${recOff.score} vs ${searchOff.score}`);
ok('and says why', recOff.reasons.includes('Recommended by Naukri for your profile'));
ok('a recommended job matching your search scores as a match', scoreJob(job({ origins: ['recommended'] }), config).score === 100);

ok('score is clamped to 0..100', [best, external, wrongTitle, empty].every(r => r.score >= 0 && r.score <= 100));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
