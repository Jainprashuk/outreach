// Proves Discover's "Worth searching" scoring (lib/discovery/companyWorth.js), the
// job-title → roles mapping (lib/discovery/jobRoles.js), and that pulling the merge
// out of lib/discovery/hiringCompanies.js left Hiring now's output unchanged.
// Run with:  node scripts/test-company-worth.js
//
// No database and no network: the models' find/aggregate are stubbed for the parity
// check, and the scorer is pure.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');

const { WEIGHTS, RULES, scoreCompanies, pickSuggestions, pickCandidates, topFitThreshold } = require('../lib/discovery/companyWorth');
const { rolesForJob } = require('../lib/discovery/jobRoles');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-11T10:00:00Z');
const daysAgo = (d) => new Date(now.getTime() - d * DAY);
let seq = 0;
const id = () => new mongoose.Types.ObjectId();

const lead = (email, extra = {}) => ({ _id: id(), email, company: '', createdAt: daysAgo(3), postUrl: `https://linkedin.com/p/${++seq}`, fitScore: 0, ...extra });
const job = (company, extra = {}) => ({ _id: id(), company, title: `Backend Engineer ${++seq}`, createdAt: daysAgo(3), postedAt: daysAgo(3), approval: 'pending', applyStatus: 'none', ...extra });
const contact = (email, extra = {}) => ({ email, company: '', status: 'sent', replyCategory: null, repliedAt: null, lastSentAt: daysAgo(10), bounceReason: null, ...extra });
const score = (data) => scoreCompanies({ leads: [], naukri: [], contacts: [], ...data }, { now });
const row = (rows, key) => rows.find(r => r.key === key);

// ─────────────────────────────────────────────── jobRoles
console.log('\nrolesForJob');
eq('backend engineer', rolesForJob('Senior Backend Engineer (Node.js)'), ['recruiter', 'talent acquisition', 'hr', 'engineering manager', 'cto']);
eq('data before engineering', rolesForJob('Data Engineer'), ['recruiter', 'talent acquisition', 'hr', 'head of data', 'data engineering manager']);
eq('product manager', rolesForJob('Product Manager - Payments'), ['recruiter', 'talent acquisition', 'hr', 'head of product', 'product director']);
eq('unknown title → recruiters only', rolesForJob('Office Coordinator'), ['recruiter', 'talent acquisition', 'hr']);
eq('empty title', rolesForJob(''), ['recruiter', 'talent acquisition', 'hr']);
ok('never more than 5', rolesForJob('Full Stack React Developer').length <= 5);

