#!/usr/bin/env node
/**
 * The same role on two job platforms. DEV DATABASE ONLY, stub drivers only.
 *
 *   node scripts/test-platform-dedupe.js
 *
 * Part 1 (no DB): title normalisation — what counts as the same role.
 * Part 2: mounts routes/naukri.js as server.js does, on a scratch user, and
 * checks that a duplicate is flagged on read (never dropped), that
 * auto-approve leaves it in the inbox, that an apply run skips a job another
 * platform already applied to with the reason saying so, and that "Apply
 * anyway" puts it back. Deletes every row it made.
 */
require('dotenv').config();
process.noDeprecation = true;
const { normTitle, dupKeyOf } = require('../lib/jobDupes');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

function part1() {
  console.log('\nwhat counts as the same role');
  const same = (a, b) => dupKeyOf(a) && dupKeyOf(a) === dupKeyOf(b);
  ok('Sr. = Senior, bracketed aside dropped',
    same({ company: 'Acme', title: 'Sr. Backend Engineer (Node.js)' }, { company: 'Acme', title: 'Senior Backend Engineer' }));
  ok('SDE II = Software Engineer 2',
    same({ company: 'Acme', title: 'SDE II' }, { company: 'Acme', title: 'Software Engineer 2' }));
  ok('trailing " - Bangalore" dropped',
    same({ company: 'Acme', title: 'Platform Engineer - Bangalore' }, { company: 'Acme', title: 'Platform Engineer' }));
  ok('company spellings fold (Pvt Ltd, case)',
    same({ company: 'Acme Systems Pvt Ltd', title: 'SRE' }, { company: 'ACME SYSTEMS', title: 'SRE' }), `${dupKeyOf({ company: 'Acme Systems Pvt Ltd', title: 'SRE' })} vs ${dupKeyOf({ company: 'ACME SYSTEMS', title: 'SRE' })}`);
  ok('different title at the same company is NOT a duplicate',
    !same({ company: 'Acme', title: 'Backend Engineer' }, { company: 'Acme', title: 'Frontend Engineer' }));
  ok('developer is not folded into engineer',
    !same({ company: 'Acme', title: 'Backend Developer' }, { company: 'Acme', title: 'Backend Engineer' }));
  ok('same title at another company is NOT a duplicate',
    !same({ company: 'Acme', title: 'Backend Engineer' }, { company: 'Globex', title: 'Backend Engineer' }));
  ok('no company → no key (never matches everything)', dupKeyOf({ company: '', title: 'Engineer' }) === '');
  ok('normTitle is stable', normTitle('  Full-Stack  Dev  ') === 'full stack dev' || normTitle('  Full-Stack  Dev  ') === 'fullstack dev', normTitle('  Full-Stack  Dev  '));
}

