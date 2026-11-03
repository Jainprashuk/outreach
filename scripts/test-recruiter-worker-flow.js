#!/usr/bin/env node
/**
 * "Find recruiter" for every recruiter platform: the server reads public pages
 * itself (Wellfound HTML parse), hands the rest to the worker (/claim →
 * recruiterJobs → POST /recruiters), backfill, captcha block. DEV DATABASE
 * ONLY; scratch user, everything removed. No browser, no outside calls.
 *   node scripts/test-recruiter-worker-flow.js
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
const userId = new mongoose.Types.ObjectId();

(async () => {
  const R = require('../lib/recruiterLinkedin');
  // ── pure: Wellfound's server-rendered "Hiring contact" block
  const html = '<div><h4>Hiring contact</h4><div class="x"><div class="l"><div class="n"><a href="/u/ivan-k-1" class="c">Ivan Kumar</a></div><span class="by">Founder &amp; CEO</span></div></div></div>';
  const w = R.wellfoundRecruiterFromHtml(html);
  ok('Wellfound HTML: name and title', w && w.name === 'Ivan Kumar' && w.title === 'Founder & CEO', JSON.stringify(w));
  ok('Wellfound HTML: no block → null', R.wellfoundRecruiterFromHtml('<a href="/u/x">Someone Else</a>') === null);
  ok('Wellfound HTML: a one-word name is kept (shown; the LinkedIn search skips it)', (R.wellfoundRecruiterFromHtml(html.replace('Ivan Kumar', 'Ivan')) || {}).name === 'Ivan');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const NaukriJob = require('../models/NaukriJob');
  const NaukriWorker = require('../models/NaukriWorker');
  const NaukriConfig = require('../models/NaukriConfig');
  const { isPlatform } = require('../lib/platforms');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  const withPlatform = (fixed) => (req, res, next) => {
    const p = fixed || req.params.platform;
    if (p !== 'all' && !isPlatform(p)) return res.status(404).json({ error: 'Unknown platform' });
    req.platform = p; next();
  };
  app.use('/api/naukri', withPlatform('naukri'), require('../routes/naukri'));
  app.use('/api/p/:platform', withPlatform(), require('../routes/naukri'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  try {
    await call('PATCH', '/api/p/hirist/config', { enabled: true });
    const old = new Date(Date.now() - 10 * 86400000);
    const mk = (platform, n, extra = {}) => ({ userId, platform, sourceId: `rw-${n}`, sourceKey: `${platform}:rw-${n}`, title: `T${n}`, company: 'Acme',
      approval: 'pending', applyStatus: 'none', deleted: false, firstSeenAt: old, createdAt: old, updatedAt: old, recruiters: [], ...extra });
    const docs = await NaukriJob.insertMany([
      mk('hirist', 1), mk('hirist', 2, { approval: 'approved' }), mk('hirist', 3),
      mk('hirist', 4, { recruiters: [{ key: 'n:a|b', name: 'Ann Bee', title: '', email: '', profileUrl: '', via: 'feed' }] }),
      mk('hirist', 5, { firstSeenAt: new Date(Date.now() - 200 * 86400000), createdAt: new Date(Date.now() - 200 * 86400000) }),
      mk('naukri', 6),
    ]);
    const [h1, h2] = docs;

    console.log('\nFind recruiter on a Hirist job → the worker');
    let r = await call('POST', `/api/naukri/jobs/${h1._id}/recruiters/fetch`);
    ok('queued for the worker (Hirist needs the login)', r.status === 200 && r.queued === true, JSON.stringify(r));
    ok('marked wanted', !!(await NaukriJob.findById(h1._id).lean()).recruiterWantedAt);
    r = await call('POST', `/api/naukri/jobs/${docs[5]._id}/recruiters/fetch`);
    ok('Naukri job: nothing to read, not queued', r.status === 200 && r.queued === false);

    console.log('\nbackfill');
    r = await call('POST', '/api/p/hirist/jobs/recruiters/backfill', { days: 60 });
    ok('queues older jobs with nobody yet (not named, not too old, not already asked)', r.queued === 2, JSON.stringify(r));
    r = await call('POST', '/api/p/hirist/jobs/recruiters/backfill', { days: 60 });
    ok('a second backfill adds nothing', r.queued === 0);
    r = await call('POST', '/api/naukri/jobs/recruiters/backfill', {});
    ok('Naukri backfill queues nothing', r.queued === 0);

    console.log('\nthe worker picks them up when idle');
    const c = await call('POST', '/api/p/hirist/claim', { host: 'test', chromeUp: true, loggedIn: true, hints: true });
    const ids = (c.recruiterJobs || []).map(j => j.sourceId).sort();
    ok('idle claim carries the 3 asked jobs', !c.run && JSON.stringify(ids) === JSON.stringify(['rw-1', 'rw-2', 'rw-3']), JSON.stringify(c));
    ok('…and asks the worker back fast', c.nextPollSeconds === c.pollSeconds, `${c.nextPollSeconds} vs ${c.pollSeconds}`);
    const other = await call('POST', '/api/naukri/claim', { host: 'test', chromeUp: true, loggedIn: true });
    ok('another platform’s worker is not asked', !other.recruiterJobs);

    r = await call('POST', '/api/p/hirist/recruiters', { results: [
      { sourceId: 'rw-1', recruiters: [{ name: 'Pushpendra Verma', title: 'HR Manager' }] },
      { sourceId: 'rw-2', recruiters: [{ name: 'Sam Rao', title: 'TA' }] },
      { sourceId: 'rw-3', recruiters: [] },
      { sourceId: 'rw-404', recruiters: [{ name: 'No Such', title: '' }] },
    ] });
    ok('answer accepted', r.status === 200 && r.found === 2, JSON.stringify(r));
    const a1 = await NaukriJob.findById(h1._id).lean();
    ok('recruiter stored, ask cleared, read time set', a1.recruiters[0].name === 'Pushpendra Verma' && a1.recruiterWantedAt === null && !!a1.recruiterFetchedAt);
    const a3 = await NaukriJob.findById(docs[2]._id).lean();
    ok('nobody named: ask cleared, read time set, no recruiter', a3.recruiters.length === 0 && a3.recruiterWantedAt === null && !!a3.recruiterFetchedAt);
    const c2 = await call('POST', '/api/p/hirist/claim', { host: 'test', chromeUp: true, loggedIn: true });
    ok('nothing left to ask', !c2.recruiterJobs);
    r = await call('POST', '/api/p/hirist/recruiters', { results: [{ sourceId: 'rw-1', recruiters: [{ name: 'Pushpendra Verma', title: 'HR Manager' }] }] });
    ok('a repeat answer does not duplicate', (await NaukriJob.findById(h1._id).lean()).recruiters.length === 1);
    ok('approved job got its recruiter too', (await NaukriJob.findById(h2._id).lean()).recruiters[0].name === 'Sam Rao');

    console.log('\ncaptcha while reading');
    r = await call('POST', '/api/p/hirist/recruiters', { blocked: 'Hirist showed a captcha' });
    const wk = await NaukriWorker.findOne({ userId, platform: 'hirist' }).lean();
    ok('blocks this platform’s worker for a week', r.blocked && wk.blockedUntil && new Date(wk.blockedUntil) > new Date(Date.now() + 6 * 86400000));
    const c3 = await call('POST', '/api/p/hirist/claim', { host: 'test', chromeUp: true, loggedIn: true });
    ok('a blocked worker gets no work', !!c3.blockedUntil && !c3.recruiterJobs);
  } finally {
    await NaukriJob.deleteMany({ userId });
    await NaukriWorker.deleteMany({ userId });
    await NaukriConfig.deleteMany({ userId });
    await mongoose.connection.db.collection('naukriruns').deleteMany({ userId });
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
