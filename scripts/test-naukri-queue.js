// Proves lib/naukriQueue.js (apply-early order, inbox tidy rules, reading
// Naukri's application statuses) and lib/naukriProfile.js's checks.
// Run with:  node scripts/test-naukri-queue.js — pure, no database, no network.

const { queueOrder, tidyReason, readStatus, ageDays } = require('../lib/naukriQueue');
const { parseProfile } = require('../lib/naukriProfile');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const now = new Date('2026-10-18T12:00:00Z');

console.log('\nageDays');
eq('from the posting date when there is one', Math.round(ageDays({ postedAt: '2026-10-15T12:00:00Z' }, now)), 3);
eq('from "N days ago", plus the time since we saw it', Math.round(ageDays({ postedText: '2 days ago', lastSeenAt: '2026-10-16T12:00:00Z' }, now)), 4);
eq('unknown stays unknown', ageDays({}, now), null);

console.log('\napply early: queueOrder');
const jobs = [
  { id: 'old-great', postedText: '20 days ago', lastSeenAt: now, score: 95, approvedAt: '2026-10-01' },
  { id: 'today-ok', postedText: 'Just now', lastSeenAt: now, score: 60, approvedAt: '2026-10-18' },
  { id: 'today-best', postedAt: '2026-10-18T06:00:00Z', score: 88 },
  { id: 'picked-old', postedText: '30+ days ago', lastSeenAt: now, priority: 1 },
  { id: 'week', postedText: '5 days ago', lastSeenAt: now, score: 99 },
  { id: 'unknown', score: 99 },
];
eq('picked first, then fresh by fit, then this week, then older, then unknown age',
  queueOrder(jobs, now).map(j => j.id), ['picked-old', 'today-best', 'today-ok', 'week', 'old-great', 'unknown']);
eq('same band and score: the longest-waiting approval first',
  queueOrder([{ id: 'b', score: 70, approvedAt: '2026-10-17' }, { id: 'a', score: 70, approvedAt: '2026-10-10' }], now).map(j => j.id), ['a', 'b']);

console.log('\ninbox tidy: tidyReason');
const rules = { enabled: true, maxAgeDays: 21, minScore: 40, companySite: true };
eq('too old', tidyReason({ postedText: '30+ days ago', lastSeenAt: now, score: 80 }, rules, now), 'posted 30 days ago');
eq('poor fit', tidyReason({ postedText: '1 day ago', lastSeenAt: now, score: 30 }, rules, now), 'fit 30, below 40');
eq('company site (when asked)', tidyReason({ postedText: '1 day ago', lastSeenAt: now, score: 80, likelyExternal: true }, rules, now), 'applies on the company site');
eq('a good fresh job stays', tidyReason({ postedText: '1 day ago', lastSeenAt: now, score: 80 }, rules, now), null);
eq('unscored is not "poor fit"', tidyReason({ postedText: '1 day ago', lastSeenAt: now, score: null }, rules, now), null);
eq('off → nothing tidied', tidyReason({ postedText: '90 days ago', lastSeenAt: now, score: 1 }, { ...rules, enabled: false }, now), null);
eq('a restored job is never tidied again', tidyReason({ postedText: '90 days ago', lastSeenAt: now, score: 1, tidyExempt: true }, rules, now), null);

console.log('\ntrack replies: readStatus');
const st = (id, value, at = '2026-10-16 09:20:22') => ({ statusId: id, statusValue: value, dateTime: at });
eq('sent only → applied', readStatus({ status: [st(1, 'Applied'), st(2, 'Application Sent')] }).stage, 'applied');
eq('resume viewed → viewed', readStatus({ status: [st(1, 'Applied'), st(10, 'Resume Viewed')] }).stage, 'viewed');
eq('shortlisted beats viewed', readStatus({ status: [st(4, 'Application Viewed'), st(6, 'Shortlisted')] }).stage, 'shortlisted');
eq('contacted is the furthest', readStatus({ status: [st(6, 'Shortlisted'), st(9, 'Contacted By Email')] }).stage, 'contacted');
eq('not shortlisted after viewed', readStatus({ status: [st(4, 'Application Viewed'), st(7, 'Not Shortlisted', '2026-10-17 10:00:00')] }),
  { stage: 'not-shortlisted', at: '2026-10-17 10:00:00', timeline: [{ id: 4, value: 'Application Viewed', at: '2026-10-16 09:20:22' }, { id: 7, value: 'Not Shortlisted', at: '2026-10-17 10:00:00' }] });
eq('an unknown status is kept but does not move the stage', readStatus({ status: [st(1, 'Applied'), st(42, 'Something New')] }).stage, 'applied');

console.log('\nprofile from resume: parseProfile');
const resume = 'Asha Verma, Bengaluru. Senior Backend Engineer, Acme Payments (Jan 2021 – Present). Node.js, MongoDB, AWS. B.Tech Computer Science, NIT Trichy';
const got = parseProfile(JSON.stringify({ skills: ['Node.js', 'MongoDB', 'Kubernetes', 'aws', 'AWS'], totalExperienceMonths: 69,
  currentDesignation: 'Senior Backend Engineer', currentCompany: 'Acme Payments', currentLocation: 'Pune', highestQualification: 'B.Tech Computer Science' }), resume);
eq('only skills the resume names, no duplicates', got.skills, ['Node.js', 'MongoDB', 'aws']);
eq('experience kept', got.totalExperienceMonths, 69);
eq('a location the resume does not mention is dropped', got.currentLocation, '');
eq('role and company kept', [got.currentDesignation, got.currentCompany], ['Senior Backend Engineer', 'Acme Payments']);
eq('nonsense experience → null', parseProfile('{"skills":[],"totalExperienceMonths":-3}', resume).totalExperienceMonths, null);
eq('junk → null', parseProfile('no json here', resume), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