// ─────────────────────────────────────────────── signals
console.log('\nsignals');
{
  const r = row(score({
    leads: [lead('a@acme.in')],
    contacts: [contact('x@acme.in', { replyCategory: 'reviewing', repliedAt: daysAgo(5) }), contact('y@acme.in', { replyCategory: 'resume-requested', repliedAt: daysAgo(4) }), contact('z@acme.in', { replyCategory: 'reviewing', repliedAt: daysAgo(4) })],
  }), 'd:acme.in');
  const reply = r.reasons.find(x => /reviewing/.test(x.text));
  eq('positive replies are capped', reply.points, WEIGHTS.replyPositiveCap);
  ok('a reply makes the format known', r.reasons.some(x => x.points === WEIGHTS.knownFormat));
}
{
  const r = row(score({ leads: [lead('a@acme.in')], contacts: [contact('x@acme.in', { replyCategory: 'stay-in-touch', repliedAt: daysAgo(5) })] }), 'd:acme.in');
  ok('stay-in-touch', r.reasons.some(x => x.points === WEIGHTS.replyStayInTouch));
}
{
  const r = row(score({ naukri: [job('Acme Corp', { applyStatus: 'in-review' }), job('Acme Corp', { applyStatus: 'applied' })] }), 'n:acme');
  ok('in review beats applied (not both)', r.reasons.some(x => x.points === WEIGHTS.naukriInReview) && !r.reasons.some(x => /You applied/.test(x.text)));
  ok('roles come from the job in review', Array.isArray(r.roles) && r.roles.includes('engineering manager'));
  ok('naukriJobId is the job in review', !!r.naukriJobId);
  ok('Naukri-only company needs a domain', r.needsDomain === true && r.domain === null);
}
{
  const r = row(score({ naukri: [job('Acme', { applyStatus: 'applied' })] }), 'n:acme');
  ok('applied', r.reasons.some(x => x.points === WEIGHTS.applied));
}
{
  const r = row(score({ naukri: [job('Acme', { approval: 'approved' }), job('Acme', { approval: 'approved' })] }), 'n:acme');
  ok('approved, counted once', r.reasons.filter(x => /You approved/.test(x.text)).length === 1 && r.reasons.some(x => /approved 2 Naukri jobs/.test(x.text) && x.points === WEIGHTS.approved));
}
{
  const r = row(score({ naukri: [job('Acme', { approval: 'rejected' })] }), 'n:acme');
  ok('rejected by you', r.reasons.some(x => x.points === WEIGHTS.jobsRejectedByYou));
  const r2 = row(score({ naukri: [job('Acme', { applyStatus: 'rejected', approval: 'approved' })] }), 'n:acme');
  ok('application rejected', r2.reasons.some(x => x.points === WEIGHTS.applicationRejected));
}
{
  const r = row(score({ naukri: [job('Acme')], interviews: [{ company: 'ACME Pvt Ltd', status: 'scheduled' }] }), 'n:acme');
  ok('interview matched by name', r.reasons.some(x => x.points === WEIGHTS.interview));
  const r2 = row(score({ naukri: [job('Acme')], interviews: [{ company: 'Acme', status: 'rejected' }] }), 'n:acme');
  ok('finished interview ignored', !r2.reasons.some(x => x.points === WEIGHTS.interview));
}
{
  const two = row(score({ leads: [lead('a@acme.in'), lead('b@acme.in')] }), 'd:acme.in');
  ok('momentum ≥2', two.reasons.some(x => x.points === WEIGHTS.momentum2));
  const samePost = row(score({ leads: [lead('a@acme.in', { postUrl: 'p1' }), lead('b@acme.in', { postUrl: 'p1' })] }), 'd:acme.in');
  ok('two emails on one post are one post', !samePost.reasons.some(x => x.points === WEIGHTS.momentum2));
  const four = row(score({ leads: [lead('a@acme.in'), lead('b@acme.in'), lead('c@acme.in'), lead('d@acme.in')] }), 'd:acme.in');
  ok('momentum ≥4', four.reasons.some(x => x.points === WEIGHTS.momentum4));
  const old = row(score({ leads: [lead('a@acme.in', { createdAt: daysAgo(20) }), lead('b@acme.in', { createdAt: daysAgo(20) })] }), 'd:acme.in');
  ok('older than two weeks: no momentum', !old.reasons.some(x => /two weeks/.test(x.text)));
}
{
  eq('fit threshold: too few', topFitThreshold([{ fitScore: 9 }]), null);
  eq('fit threshold: 75th percentile', topFitThreshold([1, 2, 3, 4, 5, 6, 7, 8].map(f => ({ fitScore: f }))), 7);
  const leads = [lead('a@low.in', { fitScore: 1 }), lead('a@mid.in', { fitScore: 2 }), lead('a@mid2.in', { fitScore: 3 }), lead('a@top.in', { fitScore: 9 })];
  const rows = score({ leads });
  ok('top fit', row(rows, 'd:top.in').reasons.some(x => x.points === WEIGHTS.topFit));
  ok('not top fit', !row(rows, 'd:low.in').reasons.some(x => x.points === WEIGHTS.topFit));
}
{
  const r = row(score({ leads: [lead('a@acme.in')], contacts: [1, 2, 3].map(n => contact(`p${n}@acme.in`, { lastSentAt: daysAgo(30) })) }), 'd:acme.in');
  ok('already tried', r.reasons.some(x => x.points === WEIGHTS.alreadyTried));
  const fresh = row(score({ leads: [lead('a@acme.in')], contacts: [1, 2, 3].map(n => contact(`p${n}@acme.in`, { lastSentAt: daysAgo(5) })) }), 'd:acme.in');
  ok('not tried yet when sends are recent', !fresh.reasons.some(x => x.points === WEIGHTS.alreadyTried));
}
{
  const bounced = [1, 2, 3].map(n => contact(`p${n}@acme.in`, { status: 'bounced', bounceReason: '550 5.1.1 user unknown', lastSentAt: daysAgo(30) }));
  const r = row(score({ leads: [lead('a@acme.in')], contacts: [...bounced, contact('q@acme.in')] }), 'd:acme.in');
  ok('bouncy and format unknown', r.reasons.some(x => x.points === WEIGHTS.bouncy));
  const r2 = row(score({ leads: [lead('a@acme.in')], contacts: bounced, patterns: [{ domain: 'acme.in', samples: 3 }] }), 'd:acme.in');
  ok('bouncy but format known → no penalty', !r2.reasons.some(x => x.points === WEIGHTS.bouncy) && r2.reasons.some(x => x.points === WEIGHTS.knownFormat));
}
{
  // A Naukri company you've emailed before is tied to its domain through your contacts.
  const r = row(score({ naukri: [job('Acme Technologies')], contacts: [contact('x@acme.in', { company: 'Acme', replyCategory: 'reviewing', repliedAt: daysAgo(3) })] }), 'n:acme');
  eq('Naukri name → domain from contacts', r.domain, 'acme.in');
  ok('and gets that domain\'s replies', r.reasons.some(x => /reviewing/.test(x.text)));
}

