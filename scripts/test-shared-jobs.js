#!/usr/bin/env node
/**
 * Jobs "Everyone" view test (lib/sharedJobs.js, routes/sharedJobs.js). DEV DATABASE ONLY.
 * Scratch users and rows, all removed at the end.
 *   node scripts/test-shared-jobs.js
 *
 * Asserts the promise: only the JOB leaves (exact allowlisted keys, none of the planted
 * approval/apply/score/notes/recruiters), opted-out and disabled accounts never
 * contribute, the same job in two accounts is one row, "mine" marks the viewer's
 * own, stale listings drop out, and adding writes only into the viewer's account,
 * pending, never approved.
 */
require('dotenv').config();
process.noDeprecation = true;
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run with NODE_ENV=prod'); process.exit(1); }
const URI = process.env.MONGODB_URI_DEV;
if (!URI) { console.error('MONGODB_URI_DEV is not set'); process.exit(1); }
const express = require('express');
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c || !d ? '' : '  << ' + d)); };
const tag = `sj${Date.now()}`;

(async () => {
  await mongoose.connect(URI);
  const User = require('../models/User');
  const NaukriJob = require('../models/NaukriJob');
  const { canSeeLibrary } = require('../lib/requireLibraryAccess');
  const mk = (n, extra = {}) => User.create({ email: `${tag}-${n}@example.test`, name: `T ${n}`, ...extra });
  const [a, b, optedOut, disabled] = await Promise.all([mk('a'), mk('b'), mk('c', { libraryOptOut: true }), mk('d', { status: 'disabled' })]);
  const ids = [a, b, optedOut, disabled].map(u => u._id);

  const app = express();
  app.use(express.json());
  let who = a._id;
  app.use((req, _res, next) => { req.userId = who; next(); });
  app.use('/api/shared-jobs', require('../routes/sharedJobs'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p).then(r => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  try {
    const now = new Date();
    const row = (u, platform, id, extra = {}) => ({
      userId: u._id, platform, sourceId: `${tag}-${id}`, sourceKey: `${platform}:${tag}-${id}`,
      title: `${tag} Engineer ${id}`, company: 'Acme', url: 'https://example.com/' + id, lastSeenAt: now,
      approval: 'approved', applyStatus: 'applied', score: 91, scoreReasons: ['SECRET-REASON'], applyNote: 'SECRET-NOTE',
      recruiters: [{ key: 'e:x@y.com', name: 'Secret Recruiter', email: 'x@y.com', via: 'text' }], ...extra,
    });
    await NaukriJob.insertMany([
      row(a, 'naukri', 1), row(b, 'naukri', 1),                 // same job, two accounts
      row(b, 'hirist', 2),                                      // only B has it
      row(optedOut, 'instahyre', 3),                            // opted out
      row(disabled, 'instahyre', 4),                            // disabled
      row(b, 'hirist', 5, { lastSeenAt: new Date(Date.now() - 40 * 86400_000) }), // stale
      row(b, 'hirist', 6, { deleted: true }),                   // deleted
    ]);

    const res = await get(`/api/shared-jobs?q=${tag}&limit=50`);
    const keys = res.jobs.map(j => j.key).sort();
    ok('shows own + other sharing accounts, one row per job', JSON.stringify(keys) === JSON.stringify([`hirist:${tag}-2`, `naukri:${tag}-1`]), JSON.stringify(keys));
    ok('opted-out, disabled, stale and deleted never appear', !keys.some(k => /-3$|-4$|-5$|-6$/.test(k)));
    const naukri = res.jobs.find(j => j.key === `naukri:${tag}-1`);
    ok('seenBy counts accounts, not names', naukri.seenBy === 2);
    ok('mine marks the viewer’s own row', naukri.mine && naukri.mine.applyStatus === 'applied' && res.jobs.find(j => j.key === `hirist:${tag}-2`).mine === null);
    const ALLOWED = ['company', 'experienceMax', 'experienceMin', 'key', 'lastSeenAt', 'location', 'mine', 'platform', 'postedAt', 'postedText', 'salaryText', 'seenBy', 'tags', 'title', 'url'];
    ok('every row has exactly the allowlisted keys', res.jobs.every(j => JSON.stringify(Object.keys(j).sort()) === JSON.stringify(ALLOWED)), JSON.stringify(Object.keys(res.jobs[0])));
    const dump = JSON.stringify(res);
    ok('no approval/score/notes/recruiters of anyone leak', !/SECRET|Secret Recruiter|x@y\.com/.test(dump) && !('approval' in res.jobs[1]) && !('score' in res.jobs[1]));
    const hirist = await get(`/api/shared-jobs?q=${tag}&platform=hirist`);
    ok('platform filter', hirist.total === 1 && hirist.jobs[0].platform === 'hirist');

    who = optedOut._id;
    const mineView = await get(`/api/shared-jobs?q=${tag}`);
    ok('an opted-out viewer still sees the pool (view is not gated by sharing)', mineView.total >= 2);

    who = a._id;
    const add = await post('/api/shared-jobs/add', { keys: [`hirist:${tag}-2`, `naukri:${tag}-1`, `instahyre:${tag}-3`, `nope:1`] });
    ok('add: new one added, own one existed, opted-out one is not addable', add.added === 1 && add.existed === 1 && add.missing === 2, JSON.stringify(add));
    const copy = await NaukriJob.findOne({ userId: a._id, sourceKey: `hirist:${tag}-2` }).lean();
    ok('copy is in the viewer’s account, pending, unapplied, no one else’s notes or recruiters',
      copy && copy.approval === 'pending' && copy.applyStatus === 'none' && !copy.applyNote && !(copy.recruiters || []).length && copy.score !== 91, JSON.stringify(copy && { a: copy.approval, s: copy.applyStatus, sc: copy.score }));
    ok('adding did not touch the source account’s row', (await NaukriJob.findOne({ userId: b._id, sourceKey: `hirist:${tag}-2` }).lean()).approval === 'approved');
    ok('adding nothing is rejected', (await post('/api/shared-jobs/add', { keys: [] })).error);

    ok('gate: admin or switched-on only', canSeeLibrary({ isAdmin: true }) && canSeeLibrary({ libraryAccess: true }) && !canSeeLibrary({}) && !canSeeLibrary({ libraryAccess: true, status: 'disabled' }));
  } finally {
    await NaukriJob.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
