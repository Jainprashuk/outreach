#!/usr/bin/env node
/**
 * GET /api/p/all/counts?range=… — the Job Platforms cards' date filter.
 *
 * Plants jobs found / applied at known times (relative to midnight IST) and
 * checks each range counts exactly the ones inside it, per platform, and that
 * a platform that is switched off is left out.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-platform-counts.js --base=http://localhost:4099
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');
const { startOfDayIn } = require('../lib/naukriSchedule');

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
  const email = `counts-${Date.now()}@example.invalid`;
  const { insertedId: uid } = await db.collection('users').insertOne({
    email, name: '', isAdmin: false, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });

  try {
    const cookie = await loginViaOtp({ base: BASE, email });
    const get = async (range) => (await (await fetch(`${BASE}/api/p/all/counts?range=${range}`, { headers: { Cookie: cookie } })).json());
    // Creates the config row, then switch Hirist on, Instahyre off.
    await get('7d');
    await db.collection('naukriconfigs').updateOne({ userId: uid }, { $set: {
      'platforms.hirist.enabled': true, 'platforms.instahyre.enabled': false,
    } });

    // A moment safely inside today, unless the test runs in the first minutes after midnight IST.
    const midnight = startOfDayIn('Asia/Kolkata');
    const now = Date.now();
    const todayAt = new Date(Math.max(midnight.getTime() + 60000, now - 5 * 60000));
    const at = {
      today: todayAt,
      yesterday: new Date(midnight.getTime() - 6 * HOUR),
      threeDays: new Date(now - 3 * DAY),
      twentyDays: new Date(now - 20 * DAY),
      fortyDays: new Date(now - 40 * DAY),
    };
    const job = (platform, n, firstSeenAt, history) => ({
      userId: uid, platform, sourceId: `ct-${platform}-${n}`, sourceKey: `${platform}:ct-${n}`, title: 't', company: 'c',
      approval: 'approved', applyStatus: 'none', deleted: false, firstSeenAt, applyHistory: history,
      createdAt: firstSeenAt, updatedAt: firstSeenAt,
    });
    const applied = (d) => [{ at: d, from: 'none', to: 'applied', note: '' }];
    await db.collection('naukrijobs').insertMany([
      // Naukri (platform missing = Naukri, like old rows)
      { ...job('naukri', 1, at.today, applied(at.today)), platform: undefined },
      job('naukri', 2, at.yesterday, applied(at.yesterday)),
      job('naukri', 3, at.threeDays, [{ at: at.threeDays, from: 'none', to: 'skipped', note: '' }]),
      job('naukri', 4, at.twentyDays, applied(at.twentyDays)),
      job('naukri', 5, at.fortyDays, applied(at.fortyDays)),
      // Hirist
      job('hirist', 1, at.today, []),
      job('hirist', 2, at.threeDays, applied(at.today)),
      // Instahyre is off: never counted
      job('instahyre', 1, at.today, applied(at.today)),
    ]);

    const t = await get('today'), y = await get('yesterday'), w = await get('7d'), m = await get('30d');
    console.log('Naukri:');
    check(t.counts.naukri.found === 1 && t.counts.naukri.applied === 1, `today: found 1, applied 1 (${JSON.stringify(t.counts.naukri)})`);
    check(y.counts.naukri.found === 1 && y.counts.naukri.applied === 1, `yesterday: found 1, applied 1 (${JSON.stringify(y.counts.naukri)})`);
    check(w.counts.naukri.found === 3 && w.counts.naukri.applied === 2 && w.counts.naukri.skipped === 1, `7 days: found 3, applied 2, skipped 1 (${JSON.stringify(w.counts.naukri)})`);
    check(m.counts.naukri.found === 4 && m.counts.naukri.applied === 3, `30 days: found 4, applied 3 — the 40-day-old one is out (${JSON.stringify(m.counts.naukri)})`);
    console.log('\nHirist:');
    check(t.counts.hirist.found === 1 && t.counts.hirist.applied === 1, `today: found 1, applied 1 — applied counts when it was applied, not found (${JSON.stringify(t.counts.hirist)})`);
    check(w.counts.hirist.found === 2, `7 days: found 2 (${JSON.stringify(w.counts.hirist)})`);
    console.log('\nOther:');
    check(!('instahyre' in t.counts), 'a switched-off platform is left out');
    const bad = await get('banana');
    check(bad.range === '7d', 'an unknown range falls back to 7 days');
    check(new Date(y.to).getTime() === midnight.getTime(), 'yesterday ends at midnight IST');
  } finally {
    for (const c of ['naukrijobs', 'naukriconfigs', 'naukriworkers', 'sessions', 'activitylogs']) await db.collection(c).deleteMany({ userId: uid });
    await db.collection('logincodes').deleteMany({ email });
    await db.collection('users').deleteOne({ _id: uid });
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
