#!/usr/bin/env node
/**
 * Job platforms are kept apart. DEV DATABASE ONLY, stub drivers only.
 *
 *   node scripts/test-platform-isolation.js
 *
 * Mounts routes/naukri.js exactly as server.js does (/api/naukri and
 * /api/p/:platform) on a throwaway local server as a scratch user, drives the
 * real worker loop (worker/platform-worker.js) per platform against it, and
 * deletes every row it made — pass or fail. It never talks to OUTREACH_URL.
 *
 * Covers: the same site id on two platforms is two rows · each platform's
 * lists, counts and runs see only its own rows (All sees every one) · rows
 * from before platforms existed are Naukri's · a captcha on Instahyre blocks
 * only Instahyre · unknown platform 404 · All refuses writes · capability and
 * apply-mode gates (no refresh off Naukri, apply off → no run, real apply on an
 * unproven platform refused, dry run allowed) · schedule ticks a platform
 * cannot do are dropped · per-platform settings never touch Naukri's.
 */
require('dotenv').config();
process.noDeprecation = true;
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run with NODE_ENV=prod'); process.exit(1); }
const URI = process.env.MONGODB_URI_DEV;
if (!URI) { console.error('MONGODB_URI_DEV is not set'); process.exit(1); }

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

const userId = new mongoose.Types.ObjectId();

// Outboxes live in ~/.job-leads; set aside any real ones for the run.
const OUTBOXES = ['naukri', 'instahyre', 'hirist'].map(p => path.join(os.homedir(), '.job-leads', `${p}-outbox.json`));
const saved = new Map();

// One worker module per platform: it reads PLATFORM at require time.
function loadWorker(platform) {
  for (const k of Object.keys(require.cache)) {
    if (/worker[\\/](platform|naukri)-worker\.js$/.test(k)) delete require.cache[k];
  }
  process.env.PLATFORM = platform;
  return require('../worker/platform-worker');
}

