#!/usr/bin/env node
/**
 * Check-in hints for job-platform workers (routes/naukri.js nextPollFor / isOnline,
 * lib/portalPresence.js, and the heartbeat skip in lib/activityLog.js).
 *
 * Asserts:
 *   - a worker that does not ask for hints gets none (old workers unchanged);
 *   - idle, owner away, no schedule → the long interval (300s);
 *   - owner in the portal → fast (their check-in interval);
 *   - a queued run on that platform → fast; on ANOTHER platform → still idle;
 *   - a scheduled run 2 minutes away → wake just after it (≈125s);
 *   - "online" allows for the interval the worker was told: a hint-aware
 *     worker silent for 4 min reads online, a 20s worker silent that long does not;
 *   - a successful check-in writes no activity-log row.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-poll-hints.js --base=http://localhost:4099
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

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const { issueWorkerToken } = require('../lib/workerAuth');

  const email = `poll-hints-${Date.now()}@example.invalid`;
  const { insertedId: uid } = await users.insertOne({
    email, name: '', isAdmin: false, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  const token = await issueWorkerToken(uid);
  const claim = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': token }, body: JSON.stringify(body) });
    return r.json();
  };
  const hirist = (extra = {}) => claim('/api/p/hirist/claim', { host: 'hint-test', chromeUp: false, hints: true, ...extra });
  const cfg = () => db.collection('naukriconfigs').findOne({ userId: uid });
  const setPortal = (at) => users.updateOne({ _id: uid }, at ? { $set: { portalSeenAt: at } } : { $unset: { portalSeenAt: 1 } });

  try {
    // First call creates the config/worker rows; turn Hirist on with no schedule.
    await claim('/api/p/hirist/claim', { host: 'hint-test' });
    await db.collection('naukriconfigs').updateOne({ userId: uid }, { $set: { 'platforms.hirist.enabled': true, 'platforms.hirist.schedule.enabled': false } });
    if (!(await cfg())) throw new Error('no config row was created');

    console.log('Old workers:');
    const legacy = await claim('/api/p/hirist/claim', { host: 'hint-test' });
    check(!('nextPollSeconds' in legacy) && legacy.pollSeconds === 20, 'no hints asked → none given, pollSeconds still 20');

    console.log('\nIdle:');
    await setPortal(null);
    check((await hirist()).nextPollSeconds === 300, 'owner away, nothing queued, no schedule → 300s');

    console.log('\nOwner in the portal:');
    await setPortal(new Date());
    check((await hirist()).nextPollSeconds === 20, 'seen just now → 20s');
    await setPortal(new Date(Date.now() - 11 * 60 * 1000));
    check((await hirist()).nextPollSeconds === 300, 'seen 11 minutes ago → back to 300s');

    console.log('\nQueued runs:');
    const other = await db.collection('naukriruns').insertOne({ userId: uid, platform: 'instahyre', kind: 'harvest', status: 'queued', trigger: 'manual', createdAt: new Date(), updatedAt: new Date() });
    check((await hirist({ probeOnly: true })).nextPollSeconds === 20, 'a busy (probe-only) poll → 20s');
    await db.collection('naukriruns').deleteOne({ _id: other.insertedId });
    await db.collection('naukriruns').insertOne({ userId: uid, platform: 'instahyre', kind: 'harvest', status: 'queued', trigger: 'manual', createdAt: new Date(), updatedAt: new Date() });
    const otherOnly = await hirist({ probeOnly: false });
    check(otherOnly.nextPollSeconds === 300, 'a run queued on ANOTHER platform does not speed this one up');
    await db.collection('naukriruns').deleteMany({ userId: uid });
    await db.collection('naukriruns').insertOne({ userId: uid, platform: 'hirist', kind: 'harvest', status: 'queued', trigger: 'manual', createdAt: new Date(), updatedAt: new Date() });
    const mine = await hirist();
    check(mine.run && mine.nextPollSeconds === 20, 'a run queued on THIS platform is handed out, and the next check-in is fast (20s)');
    await db.collection('naukriruns').updateMany({ userId: uid }, { $set: { status: 'done' } });

    console.log('\nSchedule:');
    const at = new Date(Date.now() + 2 * 60 * 1000);
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
    await db.collection('naukriconfigs').updateOne({ userId: uid }, { $set: {
      'platforms.hirist.schedule.enabled': true, 'platforms.hirist.schedule.time': hhmm,
      'platforms.hirist.schedule.days': [0, 1, 2, 3, 4, 5, 6], 'platforms.hirist.schedule.timezone': 'Asia/Kolkata',
      'platforms.hirist.schedule.runHarvest': true, 'platforms.hirist.schedule.runApply': false,
      'platforms.hirist.schedule.runRefresh': false, 'platforms.hirist.schedule.runTrack': false,
      'platforms.hirist.schedule.extraSlots': [],
    } });
    const sched = (await hirist()).nextPollSeconds;
    check(sched >= 60 && sched <= 130, `next slot ~2 min away (${hhmm}) → wake just after it (${sched}s)`);

    console.log('\nOnline allows for the interval it was told:');
    const workers = db.collection('naukriworkers');
    const cookie = await loginViaOtp({ base: BASE, email });
    const overview = async () => (await (await fetch(BASE + '/api/p/hirist/overview', { headers: { Cookie: cookie } })).json()).worker;
    await workers.updateOne({ userId: uid, platform: 'hirist' }, { $set: { lastSeenAt: new Date(Date.now() - 4 * 60 * 1000), pollHintSeconds: 300 } });
    check((await overview()).online === true, 'told 300s, silent 4 min → online');
    await workers.updateOne({ userId: uid, platform: 'hirist' }, { $set: { lastSeenAt: new Date(Date.now() - 4 * 60 * 1000) }, $unset: { pollHintSeconds: 1 } });
    check((await overview()).online === false, 'no hint (20s worker), silent 4 min → offline, as before');
    await workers.updateOne({ userId: uid, platform: 'hirist' }, { $set: { lastSeenAt: new Date(Date.now() - 7 * 60 * 1000), pollHintSeconds: 300 } });
    check((await overview()).online === false, 'told 300s, silent 7 min → offline');

    console.log('\nNo audit row per check-in:');
    await new Promise(r => setTimeout(r, 1000));
    const claimRows = await db.collection('activitylogs').countDocuments({ userId: uid, 'meta.path': '/claim' });
    check(claimRows === 0, `successful check-ins wrote ${claimRows} activity rows`);
  } finally {
    for (const c of ['activitylogs', 'naukriworkers', 'naukriconfigs', 'naukriruns', 'sessions', 'notifications', 'issues']) {
      await db.collection(c).deleteMany({ userId: uid });
    }
    await db.collection('logincodes').deleteMany({ email });
    await users.deleteOne({ _id: uid });
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
