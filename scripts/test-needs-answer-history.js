#!/usr/bin/env node
/**
 * Needs answer: the AI's history per question, "you answered something like
 * this" suggestions, and reworded questions answered by an existing rule.
 *
 * No AI is called: attempts are planted the way routes/naukri.js saveDraft
 * writes them.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-needs-answer-history.js --base=http://localhost:4099
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
  const email = `needs-answer-${Date.now()}@example.invalid`;
  const { insertedId: uid } = await db.collection('users').insertOne({
    email, name: '', isAdmin: false, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  const Q_HISTORY = 'Do you have experience with Kubernetes in production?';
  const Q_SIMILAR = 'How many years of experience in React Native?';
  const Q_REWORDED = 'Years of experience with ReactJS?';
  const Q_OTHER = 'What is your preferred work shift?';

  try {
    const cookie = await loginViaOtp({ base: BASE, email });
    const call = async (method, path, body) => {
      const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    await call('GET', '/api/naukri/overview');   // creates the config row
    await db.collection('naukriconfigs').updateOne({ userId: uid }, { $set: {
      aiDrafts: false,
      answers: [{ pattern: 'how many years of experience do you have in react', answer: '3', kind: 'number', enabled: true, origin: 'you', createdAt: new Date() }],
      drafts: [{
        question: Q_HISTORY, answer: '', quote: '', source: '', status: 'unknown', confidence: 0, options: [], basis: 'x', createdAt: new Date(),
        attempts: [
          { at: new Date(), where: 'page', outcome: 'rejected', answer: 'Yes', quote: '3 years of Kubernetes', confidence: 90, why: 'quote-not-found' },
          { at: new Date(Date.now() - 3600000), where: 'apply', outcome: 'below-bar', answer: 'Yes', quote: 'Docker, Kubernetes', confidence: 70, why: '' },
        ],
      }],
    } });
    const job = (n, q) => ({
      userId: uid, platform: 'naukri', sourceId: `na-${n}`, sourceKey: `naukri:na-${n}`, title: `Job ${n}`, company: 'Co',
      approval: 'approved', applyStatus: 'skipped', unknownQuestion: q, questionOptions: [], deleted: false,
      applyHistory: [], createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('naukrijobs').insertMany([job(1, Q_HISTORY), job(2, Q_SIMILAR), job(3, Q_REWORDED), job(4, Q_OTHER)]);

    console.log('History and suggestions:');
    const r = await call('GET', '/api/naukri/needs-answer');
    const byQ = Object.fromEntries((r.data.questions || []).map(q => [q.question, q]));
    const h = byQ[Q_HISTORY];
    check(h && h.attempts.length === 2 && h.attempts[0].why === 'quote-not-found' && h.attempts[1].where === 'apply',
      'the AI attempts come back, newest first, with where and why');
    check(h && h.draft === null, 'a stale draft is not offered as the draft, but its history still shows');
    const s = byQ[Q_SIMILAR];
    check(s && s.similar.length === 1 && s.similar[0].answer === '3', 'React Native gets "you answered a question like this" → 3');
    check(byQ[Q_OTHER] && byQ[Q_OTHER].similar.length === 0, 'an unrelated question gets no suggestion');

    console.log('\nReworded question:');
    // Any new answer re-checks every parked job against the whole bank.
    const used = await call('POST', '/api/naukri/needs-answer/use', { question: Q_OTHER, answer: 'Day shift' });
    check(used.status === 200, 'saving an answer works');
    const reworded = await db.collection('naukrijobs').findOne({ userId: uid, sourceId: 'na-3' });
    check(reworded.applyStatus === 'none', 'the job parked on "Years of experience with ReactJS?" is back in Waiting (the React rule answers it)');
    const similar = await db.collection('naukrijobs').findOne({ userId: uid, sourceId: 'na-2' });
    check(similar.applyStatus === 'skipped', 'the React Native job is NOT — similar is only a suggestion');

    console.log('\nThe answer tester agrees:');
    const t = await call('POST', '/api/naukri/config/test-answer', { question: Q_REWORDED });
    check(t.status === 200 && JSON.stringify(t.data).includes('"3"'), `POST /config/test-answer answers the reworded question (${JSON.stringify(t.data).slice(0, 120)})`);
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
