#!/usr/bin/env node
/**
 * End-to-end test of the Naukri flow, server + worker loop, with the STUB
 * driver (no browser, nothing real is applied to). DEV DATABASE ONLY.
 *
 *   node scripts/test-naukri-flow.js
 *
 * Mounts routes/naukri.js on a throwaway local server as a scratch user that
 * exists only for this run, drives the real worker loop (executeRun from
 * worker/naukri-worker.js) against it, and deletes every row it made at the
 * end — pass or fail. It never talks to OUTREACH_URL, so it cannot reach prod.
 *
 * Covers: scoring + auto-approve at ingest · the apply budget skipping
 * company-site jobs · a question skip parking the job (not retried) · Needs
 * answer grouping with options · Use → rule → requeue → applied · dismiss ·
 * a schedule slot that comes due during an active run waiting instead of
 * being spent · pollSeconds on claim.
 */
require('dotenv').config();
process.noDeprecation = true;   // mongoose's `new` option warnings drown the output
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run with NODE_ENV=prod'); process.exit(1); }
const URI = process.env.MONGODB_URI_DEV;
if (!URI) { console.error('MONGODB_URI_DEV is not set'); process.exit(1); }

const express = require('express');
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

const userId = new mongoose.Types.ObjectId();

async function main() {
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const NaukriRun = require('../models/NaukriRun');
  const NaukriConfig = require('../models/NaukriConfig');

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use('/api/naukri', require('../routes/naukri'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // The worker module reads these at require time. Pointed at the local
  // server, never the .env OUTREACH_URL.
  process.env.OUTREACH_URL = base;
  process.env.NAUKRI_STUB = '1';
  process.env.NAUKRI_STUB_JOBS = '9';
  const { executeRun } = require('../worker/naukri-worker');

  const call = async (method, path, body) => {
    const res = await fetch(base + '/api/naukri' + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || `${path} ${res.status}`), { status: res.status, data });
    return data;
  };
  const claimAndRun = async () => {
    const c = await call('POST', '/claim', { host: 'test', chromeUp: true, naukriLoggedIn: true });
    if (!c.run) return { claimed: c };
    await executeRun({ ...c.run, jobs: c.jobs || [] }, c.config || {}, null);
    return { claimed: c, run: await NaukriRun.findById(c.run.id).lean() };
  };
  const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };
  const runQuiet = quiet(claimAndRun);

  try {
    console.log('\nsetup');
    await call('PATCH', '/config', {
      searches: [{ keywords: 'backend engineer', location: 'bangalore' }],
      profile: { skills: ['node', 'mongodb', 'express'], totalExperienceMonths: 60, expectedCtcLpa: 10 },
      filters: { maxPostedAgeDays: 30 },
      apply: { autoApproveEnabled: true, autoApproveMinScore: 60, maxPerRun: 20, maxPerDay: 50 },
      worker: { pollSeconds: 45 },
    });
    ok('pollSeconds comes back on claim', (await call('POST', '/claim', { host: 'test' })).pollSeconds === 45);

    console.log('\nharvest → score → auto-approve');
    await call('POST', '/runs', { kind: 'harvest' });
    const h = await runQuiet();
    ok('harvest run done', h.run && h.run.status === 'done', h.run && h.run.error);
    const jobs = await NaukriJob.find({ userId }).lean();
    ok('9 jobs stored', jobs.length === 9, `got ${jobs.length}`);
    ok('every job scored with reasons', jobs.every(j => typeof j.score === 'number' && j.scoreReasons.length), JSON.stringify(jobs.map(j => j.score)));
    const auto = jobs.filter(j => j.approvedBy === 'auto');
    ok('high scorers auto-approved', auto.length > 0 && auto.every(j => j.score >= 60 && j.approval === 'approved'), `auto ${auto.length}`);
    ok('low scorers left in the inbox', jobs.filter(j => j.score < 60).every(j => j.approval === 'pending'));
    ok('run stat counts auto-approvals', h.run.stats.autoApproved === auto.length, `${h.run.stats.autoApproved} vs ${auto.length}`);

    console.log('\nWaiting excludes predicted company-site jobs');
    // Approve everything, then mark one as a known company-site employer's.
    await call('POST', '/jobs/decide', { ids: jobs.map(j => String(j._id)), decision: 'approved' });
    const ext = jobs[0];
    await NaukriJob.updateOne({ _id: ext._id }, { $set: { likelyExternal: true, priority: 0 } });
    const a1 = await runQuiet();
    ok('apply run done', a1.run && a1.run.status === 'done', a1.run && a1.run.error);
    ok('company-site job not handed out', !(a1.claimed.jobs || []).some(j => j.id === String(ext._id)));
    const handed = (a1.claimed.jobs || []).length;
    ok('the rest were handed out', handed === 8, `handed ${handed}`);

    console.log('\nquestion skip parks the job');
    const skipped = await NaukriJob.find({ userId, applyStatus: 'skipped' }).lean();
    ok('every third job skipped on the question', skipped.length === Math.floor(handed / 3) && skipped.length > 0, `got ${skipped.length}`);
    ok('question and options recorded', skipped.every(j => j.unknownQuestion && j.questionOptions.join() === 'Yes,No'));
    await call('POST', '/runs', { kind: 'apply' });
    const a2 = await runQuiet();
    ok('a second apply run was claimed', !!a2.run);
    ok('a skipped job is NOT retried before it is answered', !(a2.claimed.jobs || []).some(j => skipped.some(s => String(s._id) === j.id)),
      `claimed ${(a2.claimed.jobs || []).length}`);

    console.log('\nNeeds answer → Use → requeue → applied');
    const na = await call('GET', '/needs-answer');
    ok('one group for the one question', na.questions.length === 1 && na.questions[0].count === skipped.length, JSON.stringify(na.questions.map(q => q.count)));
    ok('group carries the options', na.questions[0].options.join() === 'Yes,No');
    await call('PATCH', '/config', { aiDrafts: false });
    let refused = false;
    try { await call('POST', '/needs-answer/draft', { question: na.questions[0].question }); } catch (e) { refused = e.status === 409; }
    ok('draft refused while AI drafts are off', refused);
    let bad = false;
    try { await call('POST', '/needs-answer/use', { question: na.questions[0].question, answer: 'Yes', pattern: 'kubernetes' }); } catch (e) { bad = e.status === 400; }
    ok('a pattern that does not match the question is refused', bad);
    const used = await call('POST', '/needs-answer/use', { question: na.questions[0].question, answer: 'Yes' });
    ok('Use re-queues every blocked job', used.requeued === skipped.length, `requeued ${used.requeued}`);
    const cfg = await NaukriConfig.findOne({ userId }).lean();
    ok('rule added at the top', cfg.answers[0].answer === 'Yes');
    await call('POST', '/runs', { kind: 'apply' });
    const a3 = await runQuiet();
    const after = await NaukriJob.find({ _id: { $in: skipped.map(s => s._id) } }).lean();
    ok('re-queued jobs went first and applied', after.every(j => j.applyStatus === 'applied'), after.map(j => j.applyStatus).join());
    ok('history keeps the question', after.every(j => j.applyHistory.some(h => /answer added for/.test(h.note))));
    ok('Needs answer is now empty', (await call('GET', '/needs-answer')).questions.length === 0);
    ok('a3 claimed only what was waiting', (a3.claimed.jobs || []).length === skipped.length, `${(a3.claimed.jobs || []).length}`);

    console.log('\ndismiss');
    await NaukriJob.updateOne({ _id: ext._id }, { $set: { applyStatus: 'skipped', applyNote: 'Applies on the company site — x', retryable: false } });
    await call('POST', '/jobs/bulk', { ids: [String(ext._id)], action: 'dismiss' });
    const dis = await NaukriJob.findById(ext._id).lean();
    ok('dismissed skip leaves Skipped', dis.applyStatus === 'dismissed');
    const ov = await call('GET', '/overview');
    ok('overview skipped count excludes it', ov.skippedCount === 0, `got ${ov.skippedCount}`);
    ok('overview carries the week', ov.week.applied >= 1 && typeof ov.week.skipped === 'number', JSON.stringify(ov.week));

    console.log('\nrecommended jobs, same flow');
    let none = false;
    try { await call('POST', '/runs', { kind: 'harvest', sources: { searches: false, recommended: false } }); } catch (e) { none = e.status === 400; }
    ok('a harvest with no source is refused', none);
    await call('POST', '/runs', { kind: 'harvest', sources: { searches: false, recommended: true } });
    const hr = await runQuiet();
    ok('recommended-only harvest done', hr.run && hr.run.status === 'done' && hr.run.stats.recommended === 3, JSON.stringify(hr.run && hr.run.stats));
    ok('run remembers its own sources', hr.run.sources && hr.run.sources.recommended === true && hr.run.sources.searches === false);
    const rec = await NaukriJob.find({ userId, origins: 'recommended' }).lean();
    ok('3 recommended jobs stored, marked recommended only', rec.length === 3 && rec.every(j => j.origins.join() === 'recommended'), rec.map(j => j.origins.join('+')).join(' '));
    ok('recommended jobs scored', rec.every(j => typeof j.score === 'number' && j.scoreReasons.length), rec.map(j => j.score).join());
    const told = rec.find(j => j.sourceId === 'stub-rec-2');
    ok('a job Naukri marks "company site" is flagged on arrival', told && told.likelyExternal === true);
    const listRec = await call('GET', '/jobs?origin=recommended&q=platform');
    ok('inbox filters by origin, together with search text', listRec.total === 3 && listRec.originCounts.recommended === 3, JSON.stringify(listRec.originCounts));
    await call('PATCH', '/config', { sources: { searches: true, recommended: true } });
    await call('POST', '/runs', { kind: 'harvest' });
    const hb = await runQuiet();
    ok('default "both" harvest done', hb.run && hb.run.status === 'done', hb.run && hb.run.error);
    const both = await NaukriJob.findOne({ userId, sourceId: 'stub-0' }).lean();
    ok('a job found both ways carries both origins', both.origins.includes('search') && both.origins.includes('recommended'), both.origins.join());
    let bad2 = false;
    try { await call('PATCH', '/config', { sources: { searches: false, recommended: false } }); } catch (e) { bad2 = e.status === 400; }
    ok('settings refuse turning both sources off', bad2);
    const recIds = rec.map(j => String(j._id));
    await call('POST', '/jobs/decide', { ids: recIds, decision: 'approved' });
    const ar = await runQuiet();
    // Same rules as any job: one whose employer is a known company-site one
    // (its company was flagged earlier in this test) is held back.
    const recNow = await NaukriJob.find({ _id: { $in: rec.map(j => j._id) } }).lean();
    const nativeIds = recNow.filter(j => !j.likelyExternal).map(j => String(j._id));
    const claimedIds = (ar.claimed.jobs || []).map(j => j.id);
    ok('native recommended jobs apply through the same run', nativeIds.length > 0 && nativeIds.every(id => claimedIds.includes(id)), `${claimedIds.length} claimed`);
    ok('a company-site recommended job is held back like any other', recNow.filter(j => j.likelyExternal).every(j => !claimedIds.includes(String(j._id))));
    ok('and they come out applied or parked on the question', recNow.filter(j => !j.likelyExternal).every(j => ['applied', 'skipped'].includes(j.applyStatus)), recNow.map(j => j.applyStatus).join());

    console.log('\nschedule slot during an active run waits');
    const now = new Date();
    const ist = new Date(now.getTime() - 60_000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    await call('PATCH', '/config', { schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: ist, catchUpHours: 2, runRefresh: false, runHarvest: true, runApply: false } });
    await NaukriConfig.updateOne({ userId }, { $set: { 'schedule.lastFiredAt': null } });
    await NaukriRun.create({ userId, kind: 'refresh', trigger: 'manual', status: 'running', claimedAt: new Date() });
    await call('POST', '/claim', { host: 'test' });
    let c2 = await NaukriConfig.findOne({ userId }).lean();
    ok('busy slot not spent', c2.schedule.lastFiredAt === null);
    ok('no scheduled run created while busy', !(await NaukriRun.exists({ userId, trigger: 'scheduled' })));
    await NaukriRun.updateMany({ userId, status: 'running' }, { $set: { status: 'done' } });
    const fired = await call('POST', '/claim', { host: 'test' });
    c2 = await NaukriConfig.findOne({ userId }).lean();
    ok('fires once the run ends', fired.run && fired.run.kind === 'harvest' && fired.run.trigger === 'scheduled', JSON.stringify(fired.run && fired.run.kind));
    ok('and stamps the slot', !!c2.schedule.lastFiredAt);
  } finally {
    server.close();
    const db = mongoose.connection.db;
    for (const c of ['naukrijobs', 'naukriruns', 'naukriconfigs', 'naukriworkers', 'notifications', 'issues']) {
      await db.collection(c).deleteMany({ userId }).catch(() => {});
    }
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => { console.error(err); process.exit(1); });