// ─────────────────────────────────────────────── leave-outs
console.log('\nleave-outs');
{
  const base = { leads: [lead('a@acme.in')] };
  eq('said no recently', row(score({ ...base, contacts: [contact('x@acme.in', { replyCategory: 'no', repliedAt: daysAgo(10) })] }), 'd:acme.in').excluded, 'said-no');
  eq('said no long ago is fine', row(score({ ...base, contacts: [contact('x@acme.in', { replyCategory: 'no', repliedAt: daysAgo(200) })] }), 'd:acme.in').excluded, null);
  eq('blocked domain', row(score({ ...base, blockedDomains: new Set(['acme.in']) }), 'd:acme.in').excluded, 'blocked');
  eq('searched recently', row(score({ ...base, searches: [{ domain: 'acme.in', createdAt: daysAgo(5) }] }), 'd:acme.in').excluded, 'searched');
  eq('searched long ago is fine', row(score({ ...base, searches: [{ domain: 'acme.in', createdAt: daysAgo(60) }] }), 'd:acme.in').excluded, null);
  eq('dismissed', row(score({ ...base, dismissals: [{ key: 'd:acme.in', until: daysAgo(-10) }] }), 'd:acme.in').excluded, 'dismissed');
  eq('dismissal expired', row(score({ ...base, dismissals: [{ key: 'd:acme.in', until: daysAgo(1) }] }), 'd:acme.in').excluded, null);
  eq('offer', row(score({ naukri: [job('Acme', { applyStatus: 'offer' })] }), 'n:acme').excluded, 'offer');
  ok('free-mail leads never become companies', !score({ leads: [lead('a@gmail.com')] }).length);
}

