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
  // Network trouble on demand: drop the next N /result requests by cutting the
  // connection — after the server has processed them when `afterProcessing`,
  // so the worker never sees the reply (the case that must not double-count).
  const flaky = { drop: 0, afterProcessing: false };
  app.use('/api/naukri/result', (req, res, next) => {
    if (flaky.drop <= 0) return next();
    flaky.drop--;
    if (!flaky.afterProcessing) return req.socket.destroy();
    const end = res.json.bind(res);
    res.json = () => { req.socket.destroy(); return res; };
    next();
    void end;
  });
  app.use('/api/naukri', require('../routes/naukri'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // The worker module reads these at require time. Pointed at the local
  // server, never the .env OUTREACH_URL.
  process.env.OUTREACH_URL = base;
  process.env.NAUKRI_STUB = '1';
  process.env.NAUKRI_STUB_JOBS = '9';
  process.env.NAUKRI_RETRY_WAITS = '50,50,50';
  process.env.HOME_OUTBOX_NOTE = 'the outbox lives in ~/.job-leads; the test restores it';
  const { executeRun, flushOutbox, readOutbox, OUTBOX_FILE } = require('../worker/naukri-worker');
  const fsx = require('fs');
  const savedOutbox = fsx.existsSync(OUTBOX_FILE) ? fsx.readFileSync(OUTBOX_FILE) : null;
  if (savedOutbox) fsx.rmSync(OUTBOX_FILE);

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
    // A draft written before the resume/profile it should have used is stale:
    // reported as missing so the tab drafts it again.
    const q0 = skipped[0].unknownQuestion;
    await NaukriConfig.updateOne({ userId }, { $push: { drafts: { question: q0, status: 'unknown', basis: 'old-resume' } } });
    ok('a stale "unknown" draft is not shown — it gets redrafted', (await call('GET', '/needs-answer')).questions[0].draft === null);
    await NaukriConfig.updateOne({ userId }, { $set: { drafts: [{ question: q0, status: 'ignored' }] } });
    ok('an ignored question stays ignored', (await call('GET', '/needs-answer')).questions[0].draft?.status === 'ignored');
    await NaukriConfig.updateOne({ userId }, { $set: { drafts: [] } });
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

    console.log('\nresume: the one in Settings is used');
    const Settings = require('../models/Settings');
    const pdf = await new Promise((resolve) => {
      const PDF = require('pdfkit'); const d = new PDF(); const parts = [];
      d.on('data', c => parts.push(c)); d.on('end', () => resolve(Buffer.concat(parts)));
      d.text('Senior Engineer at Acme (2019 - 2024). Skills: Node.js, MongoDB.'); d.end();
    });
    await Settings.updateOne({ userId }, { $set: { userId, resume: { filename: 'cv.pdf', contentType: 'application/pdf', data: pdf, size: pdf.length, uploadedAt: new Date('2026-10-01') } } }, { upsert: true });
    let g = await call('GET', '/config');
    ok('card shows the Settings resume', g.config.resume.source === 'settings' && g.config.resume.filename === 'cv.pdf');
    ok('its text is read for AI drafts', /Acme/.test(g.config.resume.text), JSON.stringify(g.config.resume.text).slice(0, 80));
    const dl = await fetch(base + '/api/naukri/worker-resume');
    ok('the worker downloads the Settings file', dl.ok && (await dl.arrayBuffer()).byteLength === pdf.length);
    await call('PATCH', '/config', { resumeText: 'Typed by me: 6 years React.' });
    await Settings.updateOne({ userId }, { $set: { 'resume.uploadedAt': new Date('2026-10-05') } });
    g = await call('GET', '/config');
    ok('typed text is kept even when the Settings file changes', g.config.resume.text === 'Typed by me: 6 years React.');
    await call('PATCH', '/config', { resumeText: '' });
    g = await call('GET', '/config');
    ok('clearing the text reads the file again', /Acme/.test(g.config.resume.text));

    console.log('\nnetwork blips mid-run');
    let seq = 0;
    const fresh = async (n) => {
      const docs = await NaukriJob.insertMany(Array.from({ length: n }, () => {
        const id = `net-${++seq}`;
        return { userId, sourceId: id, sourceKey: `naukri:${id}`, title: `Network test ${seq}`, company: `NetCo ${seq}`,
          url: `https://www.naukri.com/job-listings-${id}`, approval: 'approved', approvedAt: new Date(), priority: 5 };
      }));
      return docs.map(d => String(d._id));
    };
    await NaukriJob.updateMany({ userId, ...{ approval: 'approved', applyStatus: { $in: ['none', 'failed'] } } }, { $set: { approval: 'pending' } });
    await fresh(3);
    await call('POST', '/runs', { kind: 'apply' });
    flaky.drop = 2; flaky.afterProcessing = false;
    const f1 = await runQuiet();
    ok('two dropped result reports are retried; the run finishes', f1.run && f1.run.status === 'done', f1.run && f1.run.error);
    ok('every job recorded exactly once', f1.run.results.length === (f1.claimed.jobs || []).length, `${f1.run.results.length} vs ${(f1.claimed.jobs || []).length}`);

    const more = await fresh(2);
    await call('POST', '/runs', { kind: 'apply' });
    flaky.drop = 1; flaky.afterProcessing = true;
    const f2 = await runQuiet();
    const hist = await NaukriJob.find({ _id: { $in: more } }).lean();
    ok('a report the server took but whose reply was lost is not counted twice',
      f2.run.status === 'done' && f2.run.results.length === (f2.claimed.jobs || []).length
      && hist.every(j => j.applyHistory.filter(h => ['applied', 'skipped'].includes(h.to)).length === 1),
      `${f2.run.results.length} results, history ${hist.map(j => j.applyHistory.length).join(',')}`);

    const last = await fresh(2);
    await call('POST', '/runs', { kind: 'apply' });
    flaky.drop = 99; flaky.afterProcessing = false;
    const f3 = await runQuiet();
    ok('a long outage stops the run with a plain reason', f3.run.status === 'failed' && /Lost the connection/.test(f3.run.error || ''), f3.run.error);
    ok('…and the undelivered result is saved on this Mac', readOutbox().length === 1, `${readOutbox().length} saved`);
    flaky.drop = 0;
    await quiet(flushOutbox)();
    ok('…then delivered once the connection is back', readOutbox().length === 0
      && (await NaukriJob.countDocuments({ _id: { $in: last }, applyStatus: { $ne: 'none' } })) === 1);

    console.log('\nlive AI answers during apply');
    // A scripted AI, so each case is exact: the server's /ai-answer calls
    // naukriDraft.draftAnswer through the module object.
    const naukriDraft = require('../lib/naukriDraft');
    const realDraft = naukriDraft.draftAnswer;
    let aiCalls = 0, aiReply = null;
    naukriDraft.draftAnswer = async () => { aiCalls++; if (aiReply instanceof Error) throw aiReply; return aiReply; };
    const QUESTION = 'Do you have experience with SAP?';
    try {
      await NaukriConfig.updateOne({ userId }, { $set: { answers: [], drafts: [] } });
      await NaukriJob.updateMany({ userId, approval: 'approved', applyStatus: { $in: ['none', 'failed'] } }, { $set: { approval: 'pending' } });

      // Off: the question still skips the job, and the AI is never asked.
      await call('PATCH', '/config', { autoAnswer: { enabled: false } });
      const offIds = await fresh(3);
      await call('POST', '/runs', { kind: 'apply' });
      await runQuiet();
      const offJobs = await NaukriJob.find({ _id: { $in: offIds } }).lean();
      ok('auto-answer off: the question skips the job as before', offJobs.filter(j => j.applyStatus === 'skipped').length === 1 && aiCalls === 0,
        offJobs.map(j => j.applyStatus).join() + ` · AI calls ${aiCalls}`);

      // On, 92% sure: answered in the same run and saved as an auto rule.
      await call('PATCH', '/config', { autoAnswer: { enabled: true, minConfidence: 85 } });
      aiReply = { status: 'ready', answer: 'No', quote: 'Skills: Node.js, MongoDB', source: 'resume', confidence: 92 };
      const onIds = await fresh(6);
      await call('POST', '/runs', { kind: 'apply' });
      const on = await runQuiet();
      const onJobs = await NaukriJob.find({ _id: { $in: onIds } }).lean();
      ok('92% sure: every job applied in the same run, none skipped', onJobs.every(j => j.applyStatus === 'applied'), onJobs.map(j => j.applyStatus).join());
      ok('…the AI was asked once; the second job with the question reused the answer', aiCalls === 1, `AI calls ${aiCalls}`);
      ok('…and the outcome says it was AI', on.run.results.some(r => /answered by AI \(92%\)/.test(r.reason)));
      const cfgOn = await NaukriConfig.findOne({ userId }).lean();
      ok('…saved at the top as an auto rule with its %', cfgOn.answers[0].origin === 'auto' && cfgOn.answers[0].confidence === 92 && cfgOn.answers[0].answer === 'No');
      ok('…and the job parked on it earlier went back to Waiting',
        (await NaukriJob.countDocuments({ _id: { $in: offIds }, applyStatus: 'skipped' })) === 0);
      const na2 = await call('GET', '/needs-answer');
      ok('…listed under Auto-answered for review', na2.autoAnswered.length === 1 && na2.autoAnswered[0].confidence === 92);
      await call('POST', '/needs-answer/auto', { pattern: na2.autoAnswered[0].pattern, action: 'keep' });
      ok('Keep makes it your answer', (await call('GET', '/needs-answer')).autoAnswered.length === 0
        && (await NaukriConfig.findOne({ userId }).lean()).answers[0].origin === 'you');

      // On, but only 70% sure: skipped, and the draft keeps its 70%.
      await NaukriConfig.updateOne({ userId }, { $set: { answers: [], drafts: [] } });
      aiCalls = 0;
      aiReply = { status: 'ready', answer: 'No', quote: 'Skills: Node.js, MongoDB', source: 'resume', confidence: 70 };
      const lowIds = await fresh(3);
      await call('POST', '/runs', { kind: 'apply' });
      await runQuiet();
      const lowJobs = await NaukriJob.find({ _id: { $in: lowIds } }).lean();
      const cfgLow = await NaukriConfig.findOne({ userId }).lean();
      ok('70% sure (bar 85): the job is skipped', lowJobs.filter(j => j.applyStatus === 'skipped').length === 1);
      ok('…no rule saved, and the draft shows 70%', cfgLow.answers.length === 0 && cfgLow.drafts.some(d => d.question === QUESTION && d.confidence === 70));

      // A job already parked (the 70% case above). With auto-answer OFF a new
      // 95% draft just waits; switching auto-answer ON uses it on the next look.
      await call('PATCH', '/config', { autoAnswer: { enabled: false }, aiDrafts: true });
      aiReply = { status: 'ready', answer: 'No', quote: 'Skills: Node.js, MongoDB', source: 'resume', confidence: 95 };
      const waitDraft = await call('POST', '/needs-answer/draft', { question: QUESTION });
      ok('auto-answer off: a 95% draft just waits for you', !waitDraft.autoUsed
        && (await NaukriJob.countDocuments({ _id: { $in: lowIds }, applyStatus: 'skipped' })) === 1);
      await call('PATCH', '/config', { autoAnswer: { enabled: true, minConfidence: 85 } });
      const promoted = await call('GET', '/needs-answer');
      ok('switched on: the waiting 95% draft is used and its job goes back to Waiting',
        promoted.autoRequeued === 1 && !promoted.questions.some(q => q.question === QUESTION)
        && promoted.autoAnswered.some(x => x.confidence === 95)
        && (await NaukriJob.countDocuments({ _id: { $in: lowIds }, applyStatus: 'none' })) === 1,
        JSON.stringify({ autoRequeued: promoted.autoRequeued }));
      // And a fresh draft written on the page while it is on is used at once.
      await NaukriConfig.updateOne({ userId }, { $set: { answers: [], drafts: [] } });
      await NaukriJob.updateMany({ _id: { $in: lowIds } }, { $set: { applyStatus: 'skipped', unknownQuestion: QUESTION, questionOptions: ['Yes', 'No'] } });
      const now95 = await call('POST', '/needs-answer/draft', { question: QUESTION });
      ok('on: a new 95% draft on the page is used straight away', now95.autoUsed === true && now95.requeued >= 1);
      await NaukriJob.updateMany({ _id: { $in: lowIds } }, { $set: { applyStatus: 'applied' } });
      await NaukriConfig.updateOne({ userId }, { $set: { answers: [], drafts: [] } });   // no rule for the next case

      // The AI failing outright: skipped, the run still finishes.
      aiReply = new Error('provider down');
      const errIds = await fresh(3);
      await call('POST', '/runs', { kind: 'apply' });
      const er = await runQuiet();
      ok('AI failing: the job is skipped and the run finishes', er.run.status === 'done'
        && (await NaukriJob.countDocuments({ _id: { $in: errIds }, applyStatus: 'skipped' })) === 1,
        `${er.run.status} ${er.run.error || ''} · ${(await NaukriJob.find({ _id: { $in: errIds } }).lean()).map(j => j.applyStatus).join()} · claimed ${(er.claimed.jobs || []).length}`);

      // The per-run cap.
      const capped = await NaukriRun.create({ userId, kind: 'apply', status: 'running', claimedAt: new Date(), 'stats.aiAsked': 15 });
      aiReply = { status: 'ready', answer: 'No', quote: 'Skills: Node.js, MongoDB', source: 'resume', confidence: 99 };
      aiCalls = 0;
      const capRes = await call('POST', '/ai-answer', { runId: String(capped._id), question: QUESTION, options: ['Yes', 'No'] });
      ok('the 16th AI question in one run is refused without calling the AI', capRes.answer === null && /limit/.test(capRes.reason) && aiCalls === 0);
      await NaukriRun.updateOne({ _id: capped._id }, { $set: { status: 'done' } });
    } finally {
      naukriDraft.draftAnswer = realDraft;
    }

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
    try { fsx.rmSync(OUTBOX_FILE, { force: true }); if (savedOutbox) fsx.writeFileSync(OUTBOX_FILE, savedOutbox); } catch (_) {}
    const db = mongoose.connection.db;
    for (const c of ['naukrijobs', 'naukriruns', 'naukriconfigs', 'naukriworkers', 'notifications', 'issues', 'settings']) {
      await db.collection(c).deleteMany({ userId }).catch(() => {});
    }
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => { console.error(err); process.exit(1); });