async function main() {
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const NaukriRun = require('../models/NaukriRun');
  const NaukriConfig = require('../models/NaukriConfig');
  const NaukriWorker = require('../models/NaukriWorker');
  const { isPlatform } = require('../lib/platforms');

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.userId = userId; next(); });
  const withPlatform = (fixed) => (req, res, next) => {
    const p = fixed || req.params.platform;
    if (p !== 'all' && !isPlatform(p)) return res.status(404).json({ error: `Unknown platform: ${p}` });
    req.platform = p; next();
  };
  app.use('/api/naukri', withPlatform('naukri'), require('../routes/naukri'));
  app.use('/api/p/:platform', withPlatform(), require('../routes/naukri'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.OUTREACH_URL = base;
  process.env.PLATFORM_STUB = '1';
  process.env.NAUKRI_STUB_JOBS = '6';
  process.env.NAUKRI_RETRY_WAITS = '50,50,50';
  for (const f of OUTBOXES) if (fs.existsSync(f)) { saved.set(f, fs.readFileSync(f)); fs.rmSync(f); }

  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  };
  const api = (platform) => (platform === 'naukri' ? '/api/naukri' : `/api/p/${platform}`);
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  const claimAndRun = (platform) => quiet(async () => {
    const c = await call('POST', `${api(platform)}/claim`, { host: 'test', chromeUp: true, loggedIn: true });
    if (!c.run) return { claimed: c };
    const w = loadWorker(platform);
    await w.executeRun({ ...c.run, jobs: c.jobs || [], budget: c.budget || null }, c.config || {}, null);
    return { claimed: c, run: await NaukriRun.findById(c.run.id).lean() };
  });

  try {
    console.log('\nrouting');
    ok('unknown platform → 404', (await call('GET', '/api/p/monster/overview')).status === 404);
    ok('All refuses a config write', (await call('PATCH', '/api/p/all/config', { searches: [] })).status === 400);
    ok('All lists jobs', (await call('GET', '/api/p/all/jobs')).status === 200);
    const reg = await call('GET', '/api/naukri/platforms');
    ok('/platforms lists every platform, only Naukri on by default',
      reg.platforms && reg.platforms.length === require('../lib/platforms').PLATFORM_IDS.length && reg.platforms.find(p => p.id === 'naukri').enabled
      && reg.platforms.filter(p => p.id !== 'naukri').every(p => !p.enabled), JSON.stringify((reg.platforms || []).map(p => [p.id, p.enabled])));

    console.log('\nsettings stay per platform');
    await call('PATCH', '/api/naukri/config', { searches: [{ keywords: 'backend engineer' }], profile: { skills: ['node'] }, apply: { maxPerRun: 20 } });
    const off = await call('POST', '/api/p/instahyre/runs', { kind: 'harvest' });
    ok('a platform that is off cannot run', off.status === 409, off.error);
    await call('PATCH', '/api/p/instahyre/config', { enabled: true, searches: [{ keywords: 'platform engineer' }], apply: { maxPerRun: 3 }, sources: { searches: true, recommended: true } });
    const nCfg = (await call('GET', '/api/naukri/config')).config;
    const iCfg = (await call('GET', '/api/p/instahyre/config')).config;
    ok('Naukri keeps its own searches and budget', nCfg.searches[0].keywords === 'backend engineer' && nCfg.apply.maxPerRun === 20);
    ok('Instahyre has its own', iCfg.searches[0].keywords === 'platform engineer' && iCfg.apply.maxPerRun === 3);
    ok('profile is shared', iCfg.profile.skills.includes('node'));
    ok('Instahyre starts with apply off', iCfg.applyMode === 'off' && nCfg.applyMode === 'on', `${iCfg.applyMode} / ${nCfg.applyMode}`);

    console.log('\nsame site id on two platforms = two rows');
    await call('POST', '/api/naukri/runs', { kind: 'harvest' });
    const hn = await claimAndRun('naukri');
    ok('Naukri harvest done', hn.run && hn.run.status === 'done', hn.run && hn.run.error);
    await call('POST', '/api/p/instahyre/runs', { kind: 'harvest' });
    const hi = await claimAndRun('instahyre');
    ok('Instahyre harvest done', hi.run && hi.run.status === 'done', hi.run && hi.run.error);
    ok('Instahyre run is tagged', hi.run && hi.run.platform === 'instahyre');
    const nJobs = await NaukriJob.find({ userId, platform: 'naukri' }).lean();
    const iJobs = await NaukriJob.find({ userId, platform: 'instahyre' }).lean();
    ok('both stored, apart', nJobs.length > 0 && iJobs.length > 0, `${nJobs.length} / ${iJobs.length}`);
    ok('stub-0 exists on both, keyed by platform',
      nJobs.some(j => j.sourceKey === 'naukri:stub-0') && iJobs.some(j => j.sourceKey === 'instahyre:stub-0'));
    ok('recruiter interest ingested as its own origin', iJobs.some(j => (j.origins || []).includes('recruiter')));

    console.log('\nlists and counts see only their own platform');
    // A row from before platforms existed: no platform field at all.
    await NaukriJob.collection.insertOne({ userId, sourceId: 'legacy-1', sourceKey: 'naukri:legacy-1', title: 'Legacy Engineer', approval: 'pending', applyStatus: 'none', deleted: false, lastSeenAt: new Date(), firstSeenAt: new Date() });
    const ln = await call('GET', '/api/naukri/jobs?approval=pending&limit=200');
    const li = await call('GET', '/api/p/instahyre/jobs?approval=pending&limit=200');
    const la = await call('GET', '/api/p/all/jobs?approval=pending&limit=200');
    ok('Naukri list has no Instahyre rows', ln.jobs.every(j => j.platform === 'naukri'), [...new Set(ln.jobs.map(j => j.platform))].join());
    ok('a row with no platform is Naukri\'s', ln.jobs.some(j => j.sourceKey === 'naukri:legacy-1') && !li.jobs.some(j => j.sourceKey === 'naukri:legacy-1'));
    ok('Instahyre list is only Instahyre', li.jobs.length === iJobs.filter(j => j.approval === 'pending').length && li.jobs.every(j => j.platform === 'instahyre'));
    ok('All has both', la.total === ln.total + li.total, `${la.total} vs ${ln.total}+${li.total}`);
    const on = await call('GET', '/api/naukri/overview');
    const oi = await call('GET', '/api/p/instahyre/overview');
    ok('overview counts are per platform', on.reviewCount === ln.total && oi.reviewCount === li.total, `${on.reviewCount}/${ln.total} ${oi.reviewCount}/${li.total}`);
    ok('run history is per platform', on.history.every(r => r.platform === 'naukri') && oi.history.every(r => r.platform === 'instahyre'));

    console.log('\ncapabilities and apply mode');
    ok('no refresh on Instahyre', (await call('POST', '/api/p/instahyre/runs', { kind: 'refresh' })).status === 409);
    ok('apply off → no apply run', (await call('POST', '/api/p/instahyre/runs', { kind: 'apply' })).status === 409);
    // A platform whose real apply is not proven (capabilities.apply false) —
    // simulated in this process, since both added sites now have it.
    const caps = require('../lib/platforms').PLATFORMS.instahyre.capabilities;
    caps.apply = false;
    ok('real apply on an unproven platform is refused', (await call('PATCH', '/api/p/instahyre/config', { applyMode: 'on' })).status === 400);
    caps.apply = true;
    ok('dry run can be switched on', (await call('PATCH', '/api/p/instahyre/config', { applyMode: 'dry-run' })).config.applyMode === 'dry-run');
    await call('POST', '/api/p/instahyre/jobs/decide', { ids: iJobs.slice(0, 2).map(j => String(j._id)), decision: 'approved' });
    const da = await claimAndRun('instahyre');
    ok('approving queued an Instahyre dry run', da.run && da.run.kind === 'apply' && da.run.dryRun === true, da.run && JSON.stringify({ k: da.run.kind, d: da.run.dryRun }));
    ok('dry run finished and sent nothing', da.run && da.run.status === 'done' && (da.run.stats.rehearsed || 0) > 0 && (da.run.stats.applied || 0) === 0,
      da.run && JSON.stringify(da.run.stats));
    ok('no Instahyre job marked applied', !(await NaukriJob.exists({ userId, platform: 'instahyre', applyStatus: 'applied' })));
    const sch = await call('PATCH', '/api/p/instahyre/config', { schedule: { runRefresh: true, runHarvest: true, enabled: true } });
    ok('a schedule tick the platform cannot do is dropped', sch.config.schedule.runRefresh === false && sch.config.schedule.enabled === true);
    ok('Naukri schedule untouched', (await call('GET', '/api/naukri/config')).config.schedule.runRefresh === true);

    console.log('\na captcha on one platform blocks only that one');
    process.env.NAUKRI_STUB_CHECKPOINT = '1';
    await call('POST', '/api/p/instahyre/runs', { kind: 'harvest' });
    const cp = await claimAndRun('instahyre');
    delete process.env.NAUKRI_STUB_CHECKPOINT;
    ok('Instahyre run blocked', cp.run && cp.run.status === 'blocked', cp.run && cp.run.status);
    const wi = await NaukriWorker.findOne({ userId, platform: 'instahyre' }).lean();
    const wn = await NaukriWorker.findOne({ userId, platform: 'naukri' }).lean();
    ok('Instahyre worker blocked for a week', wi && wi.blockedUntil && wi.blockedUntil > new Date(Date.now() + 6 * 86400000));
    ok('Naukri worker not blocked', wn && !wn.blockedUntil);
    ok('Instahyre claim idles', !!(await call('POST', '/api/p/instahyre/claim', { host: 'test' })).blockedUntil);
    ok('Instahyre buttons refuse', (await call('POST', '/api/p/instahyre/runs', { kind: 'harvest' })).status === 423);
    await call('POST', '/api/naukri/runs', { kind: 'track' });
    const nt = await claimAndRun('naukri');
    ok('Naukri still claims and runs', nt.run && nt.run.status === 'done' && nt.run.kind === 'track', nt.run && nt.run.error);
    await call('PATCH', '/api/p/hirist/config', { enabled: true, searches: [{ keywords: 'sre' }], sources: { searches: true, recommended: false } });
    await call('POST', '/api/p/hirist/runs', { kind: 'harvest' });
    const hh = await claimAndRun('hirist');
    ok('Hirist still claims and runs', hh.run && hh.run.status === 'done' && hh.run.platform === 'hirist', hh.run && hh.run.error);
    ok('Hirist with its job feed unticked harvested searches only', (await NaukriJob.find({ userId, platform: 'hirist' }).lean()).every(j => !(j.origins || []).includes('recommended')));
    ok('Naukri overview not blocked', !(await call('GET', '/api/naukri/overview')).blockedUntil);

    console.log('\nturning a platform off');
    await call('PATCH', '/api/p/hirist/config', { enabled: false });
    ok('a switched-off platform claims nothing', (await call('POST', '/api/p/hirist/claim', { host: 'test' })).disabled === true);
    ok('its jobs are kept', await NaukriJob.exists({ userId, platform: 'hirist' }));
  } finally {
    await Promise.all([
      NaukriJob.deleteMany({ userId }), NaukriRun.deleteMany({ userId }),
      NaukriConfig.deleteMany({ userId }), NaukriWorker.deleteMany({ userId }),
      require('../models/Notification').deleteMany({ userId }).catch(() => {}),
      require('../models/Issue') ? require('../models/Issue').deleteMany({ userId }).catch(() => {}) : null,
    ].filter(Boolean)).catch(() => {});
    for (const f of OUTBOXES) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
    for (const [f, data] of saved) fs.writeFileSync(f, data);
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
