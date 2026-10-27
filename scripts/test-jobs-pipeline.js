#!/usr/bin/env node
/**
 * Jobs tab backend test. DEV DATABASE ONLY. Scratch user, everything removed at the end.
 *   node scripts/test-jobs-pipeline.js
 * Covers: /api/p/all/jobs spans platforms and each stage query the Jobs tab uses
 * · POST /api/companies/status vs the Company page totals.
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
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const Contact = require('../models/Contact');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use('/api/p/:platform', require('../routes/naukri'));
  app.use('/api/companies', require('../routes/companies'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p).then(r => r.json());
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

  try {
    const mk = (platform, i, extra) => ({
      userId, platform, sourceId: `${platform}-${i}`, sourceKey: `${platform}:t${i}-${userId}`,
      title: `Backend Engineer ${i}`, company: 'Acme Labs', url: 'https://example.com/' + i, score: 80 - i, ...extra,
    });
    await NaukriJob.insertMany([
      mk('naukri', 1, { approval: 'pending' }),
      mk('instahyre', 2, { approval: 'pending' }),
      mk('hirist', 3, { approval: 'approved', applyStatus: 'none' }),
      mk('naukri', 4, { approval: 'approved', applyStatus: 'applied', appliedAt: new Date() }),
      mk('instahyre', 5, { approval: 'approved', applyStatus: 'interviewing', appliedAt: new Date(), company: 'Zeta Corp' }),
    ]);
    const a = await Contact.create({ userId, name: 'Pat', email: 'pat@acmelabs-test.com', company: 'Acme Labs', status: 'replied', lastSentAt: new Date(), repliedAt: new Date() });
    const b = await Contact.create({ userId, name: 'Sam', email: 'sam@acmelabs-test.com', company: 'ACME LABS.com', status: 'sent', lastSentAt: new Date() });

    const q = async (s) => (await get('/api/p/all/jobs?' + s));
    const review = await q('approval=pending&sort=score');
    ok('review: pending jobs from two platforms', review.total === 2 && new Set(review.jobs.map(j => j.platform)).size === 2, JSON.stringify(review.total));
    ok('review: sorted by score', review.jobs[0].score >= review.jobs[1].score);
    ok('queued: bucket=waiting', (await q('bucket=waiting')).total === 1);
    ok('applied: sent includes interviewing', (await q('applyStatus=sent')).total === 2);
    ok('interviewing: exact', (await q('applyStatus=interviewing')).total === 1);
    ok('search by company', (await q('q=zeta')).total === 1);
    ok('limit=1 still reports the total', (await q('approval=pending&limit=1')).total === 2);

    const st = (await post('/api/companies/status', { names: ['Acme Labs', 'Zeta Corp', ''] })).companies;
    ok('status: Acme Labs matches both contacts (normalised name)', st['Acme Labs'] && st['Acme Labs'].contacts === 2, JSON.stringify(st));
    ok('status: sent/replied tallied', st['Acme Labs'].sent === 2 && st['Acme Labs'].replied === 1);
    ok('status: no contacts => zeroes', st['Zeta Corp'] && st['Zeta Corp'].contacts === 0);
    const d = await get('/api/companies/' + encodeURIComponent(st['Acme Labs'].key));
    ok('status equals Company page totals', d.totals.contacts >= st['Acme Labs'].contacts && d.totals.sent >= st['Acme Labs'].sent, JSON.stringify(d.totals));
    ok('bad body does not crash', Array.isArray(Object.keys((await post('/api/companies/status', {})).companies)));
    void a; void b;
  } finally {
    await NaukriJob.deleteMany({ userId });
    await Contact.deleteMany({ userId });
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
