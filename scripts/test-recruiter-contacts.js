#!/usr/bin/env node
/**
 * Recruiters from job platforms: the text scan, feed extraction, ingest storage and
 * the Discover hand-off. DEV DATABASE ONLY; scratch user, everything removed.
 *   node scripts/test-recruiter-contacts.js
 */
require('dotenv').config();
process.noDeprecation = true;
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run with NODE_ENV=prod'); process.exit(1); }
const URI = process.env.MONGODB_URI_DEV;
if (!URI) { console.error('MONGODB_URI_DEV is not set'); process.exit(1); }
const express = require('express');
const mongoose = require('mongoose');
const R = require('../lib/recruiterContacts');
const feed = require('../worker/platforms/shared/feed');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c || !d ? '' : '  << ' + d)); };
const userId = new mongoose.Types.ObjectId();

(async () => {
  // ── pure: text scan
  const text = 'Send CV to Priya.Sharma@Acme.com. Ignore noreply@acme.com, logo@acme.png, hr@naukri.com, info@acme.com; also careers@acme.com';
  const em = R.emailsIn(text);
  ok('text scan keeps real addresses', em.includes('priya.sharma@acme.com') && em.includes('careers@acme.com'), JSON.stringify(em));
  ok('text scan drops noise (noreply, image, platform, info)', em.length === 2, JSON.stringify(em));
  ok('name from local part', R.nameFromLocal('priya.sharma') === 'Priya Sharma' && R.nameFromLocal('hr') === null);
  const merged = R.recruitersFor({ description: 'mail priya.sharma@acme.com', feed: [{ name: 'Priya Sharma', title: 'Talent Lead', email: 'priya.sharma@acme.com' }] });
  ok('feed + text merge into one person', merged.length === 1 && merged[0].title === 'Talent Lead', JSON.stringify(merged));
  ok('garbage input gives nothing', R.recruitersFor({ description: '', feed: [null, {}, { name: '' }, 5] }).length === 0);
  // ── pure: feed extraction
  const jobs = feed.jobsInJson({ jobs: [
    { job_id: 1, title: 'Dev', company_name: 'Acme', recruiter: { name: 'Sam Rao', designation: 'HR' } },
    { job_id: 2, title: 'QA', company_name: 'Acme', recruiter_name: 'Lee Wong', recruiter_email: 'lee.wong@acme.com' },
    { job_id: 3, title: 'Ops', company_name: 'Acme' },
  ] });
  ok('feed object recruiter', jobs[0].recruiters && jobs[0].recruiters[0].name === 'Sam Rao');
  ok('feed flat recruiter fields', jobs[1].recruiters && jobs[1].recruiters[0].email === 'lee.wong@acme.com');
  ok('no recruiter => no field', jobs[2].recruiters === undefined);

  // ── ingest + Discover hand-off
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const NaukriRun = require('../models/NaukriRun');
  const Prospect = require('../models/Prospect');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use('/api/p/:platform', require('../routes/naukri'));
  app.use('/api/prospects', require('../routes/prospects'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json()) }));

  try {
    const run = await NaukriRun.create({ userId, platform: 'hirist', kind: 'harvest', status: 'running' });
    const row = { sourceId: 'rc-1', title: 'Backend Engineer', company: 'Acme Labs', description: 'Apply: priya.sharma@acmelabs-test.com',
      recruiters: [{ name: 'Sam Rao', title: 'Talent Partner' }] };
    const a = await post('/api/p/hirist/ingest', { runId: String(run._id), jobs: [row] });
    ok('ingest ok', a.created === 1, JSON.stringify(a));
    await post('/api/p/hirist/ingest', { runId: String(run._id), jobs: [{ ...row, description: 'no email now' }] });
    const job = await NaukriJob.findOne({ userId, sourceKey: 'hirist:rc-1' }).lean();
    ok('recruiters stored once, re-harvest does not duplicate or drop', job.recruiters.length === 2, JSON.stringify(job.recruiters));

    const h = await post('/api/prospects/from-job', { jobId: String(job._id), domain: 'acmelabs-test.com', companyName: 'Acme Labs' });
    ok('from-job adds both people', h.status === 201 && h.added.length === 2, JSON.stringify(h));
    const rows = await Prospect.find({ userId }).lean();
    const withMail = rows.find(p => p.knownEmail === 'priya.sharma@acmelabs-test.com');
    ok('address from the job text is kept as their own', withMail && withMail.status === 'ready' && withMail.foundVia[0] === 'job');
    const guessed = rows.find(p => p.name === 'Sam Rao');
    ok('name-only recruiter gets a guessed address on the company domain, never sent',
      guessed && /@acmelabs-test\.com$/.test(guessed.email || '') && guessed.knownEmail == null, JSON.stringify(guessed && guessed.email));
    const again = await post('/api/prospects/from-job', { jobId: String(job._id), domain: 'acmelabs-test.com' });
    ok('second call adds nobody', again.added.length === 0 && again.existed.length === 2, JSON.stringify(again));
    ok('free-mail domain refused', (await post('/api/prospects/from-job', { jobId: String(job._id), domain: 'gmail.com' })).status === 400);
  } finally {
    await NaukriJob.deleteMany({ userId });
    await NaukriRun.deleteMany({ userId });
    await Prospect.deleteMany({ userId });
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