async function part2() {
  if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run with NODE_ENV=prod'); process.exit(1); }
  const URI = process.env.MONGODB_URI_DEV;
  if (!URI) { console.log('\n(skipping part 2: MONGODB_URI_DEV is not set)'); return; }
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const express = require('express');
  const mongoose = require('mongoose');
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const NaukriRun = require('../models/NaukriRun');
  const NaukriConfig = require('../models/NaukriConfig');
  const NaukriWorker = require('../models/NaukriWorker');
  const { isPlatform } = require('../lib/platforms');
  const userId = new mongoose.Types.ObjectId();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
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
  process.env.OUTREACH_URL = base;
  process.env.PLATFORM_STUB = '1';
  process.env.NAUKRI_STUB_JOBS = '6';
  process.env.NAUKRI_RETRY_WAITS = '50,50,50';
  const OUTBOXES = ['naukri', 'instahyre'].map(p => path.join(os.homedir(), '.job-leads', `${p}-outbox.json`));
  const saved = new Map();
  for (const f of OUTBOXES) if (fs.existsSync(f)) { saved.set(f, fs.readFileSync(f)); fs.rmSync(f); }

  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const api = (p) => (p === 'naukri' ? '/api/naukri' : `/api/p/${p}`);
  const loadWorker = (platform) => {
    for (const k of Object.keys(require.cache)) if (/worker[\\/](platform|naukri)-worker\.js$/.test(k)) delete require.cache[k];
    process.env.PLATFORM = platform;
    return require('../worker/platform-worker');
  };
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  const claimAndRun = (platform) => quiet(async () => {
    const c = await call('POST', `${api(platform)}/claim`, { host: 'test', chromeUp: true, loggedIn: true });
    if (!c.run) return { claimed: c };
    await loadWorker(platform).executeRun({ ...c.run, jobs: c.jobs || [], budget: c.budget || null }, c.config || {}, null);
    return { claimed: c, run: await NaukriRun.findById(c.run.id).lean() };
  });

  try {
    console.log('\nsetup: the same stub roles on Naukri and Instahyre');
    await call('PATCH', '/api/naukri/config', { searches: [{ keywords: 'backend engineer' }], profile: { skills: ['node', 'mongodb', 'express'], totalExperienceMonths: 60 }, filters: { maxPostedAgeDays: 30 } });
    await call('PATCH', '/api/p/instahyre/config', {
      enabled: true, searches: [{ keywords: 'backend engineer' }], sources: { searches: true, recommended: false },
      filters: { maxPostedAgeDays: 30 }, apply: { autoApproveEnabled: true, autoApproveMinScore: 50 },
    });
    await call('POST', '/api/naukri/runs', { kind: 'harvest' });
    await claimAndRun('naukri');
    const nJobs = await NaukriJob.find({ userId, platform: 'naukri' }).lean();
    ok('Naukri rows carry a dupKey', nJobs.length && nJobs.every(j => j.dupKey), nJobs.map(j => j.dupKey).join());

    // Apply to one Naukri role (stub driver), approve another.
    const appliedRole = nJobs.find(j => j.sourceId === 'stub-0');
    const approvedRole = nJobs.find(j => j.sourceId === 'stub-1');
    await NaukriJob.updateOne({ _id: appliedRole._id }, { $set: { approval: 'approved', applyStatus: 'applied', appliedAt: new Date() } });
    await NaukriJob.updateOne({ _id: approvedRole._id }, { $set: { approval: 'approved', approvedAt: new Date() } });

    console.log('\nflagged at ingest, never dropped');
    await call('POST', '/api/p/instahyre/runs', { kind: 'harvest' });
    const h = await claimAndRun('instahyre');
    ok('Instahyre harvest done', h.run && h.run.status === 'done', h.run && h.run.error);
    const iJobs = await NaukriJob.find({ userId, platform: 'instahyre' }).lean();
    ok('every Instahyre copy kept', iJobs.length === 6, `${iJobs.length}`);
    const dupApplied = iJobs.find(j => j.dupKey === appliedRole.dupKey);
    const dupApproved = iJobs.find(j => j.dupKey === approvedRole.dupKey && j.dupKey !== appliedRole.dupKey);
    ok('auto-approve skipped the one applied on Naukri', dupApplied && dupApplied.approval === 'pending', dupApplied && dupApplied.approval);
    ok('auto-approve skipped the one approved on Naukri', dupApproved && dupApproved.approval === 'pending', dupApproved && dupApproved.approval);
    const free = iJobs.filter(j => j.dupKey !== appliedRole.dupKey && j.dupKey !== approvedRole.dupKey && j.score >= 50 && !j.likelyExternal);
    ok('a copy whose twin is only pending is still auto-approved', free.length > 0 && free.every(j => j.approvedBy === 'auto'),
      JSON.stringify(free.map(j => [j.score, j.approval])));

    const list = await call('GET', '/api/p/instahyre/jobs?approval=pending&limit=100');
    const row = list.jobs.find(j => j.id === String(dupApplied._id));
    ok('list shows "Already applied via Naukri on …"', row && row.dup && row.dup.state === 'applied' && /^Already applied via Naukri on \d+ \w+/.test(row.dup.text), row && JSON.stringify(row.dup));
    const row2 = list.jobs.find(j => j.id === String(dupApproved._id));
    ok('list shows "Approved on Naukri"', row2 && row2.dup && row2.dup.text === 'Approved on Naukri', row2 && JSON.stringify(row2.dup));
    const nList = await call('GET', '/api/naukri/jobs?approval=pending&limit=100');
    const back = nList.jobs.find(j => j.dupKey === dupApplied.dupKey);
    ok('a pending Naukri copy shows "Also on Instahyre"', !back || (back.dup && back.dup.state === 'pending' && /Also on Instahyre/.test(back.dup.text)), back && JSON.stringify(back.dup));

    console.log('\nskipped at apply time when another platform applied first');
    // Simulate Instahyre having applied, and a Naukri copy waiting to go.
    const waiting = nJobs.find(j => j.sourceId === 'stub-2');
    const instaCopy = iJobs.find(j => j.dupKey === waiting.dupKey);
    await NaukriJob.updateOne({ _id: instaCopy._id }, { $set: { approval: 'approved', applyStatus: 'applied', appliedAt: new Date() } });
    await NaukriJob.updateOne({ _id: waiting._id }, { $set: { approval: 'approved', approvedAt: new Date(), applyStatus: 'none', likelyExternal: false } });
    await call('POST', '/api/naukri/runs', { kind: 'apply' });
    const a = await claimAndRun('naukri');
    ok('apply run done', a.run && a.run.status === 'done', a.run && a.run.error);
    ok('the duplicate was not handed to the worker', !(a.claimed.jobs || []).some(j => j.id === String(waiting._id)));
    const after = await NaukriJob.findById(waiting._id).lean();
    ok('it is Skipped with the reason', after.applyStatus === 'skipped' && /^Already applied via Instahyre/.test(after.applyNote), `${after.applyStatus}: ${after.applyNote}`);
    ok('…and not retried', after.retryable === false);
    ok('the run records it', a.run.results.some(r => String(r.jobId) === String(waiting._id) && /Already applied via Instahyre/.test(r.reason)) && a.run.stats.dupSkipped === 1,
      JSON.stringify(a.run.stats));

    console.log('\n"Apply anyway"');
    const any = await call('POST', '/api/naukri/jobs/bulk', { ids: [String(waiting._id)], action: 'allow-duplicate' });
    ok('put back in Waiting', any.updated === 1);
    await call('POST', '/api/naukri/runs', { kind: 'apply' });
    const a2 = await claimAndRun('naukri');
    ok('next apply run takes it', (a2.claimed.jobs || []).some(j => j.id === String(waiting._id)), JSON.stringify((a2.claimed.jobs || []).map(j => j.title)));
    ok('and it is applied', (await NaukriJob.findById(waiting._id).lean()).applyStatus === 'applied');

    console.log('\nthe rules can be turned off');
    await call('PATCH', '/api/naukri/config', { duplicates: { blockApply: false, blockAuto: false, windowDays: 30 } });
    const d = (await call('GET', '/api/naukri/platforms')).duplicates;
    ok('duplicates settings saved (shared)', d && d.blockApply === false && d.blockAuto === false && d.windowDays === 30);
  } finally {
    await Promise.all([
      NaukriJob.deleteMany({ userId }), NaukriRun.deleteMany({ userId }),
      NaukriConfig.deleteMany({ userId }), NaukriWorker.deleteMany({ userId }),
      require('../models/Notification').deleteMany({ userId }).catch(() => {}),
      require('../models/Issue').deleteMany({ userId }).catch(() => {}),
    ]).catch(() => {});
    for (const f of OUTBOXES) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
    for (const [f, data] of saved) fs.writeFileSync(f, data);
    server.close();
    await mongoose.disconnect();
  }
}

(async () => {
  part1();
  await part2();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
