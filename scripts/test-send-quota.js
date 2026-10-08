#!/usr/bin/env node
/**
 * Tests the Gmail daily-limit pause (lib/sendQuota.js) through the real Inngest
 * handlers, against the DEV database, with SMTP and inngest.send stubbed.
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
const { isQuotaError, QUOTA_REASON, QUOTA_PAUSE_MS } = require('../lib/sendQuota');
const { sendSingleEmail, sendEmailBulk, resumeAfterQuota } = require('../inngest-fns');

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log(`  ok   ${msg}`)) : (fail++, console.log(`  FAIL ${msg}`)); };

const userId = new mongoose.Types.ObjectId();
const SENDER = 'quota-test-sender@example.com';

async function makeJob(n, extra = {}) {
  const contacts = await Contact.insertMany(Array.from({ length: n }, (_, i) => ({
    userId, email: `qt${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}@example.com`, name: `QT ${i}`, status: 'queued',
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

async function main() {
  await db.connect();

  console.log('\nRecognising the error:');
  check(isQuotaError(quotaError()), 'the 550 5.4.5 Gmail reply is a quota error');
  check(isQuotaError(new Error(QUOTA_MSG)), 'recognised from the message alone');
  check(!isQuotaError(Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { responseCode: 550 })), 'a 5.1.1 bad-address bounce is not');
  check(!isQuotaError(new Error('No recipients defined')), '"No recipients defined" is not');

  console.log('\nDrip: the limit pauses instead of failing:');
  const { job, contacts: [a, b, c] } = await makeJob(3);
  const sibling = await makeJob(2);                                         // another campaign, same Gmail account
  const other = await makeJob(1, { senderEmail: 'someone-else@example.com' });
  const handPaused = await makeJob(1, { status: 'paused' });
  events.length = 0;

  await single(job, a);
  smtp = () => { throw quotaError(); };
  const before = Date.now();
  await single(job, b);
  let j = await reload(job._id);
  check(j.items[0].status === 'sent', 'the email before the limit was sent');
  check(j.items[1].status === 'pending' && !j.items[1].error, 'the email that hit the limit stays pending, no error');
  check((await Contact.findById(b._id).lean()).status === 'queued', 'its contact is NOT marked failed');
  check(j.status === 'paused' && j.pauseReason === QUOTA_REASON, 'the job is paused for the Gmail limit');
  const until = new Date(j.pausedUntil).getTime();
  check(until >= before + QUOTA_PAUSE_MS - 1000 && until <= Date.now() + QUOTA_PAUSE_MS + 1000, 'pausedUntil is 24h out');
  check((await reload(sibling.job._id)).status === 'paused', 'a sibling job on the same Gmail account is paused too');
  check((await reload(other.job._id)).status === 'processing', 'a job on a different Gmail account is untouched');
  const hp = await reload(handPaused.job._id);
  check(hp.status === 'paused' && !hp.pauseReason, 'a hand-paused job keeps its manual pause');
  const resumes = events.filter(e => e.name === 'email/quota.resume');
  check(resumes.length === 2, 'one resume is scheduled per paused job');
  check(resumes.every(e => e.ts === until), 'each resume fires at pausedUntil');

  const mailedBefore = mailed.length;
  let threw = null;
  try { await single(job, c); } catch (e) { threw = e; }
  check(!threw, 'an already-scheduled send stands down quietly (no retry storm)');
  check(mailed.length === mailedBefore, 'and never reaches SMTP');
  check((await reload(job._id)).items[2].status === 'pending', 'its item stays pending');

  console.log('\nA second hit does not schedule a second resume:');
  events.length = 0;
  await SendJob.updateOne({ _id: job._id }, { status: 'processing' });   // a worker that slipped past the check
  await single(job, c);
  // The job itself re-pauses (it was live again); the sibling was already paused and is not rescheduled.
  check(events.filter(e => e.name === 'email/quota.resume').length === 1, 'only the job that was live again is rescheduled');
  j = await reload(job._id);
  check(j.items[2].status === 'pending', 'that item is still pending');

  console.log('\nResume:');
  events.length = 0;
  const run = (data) => resumeAfterQuota.fn({ event: { data }, step });
  await run({ jobId: String(job._id), pausedUntil: new Date(until - 5000).toISOString() });
  check((await reload(job._id)).status === 'paused' && events.length === 0, 'a stale resume (old pausedUntil) does nothing');
  await run({ jobId: String(sibling.job._id), pausedUntil: new Date((await reload(sibling.job._id)).pausedUntil).toISOString() });
  const s = await reload(sibling.job._id);
  check(s.status === 'processing' && !s.pauseReason && !s.pausedUntil, 'the matching resume restarts the job and clears the pause');
  check(events.length === 1 && events[0].name === 'email/drip.start' && events[0].data.jobId === String(sibling.job._id), 'it re-dispatches the drip');
  events.length = 0;
  await run({ jobId: String(sibling.job._id), pausedUntil: new Date(until).toISOString() });
  check(events.length === 0, 'firing twice does not dispatch twice');

  console.log('\nOther errors still fail the item:');
  smtp = () => { throw Object.assign(new Error('550 5.1.1 user unknown'), { responseCode: 550 }); };
  const bad = await makeJob(1, { senderEmail: 'other-sender@example.com' });
  await single(bad.job, bad.contacts[0]);
  const bj = await reload(bad.job._id);
  check(bj.items[0].status === 'failed' && bj.status !== 'paused', 'a bad-address error is still a failure');

  console.log('\nBulk:');
  let n = 0;
  smtp = () => { if (++n >= 2) throw quotaError(); return { messageId: '<ok@test>' }; };
  const bulk = await makeJob(4, { senderEmail: 'bulk-sender@example.com', sendMode: 'bulk', chunkSize: 2, status: 'pending' });
  events.length = 0;
  await sendEmailBulk.fn({ event: { data: { jobId: String(bulk.job._id) } }, step });
  const bk = await reload(bulk.job._id);
  check(bk.items.filter(i => i.status === 'sent').length === 1, 'bulk sent the one before the limit');
  check(bk.items.filter(i => i.status === 'pending').length === 3, 'bulk left the other three pending');
  check(n === 2, 'bulk stopped at the first quota error (no further SMTP calls)');
  check(bk.status === 'paused' && bk.pauseReason === QUOTA_REASON, 'bulk job is paused, not done');
  check(events.filter(e => e.name === 'email/quota.resume').length === 1, 'bulk scheduled its resume');
}

main()
  .catch(e => { fail++; console.error(e); })
  .finally(async () => {
    try {
      await Promise.all([
        SendJob.deleteMany({ userId }), Contact.deleteMany({ userId }),
        mongoose.connection.db.collection('issues').deleteMany({ userId }),
        mongoose.connection.db.collection('activitylogs').deleteMany({ userId }),
      ]);
    } catch (e) { console.error('cleanup failed:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  });
