#!/usr/bin/env node
/**
 * Recruiter LinkedIn over HTTP against a running dev server: settings save/clean,
 * Instahyre "Find recruiter" (real public call), Find LinkedIn without a key, bad ids.
 * DEV DATABASE ONLY; scratch user, everything removed.
 *   node scripts/test-recruiter-linkedin-http.js [--base=http://localhost:4099]
 */
require('dotenv').config();
process.noDeprecation = true;
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');
const arg = (k) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const BASE = arg('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c || !d ? '' : '  << ' + d)); };

(async () => {
  if (!URI || /prod/i.test(URI)) throw new Error('Needs a dev MONGODB_URI_DEV');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const email = `reclink-${Date.now()}@example.invalid`;
  const { insertedId: uid } = await db.collection('users').insertOne({
    email, name: '', isAdmin: false, status: 'active', apps: ['outreach'], createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  const jobIds = [];
  try {
    const cookie = await loginViaOtp({ base: BASE, email });
    const call = async (method, path, body) => {
      const r = await fetch(BASE + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };

    // settings
    let r = await call('GET', '/api/prospects/config');
    ok('default modes are button only, cap 20', JSON.stringify(r.json.recruiterLinkedin) === JSON.stringify({ modes: ['manual'], dailyCap: 20 }), JSON.stringify(r.json.recruiterLinkedin));
    r = await call('PUT', '/api/prospects/config', { recruiterLinkedin: { modes: ['approved', 'recruiter_action', 'bogus'], dailyCap: 999 } });
    ok('multi-select saved, junk dropped, manual kept', r.status === 200 && ['approved', 'recruiter_action', 'manual'].every(m => r.json.recruiterLinkedin.modes.includes(m)) && !r.json.recruiterLinkedin.modes.includes('bogus'), JSON.stringify(r.json));
    ok('cap clamped to 200', r.json.recruiterLinkedin && r.json.recruiterLinkedin.dailyCap === 200);
    r = await call('PUT', '/api/prospects/config', { recruiterLinkedin: { dailyCap: 0 } });
    ok('cap below 1 refused', r.status === 400);

    // Instahyre job with no recruiter → Find recruiter (real public Instahyre call)
    const base = { userId: uid, approval: 'pending', applyStatus: 'none', deleted: false, createdAt: new Date(), updatedAt: new Date(), recruiters: [] };
    const ins = await db.collection('naukrijobs').insertMany([
      { ...base, platform: 'instahyre', sourceId: '448626', sourceKey: 'instahyre:448626', title: 'Forward Deployed Engineer', company: 'Trail' },
      { ...base, platform: 'naukri', sourceId: 'rl-1', sourceKey: 'naukri:rl-1', title: 'Dev', company: 'Acme',
        recruiters: [{ key: 'n:priya|sharma', name: 'Priya Sharma', title: 'HR', email: '', profileUrl: '', via: 'feed' }] },
    ]);
    jobIds.push(...Object.values(ins.insertedIds));
    const [instaId, naukriId] = Object.values(ins.insertedIds).map(String);

    r = await call('POST', `/api/p/instahyre/jobs/${instaId}/recruiters/fetch`);
    const rec = (r.json.recruiters || [])[0] || {};
    ok('Instahyre recruiter fetched and returned', r.status === 200 && !!rec.name && rec.company === 'Recro', JSON.stringify(r.json).slice(0, 200));
    const stored = await db.collection('naukrijobs').findOne({ _id: ins.insertedIds[0] });
    ok('…and stored on the job, with company', stored.recruiters.length === 1 && stored.recruiters[0].company === 'Recro');
    r = await call('POST', `/api/p/instahyre/jobs/${instaId}/recruiters/fetch`);
    ok('fetching again does not duplicate', (await db.collection('naukrijobs').findOne({ _id: ins.insertedIds[0] })).recruiters.length === 1);

    // Find LinkedIn with no search key: an error, and the recruiter is NOT marked tried
    r = await call('POST', `/api/naukri/jobs/${naukriId}/recruiters/${encodeURIComponent('n:priya|sharma')}/linkedin`);
    ok('no key → 400 with the reason', r.status === 400 && /No search key/.test(r.json.error || ''), JSON.stringify(r));
    const after = await db.collection('naukrijobs').findOne({ _id: ins.insertedIds[1] });
    ok('…and not marked as tried', !after.recruiters[0].linkedinTriedAt);

    r = await call('POST', `/api/naukri/jobs/${naukriId}/recruiters/${encodeURIComponent('n:nobody|here')}/linkedin`);
    ok('unknown recruiter → 404', r.status === 404, JSON.stringify(r));
    r = await call('POST', `/api/naukri/jobs/not-an-id/recruiters/x/linkedin`);
    ok('bad job id → 404', r.status === 404);

    // another user's job is invisible
    const other = await db.collection('naukrijobs').insertOne({ ...base, userId: new mongoose.Types.ObjectId(), platform: 'naukri', sourceId: 'rl-x', sourceKey: 'naukri:rl-x', title: 'X', company: 'Y',
      recruiters: [{ key: 'n:a|b', name: 'Ann Bee', title: '', email: '', profileUrl: '', via: 'feed' }] });
    jobIds.push(other.insertedId);
    r = await call('POST', `/api/naukri/jobs/${other.insertedId}/recruiters/${encodeURIComponent('n:a|b')}/linkedin`);
    ok("another user's job → 404", r.status === 404);
    r = await call('POST', `/api/p/instahyre/jobs/${other.insertedId}/recruiters/fetch`);
    ok("another user's job (fetch) → 404", r.status === 404);
  } finally {
    await db.collection('naukrijobs').deleteMany({ _id: { $in: jobIds } });
    await db.collection('discoveryconfigs').deleteMany({ userId: uid });
    await db.collection('naukriconfigs').deleteMany({ userId: uid });
    await db.collection('logincodes').deleteMany({ email });
    await db.collection('sessions').deleteMany({ userId: uid }).catch(() => {});
    await db.collection('users').deleteOne({ _id: uid });
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
