#!/usr/bin/env node
/**
 * GET /api/p/all/jobs-overview — the Jobs tab's landing view.
 *
 * Plants jobs in known states on two platforms and checks the needs-you counts,
 * the per-platform numbers (stages, failed, stale status check) and the
 * timeline. Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-jobs-overview.js --base=http://localhost:4099
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;
let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const HOUR = 3600000, DAY = 24 * HOUR;

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const email = `overview-${Date.now()}@example.invalid`;
  const { insertedId: uid } = await db.collection('users').insertOne({
    email, name: '', isAdmin: false, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  try {
    const cookie = await loginViaOtp({ base: BASE, email });
    const get = async (range = '') => (await fetch(`${BASE}/api/p/all/jobs-overview${range ? `?range=${range}` : ''}`, { headers: { Cookie: cookie } })).json();
    await get(); // creates the config row
    await db.collection('naukriconfigs').updateOne({ userId: uid }, { $set: { 'platforms.hirist.enabled': true, 'platforms.instahyre.enabled': false } });

    const now = Date.now();
    const j = (platform, n, extra) => ({
      userId: uid, platform, sourceId: `ov-${platform}-${n}`, sourceKey: `${platform}:ov-${n}`, title: `Role ${platform} ${n}`, company: 'Acme',
      approval: 'approved', applyStatus: 'none', deleted: false, firstSeenAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now), ...extra,
    });
    await db.collection('naukrijobs').insertMany([
      j('naukri', 1, { approval: 'pending' }),
      j('naukri', 2, { applyStatus: 'failed', applyNote: 'button missing', applyHistory: [{ at: new Date(now - HOUR), from: 'none', to: 'failed', note: 'x' }] }),
      j('naukri', 3, { applyStatus: 'in-review', naukriStage: 'shortlisted', naukriStageAt: new Date(now - 2 * HOUR), trackedAt: new Date(now - 5 * DAY),
        naukriTimeline: [{ id: 6, value: 'Shortlisted', at: new Date(now - 2 * HOUR) }], applyHistory: [{ at: new Date(now - 3 * HOUR), from: 'none', to: 'applied', note: '' }] }),
      j('naukri', 4, { applyStatus: 'applied', naukriStage: 'viewed', naukriStageAt: new Date(now - HOUR), trackedAt: new Date(now - 5 * DAY) }),
      j('hirist', 1, { applyStatus: 'skipped', unknownQuestion: 'Notice period?' }),
      j('hirist', 2, { applyStatus: 'applied', naukriStage: 'not-shortlisted', naukriStageAt: new Date(now - HOUR), trackedAt: new Date(now - HOUR) }),
      j('instahyre', 1, { approval: 'pending' }), // platform off: not listed
      j('hirist', 3, { applyStatus: 'applied', applyHistory: [{ at: new Date(now - 20 * DAY), from: 'none', to: 'applied', note: '' }] }),
    ]);

    const o = await get();
    const by = Object.fromEntries(o.platforms.map(p => [p.platform, p]));
    console.log('Needs you:');
    check(o.needs.review === 1, `1 to review (${o.needs.review})`);
    check(o.needs.failed === 1, `1 failed (${o.needs.failed})`);
    check(o.needs.needsAnswer === 1, `1 needs an answer (${o.needs.needsAnswer})`);
    check(o.needs.recruiter === 1, `1 recruiter interest (${o.needs.recruiter})`);
    console.log('Platforms:');
    check(!by.instahyre && !!by.naukri && !!by.hirist, 'only switched-on platforms are listed');
    check(by.naukri.applied === 2 && by.naukri.viewed === 1 && by.naukri.shortlisted === 1, `naukri applied 2, viewed 1, shortlisted 1 (${JSON.stringify([by.naukri.applied, by.naukri.viewed, by.naukri.shortlisted])})`);
    check(by.hirist.applied === 2 && by.hirist.notShortlisted === 1 && by.hirist.period.sent === 0, 'hirist applied 2 (all time), not shortlisted 1, nothing sent this week');
    check(by.naukri.trackStale === true && by.hirist.trackStale === false, 'a 5-day-old status check is stale, a fresh one is not');
    check(by.naukri.problems.some(p => p.kind === 'stale'), 'stale check is listed as a problem');
    console.log('Timeline:');
    check(o.timeline.some(e => e.kind === 'failed') && o.timeline.some(e => e.kind === 'applied'), 'own apply and failure appear');
    check(o.timeline.some(e => e.kind === 'shortlisted' && e.label === 'Shortlisted'), 'recruiter shortlist appears with the site\'s words');
    check(o.timeline.every((e, i, a) => !i || new Date(a[i - 1].at) >= new Date(e.at)), 'newest first');
    console.log('Period:');
    check(o.range === '7d' && by.naukri.period.sent === 1 && by.naukri.period.failed === 1 && by.naukri.period.interest === 1, `7d: naukri sent 1, failed 1, interest 1 (${JSON.stringify(by.naukri.period)})`);
    const y = await get('yesterday');
    const yb = Object.fromEntries(y.platforms.map(p => [p.platform, p]));
    check(y.range === 'yesterday' && y.needs.review === 1 && y.needs.failed === 1, 'the period never changes what needs you now');
    check(yb.naukri.applied === 2, 'total applied is all time in every period');
    const old = await get('all');
    check(old.range === 'all' && old.timeline.length >= o.timeline.length, 'all time has at least what 7 days has');
    check((await get('banana')).range === '7d', 'an unknown period falls back to 7 days');
  } finally {
    for (const c of ['naukrijobs', 'naukriconfigs', 'naukriworkers', 'naukriruns', 'sessions', 'activitylogs']) await db.collection(c).deleteMany({ userId: uid });
    await db.collection('logincodes').deleteMany({ email });
    await db.collection('users').deleteOne({ _id: uid });
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
