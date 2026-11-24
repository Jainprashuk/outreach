#!/usr/bin/env node
/**
 * Post-apply questionnaires (Cutshort) on the server side. DEV DATABASE ONLY.
 *
 *   node scripts/test-cutshort-questionnaire.js
 *
 * Mounts routes/naukri.js as server.js does on a throwaway local server as a
 * scratch user and deletes every row it made — pass or fail.
 *
 * Covers: an 'open' report puts the question under Needs answer and counts it,
 * while the job stays applied and Skipped does not grow · a thread for a job
 * not from here is ignored · saving a rule takes it off the list without
 * requeueing the applied job · Ignore takes it off the list and never dismisses
 * the applied job · a later 'open' for an ignored question stays off · 'done'
 * keeps what was sent · the meta parses a real thread body.
 */
require('dotenv').config();
process.noDeprecation = true;
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
const Q = 'The location of this job will be remote. Are you okay with this?';
const OPTS = ['I am currently in this location and okay with it', 'I am not in this location but can relocate', 'I am not okay with this location'];

async function main() {
  await mongoose.connect(URI);
  const NaukriJob = require('../models/NaukriJob');
  const NaukriRun = require('../models/NaukriRun');
  const NaukriConfig = require('../models/NaukriConfig');
  const { isPlatform } = require('../lib/platforms');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use('/api/p/:platform', (req, res, next) => {
    if (!isPlatform(req.params.platform)) return res.status(404).json({ error: 'Unknown platform' });
    req.platform = req.params.platform; next();
  }, require('../routes/naukri'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/p/cutshort`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  try {
    const run = await NaukriRun.create({ userId, platform: 'cutshort', kind: 'track', status: 'running' });
    const mk = (sourceId) => NaukriJob.create({
      userId, platform: 'cutshort', sourceId, sourceKey: `cutshort:${sourceId}`, title: `Engineer ${sourceId}`,
      approval: 'approved', applyStatus: 'applied', appliedAt: new Date(),
    });
    const a = await mk('qa1');
    const b = await mk('qa2');
    const overview = async () => (await call('GET', '/overview')).overview || (await call('GET', '/overview'));
    const before = await overview();

    console.log('open questionnaire');
    let r = await call('POST', '/questionnaire', { runId: String(run._id), sourceId: 'qa1', state: 'open', question: Q, options: OPTS });
    ok('reported', r.ok === true, JSON.stringify(r));
    let j = await NaukriJob.findById(a._id).lean();
    ok('job stays applied', j.applyStatus === 'applied');
    ok('question kept on the job', j.questionnaire === 'open' && j.unknownQuestion === Q && j.questionOptions.length === 3);
    const list = await call('GET', '/needs-answer');
    const item = (list.questions || []).find(x => x.question === Q);
    ok('listed under Needs answer', !!item && item.jobs.some(x => x.id === String(a._id)), JSON.stringify(list.questions));
    const after = await overview();
    ok('Needs answer count includes it', after.needsAnswerCount === before.needsAnswerCount + 1, `${before.needsAnswerCount} → ${after.needsAnswerCount}`);
    ok('questionnaireOpenCount says so', after.questionnaireOpenCount === 1);
    ok('Skipped count unchanged', after.skippedCount === before.skippedCount);

    r = await call('POST', '/questionnaire', { runId: String(run._id), sourceId: 'not-ours', state: 'open', question: Q, options: OPTS });
    ok('a thread for a job not from here is ignored', r.ok === false);

    console.log('answering it with a rule');
    r = await call('POST', '/needs-answer/use', { question: Q, answer: 'I am currently in this location and okay with it' });
    ok('rule saved', !!r.rule, JSON.stringify(r));
    j = await NaukriJob.findById(a._id).lean();
    ok('job still applied, not requeued', j.applyStatus === 'applied' && j.approval === 'approved');
    ok('question off the list, still open for the sweep', j.questionnaire === 'open' && !j.unknownQuestion);

    console.log('ignoring a question');
    const Q2 = 'How much experience do you have in Rust?';
    await call('POST', '/questionnaire', { runId: String(run._id), sourceId: 'qa2', state: 'open', question: Q2, options: ['Not much', '1-2 years'] });
    r = await call('POST', '/needs-answer/ignore', { question: Q2 });
    j = await NaukriJob.findById(b._id).lean();
    ok('Ignore never dismisses an applied job', j.applyStatus === 'applied', j.applyStatus);
    ok('Ignore takes it off the list', !j.unknownQuestion);
    await call('POST', '/questionnaire', { runId: String(run._id), sourceId: 'qa2', state: 'open', question: Q2, options: ['Not much', '1-2 years'] });
    j = await NaukriJob.findById(b._id).lean();
    ok('the next sweep does not bring an ignored question back', !j.unknownQuestion);

    console.log('submitted');
    r = await call('POST', '/questionnaire', { runId: String(run._id), sourceId: 'qa1', state: 'done',
      answers: [{ q: Q, a: OPTS[0], by: 'rule' }, { q: 'Notice period?', a: '30 days', by: 'pre-selected' }] });
    j = await NaukriJob.findById(a._id).lean();
    ok('marked done', j.questionnaire === 'done');
    ok('what was sent is kept', j.sentAnswers.length === 2 && j.sentAnswers[0].a === OPTS[0]);
    ok('history says so', /questionnaire submitted \(2 answer/.test(j.applyHistory[j.applyHistory.length - 1].note));

    console.log('meta parses a thread');
    const qn = require('../worker/platforms/cutshort/meta').questionnaire;
    const form = qn.formFrom({ thread: { messages: [
      { responseType: 'text', questions: [] },
      { responseType: 'screening', screeningSubmitted: false, questions: [
        { question: { title: ` ${Q} `, responseType: 'mcq', isMandatory: true, options: OPTS.map((l, i) => ({ _id: `o${i}`, label: l })) }, responseStringArray: ['o2'] },
        { question: { title: 'Current CTC?', responseType: 'text', isMandatory: true }, responseStringArray: [] },
      ] },
    ] } });
    ok('questions read', form && form.questions.length === 2 && form.questions[0].title === Q);
    ok('pre-selection read', form.questions[0].selected[0] === 'o2' && form.submitted === false);
    ok('text question has no options', form.questions[1].type === 'text' && form.questions[1].options.length === 0);
    const threads = qn.threadsFrom({ results: [
      { _id: 't1', lastMsgText: '[Questionnaire]', jobSignal: { _id: 'j1' } },
      { _id: 't2', lastMsgText: 'Hi there', jobSignal: { _id: 'j2' } },
    ] });
    ok('only questionnaire threads listed', threads.length === 1 && threads[0].jobId === 'j1');
  } finally {
    await Promise.all([
      NaukriJob.deleteMany({ userId }), NaukriRun.deleteMany({ userId }), NaukriConfig.deleteMany({ userId }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