// ─────────────────────────────────────────────── outside signals
console.log('\noutside signals');
{
  const data = { naukri: [job('Acme', { applyStatus: 'applied' })] };
  const signals = [
    { key: 'n:acme', source: 'news', status: 'ok', points: 3, reasons: [{ text: 'Raised funding: "Acme raises $10M"', url: 'https://x' }] },
    { key: 'n:acme', source: 'hn', status: 'error', points: 2, reasons: [], note: 'HN check unavailable' },
    { key: 'n:acme', source: 'github', status: 'skipped', points: 0, note: 'no domain yet' },
  ];
  const r = row(score({ ...data, signals }), 'n:acme');
  eq('ok signal adds, error adds 0', r.score, WEIGHTS.applied + 3);
  eq('base is the app\'s own signals only', r.base, WEIGHTS.applied);
  ok('news reason keeps its link', r.reasons.some(x => x.kind === 'news' && x.url === 'https://x'));
  ok('failed source becomes a note', r.notes.includes('HN check unavailable'));
  const neg = row(score({ ...data, signals: [{ key: 'n:acme', source: 'news', status: 'ok', points: -4, reasons: [{ text: 'Layoffs reported' }] }] }), 'n:acme');
  eq('layoff news subtracts', neg.score, WEIGHTS.applied - 4);
}

// ─────────────────────────────────────────────── picking
console.log('\npicking');
{
  const leads = [];
  for (let i = 0; i < 15; i++) for (let k = 0; k < 4; k++) leads.push(lead(`p${k}@c${i}.in`));
  const contacts = Array.from({ length: 15 }, (_, i) => contact(`x@c${i}.in`, { replyCategory: 'reviewing', repliedAt: daysAgo(2) }));
  const rows = score({ leads, contacts, searches: [{ domain: 'c0.in', createdAt: daysAgo(1) }] });
  const picked = pickSuggestions(rows);
  eq('at most maxShown', picked.length, RULES.maxShown);
  ok('excluded never picked', !picked.some(r => r.domain === 'c0.in'));
  ok('all at or above the bar', picked.every(r => r.score >= RULES.minScore));
  const weak = score({ leads: [lead('a@weak.in')] });
  eq('a single post is not worth a search', pickSuggestions(weak).length, 0);
  ok('candidates capped', pickCandidates(rows).length <= RULES.candidates);
  ok('candidates by base score', pickCandidates(rows).every(r => r.base >= RULES.candidateMin));
}

// ─────────────────────────────────────────────── Hiring now parity
console.log('\nHiring now parity (vs the code before the merge was extracted)');
(async () => {
  const tmp = path.join(__dirname, '..', 'lib', 'discovery', '.hiringCompanies.parity.js');
  try {
    fs.writeFileSync(tmp, execSync('git show 0006811:lib/discovery/hiringCompanies.js', { cwd: path.join(__dirname, '..') }));
    const Lead = require('../models/Lead');
    const NaukriJob = require('../models/NaukriJob');
    const ProspectSearch = require('../models/ProspectSearch');
    const Prospect = require('../models/Prospect');
    const leads = [lead('a@acme.in', { company: 'Acme Labs' }), lead('b@acme.in'), lead('c@zeta-corp.io'), lead('d@gmail.com'), lead('e@acme.in', { createdAt: daysAgo(1) })];
    const naukri = [job('Acme Labs.com'), job('Acme Labs'), job('Zeta Corp'), job('Orbit Pvt Ltd'), job('Orbit'), job('Nimbus Technologies', { postedAt: null })];
    Lead.find = () => ({ lean: async () => leads });
    NaukriJob.find = () => ({ lean: async () => naukri });
    ProspectSearch.aggregate = async () => [{ _id: 'acme.in', lastSearchAt: daysAgo(2) }];
    Prospect.aggregate = async () => [{ _id: 'acme.in', n: 7 }];

    const before = require(tmp).hiringCompanies;
    const after = require('../lib/discovery/hiringCompanies').hiringCompanies;
    const uid = id();
    for (const opts of [{}, { source: 'naukri' }, { q: 'acme' }, { hideSearched: true }, { limit: 2, page: 2 }]) {
      const a = await before(uid, { ...opts, now });
      const b = await after(uid, { ...opts, now });
      eq(`identical output ${JSON.stringify(opts)}`, b, a);
    }
  } catch (e) {
    fail++; console.log('  FAIL parity check crashed  << ' + e.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
