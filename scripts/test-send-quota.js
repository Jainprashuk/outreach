#!/usr/bin/env node
/**
 * Tests the Gmail daily-limit handling (lib/sendQuota.js + the hourly quota
 * watcher) through the real Inngest handlers, against the DEV database, with SMTP
 * and inngest.send stubbed.
 *
 * Everything is written under a throwaway userId and deleted at the end.
 *
 *   node scripts/test-send-quota.js
 */
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run against prod.'); process.exit(1); }
require('dotenv').config();
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { inngest } = require('../inngest');

// ── Stubs ───────────────────────────────────────────────────────────────────
const QUOTA_MSG = 'Data command failed: 550-5.4.5 Daily user sending limit exceeded. For more information on Gmail\n550 5.4.5  https://support.google.com/a/answer/166852 - gsmtp';
const quotaError = () => Object.assign(new Error(QUOTA_MSG), { responseCode: 550, response: QUOTA_MSG, code: 'EMESSAGE' });
let smtp = () => ({ messageId: `<${Math.random()}@test>` });
const mailed = [];
nodemailer.createTransport = () => ({
  sendMail: async (m) => { mailed.push(m.to); return smtp(m); },
  close() {},
});
const events = [];
inngest.send = async (e) => { events.push(...[].concat(e)); };
const step = { run: (_id, cb) => cb(), sendEvent: async (_id, e) => { events.push(...[].concat(e)); } };

const db = require('../db');
const SendJob = require('../models/SendJob');
const Contact = require('../models/Contact');
const { isQuotaError, QUOTA_REASON, resumeNextForAccount, holdBehindQuota } = require('../lib/sendQuota');
const { sendSingleEmail, sendEmailBulk, resumeAfterQuota, quotaWatcher } = require('../inngest-fns');

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log(`  ok   ${msg}`)) : (fail++, console.log(`  FAIL ${msg}`)); };

const userId = new mongoose.Types.ObjectId();
const SENDER = 'quota-test-sender@example.com';
let seq = 0;

async function makeJob(n, extra = {}) {
  const contacts = await Contact.insertMany(Array.from({ length: n }, (_, i) => ({
    userId, email: `qt${Date.now()}-${seq++}-${i}@example.com`, name: `QT ${i}`, status: 'queued',
  })));
  const job = await SendJob.create({
    userId, senderEmail: SENDER, senderName: 'QT', senderAppPassword: 'x', status: 'processing', sendMode: 'drip',
    items: contacts.map(c => ({ contactId: String(c._id), to: c.email, name: c.name, subject: 's', body: 'b' })),
    ...extra,
  });
  return { job, contacts };
}
const reload = (id) => SendJob.findById(id).lean();
const single = (job, c) => sendSingleEmail.fn({ event: { data: { jobId: String(job._id), contactId: String(c._id) } }, step });
const watcher = () => quotaWatcher.fn({ step });
const pendingOf = (j) => j.items.filter(i => i.status === 'pending').length;
// Make paused jobs due for the watcher without waiting an hour.
const makeDue = () => SendJob.updateMany({ userId, pauseReason: QUOTA_REASON }, { $set: { pausedUntil: new Date(Date.now() - 1000) } });
// Let a resumed drip actually run: the stub dispatch only records drip.start, so
// deliver the first pending item the way the orchestrator would.
async function runFirstPending(jobId) {
  const j = await reload(jobId);
  const item = j.items.find(i => i.status === 'pending');
  if (item) await sendSingleEmail.fn({ event: { data: { jobId: String(jobId), contactId: item.contactId } }, step });
}

async function main() {
  await db.connect();

  console.log('\nRecognising the error:');
  check(isQuotaError(quotaError()), 'the 550 5.4.5 Gmail reply is a quota error');
  check(!isQuotaError(Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { responseCode: 550 })), 'a 5.1.1 bounce is not');

  console.log('\nThe limit pauses, and books nothing:');
  const A = await makeJob(3);
  const B = await makeJob(2);
  const other = await makeJob(1, { senderEmail: 'someone-else@example.com' });
  const handPaused = await makeJob(1, { status: 'paused' });
  events.length = 0;
  await single(A.job, A.contacts[0]);
  smtp = () => { throw quotaError(); };
  await single(A.job, A.contacts[1]);
  let a = await reload(A.job._id);
  check(a.items[0].status === 'sent' && a.items[1].status === 'pending', 'sent before the limit; the refused one stays pending');
  check(a.status === 'paused' && a.pauseReason === QUOTA_REASON, 'batch A paused for the limit');
  check((await reload(B.job._id)).status === 'paused', 'batch B on the same Gmail account paused too');
  check((await reload(other.job._id)).status === 'processing', 'a different Gmail account is untouched');
  check(!(await reload(handPaused.job._id)).pauseReason, 'a hand-paused batch keeps its manual pause');
  check(!events.some(e => e.name === 'email/quota.resume'), 'no delayed resume is booked');
  check(new Date(a.pausedUntil) > new Date(), 'pausedUntil = earliest retry, in the future');

  console.log('\nWatcher, limit still active:');
  await SendJob.updateOne({ _id: other.job._id }, { status: 'done' });
  events.length = 0;
  await watcher();
  check(events.length === 0, 'before pausedUntil the watcher does nothing');
  await makeDue();
  await watcher();
  a = await reload(A.job._id);
  check(a.status === 'processing' && a.quotaProbe === true, 'it resumes the OLDEST batch (A) as a probe');
  check((await reload(B.job._id)).status === 'paused', 'B stays paused (one at a time)');
  check(events.filter(e => e.name === 'email/drip.start').length === 1, 'exactly one batch dispatched');
  await runFirstPending(A.job._id);
  a = await reload(A.job._id);
  check(a.status === 'paused' && pendingOf(a) === 2 && a.items.every(i => i.status !== 'failed'), 'Gmail still refuses → A re-paused, nothing failed');

  console.log('\nWatcher, limit passed:');
  smtp = () => ({ messageId: `<${Math.random()}@test>` });
  await makeDue();
  events.length = 0;
  await watcher();
  await runFirstPending(A.job._id);
  a = await reload(A.job._id);
  check(a.status === 'processing' && !a.quotaProbe, 'first email goes through → A keeps sending, probe cleared');
  const notes = await mongoose.connection.db.collection('notifications').find({ userId, type: 'send.resumed' }).toArray();
  check(notes.length === 1, 'one "Sending resumed" notification');
  events.length = 0;
  await makeDue();
  await watcher();
  check(events.length === 0 && (await reload(B.job._id)).status === 'paused', 'while A is sending, B is not started');
  await runFirstPending(A.job._id);
  check((await reload(A.job._id)).status === 'done', 'A finishes');
  await watcher();
  check((await reload(B.job._id)).status === 'processing', 'next tick starts B');

  console.log('\nOne notification per day, not per retry:');
  const paused = await mongoose.connection.db.collection('notifications').countDocuments({ userId, type: 'send.quota_paused' });
  check(paused === 1, `"limit reached" notified once (got ${paused})`);

  console.log('\nSafety:');
  const C = await makeJob(1, { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil: new Date(Date.now() - 1000), senderEmail: 'race@example.com' });
  events.length = 0;
  await Promise.all([
    resumeNextForAccount({ userId, senderEmail: 'race@example.com' }),
    resumeNextForAccount({ userId, senderEmail: 'race@example.com' }),
  ]);
  check(events.filter(e => e.name === 'email/drip.start').length === 1, 'two concurrent ticks dispatch once');
  const stuck = await makeJob(2, { senderEmail: 'stuck@example.com' });
  await SendJob.collection.updateOne({ _id: stuck.job._id }, { $set: { updatedAt: new Date(Date.now() - 6 * 3_600_000) } });
  const D = await makeJob(1, { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil: new Date(Date.now() - 1000), senderEmail: 'stuck@example.com' });
  await resumeNextForAccount({ userId, senderEmail: 'stuck@example.com' });
  check((await reload(D.job._id)).status === 'processing', 'a batch whose worker died does not block the queue for ever');
  events.length = 0;
  await resumeAfterQuota.fn({ event: { data: { jobId: String(C.job._id), pausedUntil: new Date().toISOString() } }, step });
  check(events.length === 0, 'an old email/quota.resume booking does nothing');

  console.log('\nCampaign release while the account is waiting:');
  const E = await makeJob(1, { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil: new Date(Date.now() + 3_600_000), senderEmail: 'hold@example.com' });
  const fresh = await makeJob(2, { status: 'pending', senderEmail: 'hold@example.com' });
  check(await holdBehindQuota(fresh.job) === true, 'a new batch is held');
  const f = await reload(fresh.job._id);
  check(f.status === 'paused' && f.pauseReason === QUOTA_REASON, 'it joins the line as limit-paused');
  const free = await makeJob(1, { status: 'pending', senderEmail: 'free@example.com' });
  check(await holdBehindQuota(free.job) === false && (await reload(free.job._id)).status === 'pending', 'an account with nothing waiting sends normally');
  void E;

  console.log('\nBulk:');
  let n = 0;
  smtp = () => { if (++n >= 2) throw quotaError(); return { messageId: '<ok@test>' }; };
  const bulk = await makeJob(4, { senderEmail: 'bulk-sender@example.com', sendMode: 'bulk', chunkSize: 2, status: 'pending' });
  await sendEmailBulk.fn({ event: { data: { jobId: String(bulk.job._id) } }, step });
  const bk = await reload(bulk.job._id);
  check(bk.items.filter(i => i.status === 'sent').length === 1 && pendingOf(bk) === 3, 'bulk: 1 sent, 3 left pending');
  check(n === 2 && bk.status === 'paused' && bk.pauseReason === QUOTA_REASON, 'bulk stops at the limit and pauses');
}

main()
  .catch(e => { fail++; console.error(e); })
  .finally(async () => {
    try {
      await Promise.all([
        SendJob.deleteMany({ userId }), Contact.deleteMany({ userId }),
        mongoose.connection.db.collection('issues').deleteMany({ userId }),
        mongoose.connection.db.collection('activitylogs').deleteMany({ userId }),
        mongoose.connection.db.collection('notifications').deleteMany({ userId }),
      ]);
    } catch (e) { console.error('cleanup failed:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  });
