#!/usr/bin/env node
/**
 * lib/userSending.js — the admin's pause/resume of one account's sending.
 *
 * Asserts that pause touches only live work, and that resume brings back only
 * what the admin paused: a batch the user paused by hand, or Gmail's quota
 * paused, stays exactly as it was.
 *
 * Dev database ONLY. No server needed. The planted batches have nothing
 * pending, so resume finishes them as done instead of dispatching Inngest events.
 *   node scripts/test-user-sending.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const URI = process.env.MONGODB_URI_DEV;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const expect = (cond, m) => (cond ? ok(m) : bad(m));

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });

  const SendJob = require('../models/SendJob');
  const Campaign = require('../models/Campaign');
  const { pauseAllForUser, resumeAllForUser, adminPausedCounts } = require('../lib/userSending');
  const { QUOTA_REASON } = require('../lib/sendQuota');

  const userId = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  const creds = { senderEmail: 'x@example.invalid', senderAppPassword: 'enc' };
  const sentItem = [{ contactId: 'c1', to: 'a@example.invalid', name: 'a', subject: 's', body: 'b', status: 'sent' }];

  const [live, liveNoCreds, handPaused, quotaPaused, done, otherLive] = await SendJob.create([
    { userId, status: 'processing', items: sentItem, ...creds },
    { userId, status: 'pending', items: sentItem },
    { userId, status: 'paused', pauseReason: null, items: sentItem, ...creds },
    { userId, status: 'paused', pauseReason: QUOTA_REASON, items: sentItem, ...creds },
    { userId, status: 'done', items: sentItem, ...creds },
    { userId: other, status: 'processing', items: sentItem, ...creds },
  ]);
  const [running, userPausedCampaign, otherRunning] = await Campaign.create([
    { userId, name: 't', templateKey: 'x', status: 'running' },
    { userId, name: 't', templateKey: 'x', status: 'paused' },
    { userId: other, name: 't', templateKey: 'x', status: 'running' },
  ]);
  const get = async (M, d) => M.findById(d._id).lean();

  try {
    console.log('\nPause:');
    const p = await pauseAllForUser(userId);
    expect(p.jobs === 2 && p.campaigns === 1, `paused 2 batches and 1 campaign (got ${p.jobs}, ${p.campaigns})`);
    expect((await get(SendJob, live)).pauseReason === 'admin', 'a live batch is admin-paused');
    expect((await get(SendJob, handPaused)).pauseReason === null, 'a hand-paused batch keeps its own pause');
    expect((await get(SendJob, quotaPaused)).pauseReason === QUOTA_REASON, 'a quota-paused batch keeps the quota pause');
    expect((await get(SendJob, done)).status === 'done', 'a finished batch is untouched');
    expect((await get(SendJob, otherLive)).status === 'processing', "another account's batch is untouched");
    expect((await get(Campaign, running)).pausedByAdmin === true, 'the running campaign is marked admin-paused');
    expect((await get(Campaign, userPausedCampaign)).pausedByAdmin === false, "the user's own paused campaign is not marked");
    expect((await get(Campaign, otherRunning)).status === 'running', "another account's campaign is untouched");
    const c = await adminPausedCounts(userId);
    expect(c.jobs === 2 && c.campaigns === 1, 'adminPausedCounts agrees');

    console.log('\nResume:');
    const r = await resumeAllForUser(userId);
    expect(r.jobsDone === 1, `the batch with nothing pending finished as done (got ${r.jobsDone})`);
    expect(r.jobsNoCredentials === 1, 'the batch with no stored credentials was left for the user');
    expect((await get(SendJob, liveNoCreds)).pauseReason === 'admin', '...and is still admin-paused');
    expect((await get(SendJob, handPaused)).status === 'paused', 'the hand-paused batch stays paused');
    expect((await get(SendJob, quotaPaused)).pauseReason === QUOTA_REASON, 'the quota-paused batch stays with the watcher');
    // No CampaignRows are pending, so resume completes it, the same as the user's own resume.
    const rc = await get(Campaign, running);
    expect(rc.status === 'completed' && rc.pausedByAdmin === false, `the admin-paused campaign is released (status ${rc.status})`);
    expect((await get(Campaign, userPausedCampaign)).status === 'paused', "the user's own paused campaign stays paused");
  } finally {
    await SendJob.deleteMany({ userId: { $in: [userId, other] } });
    await Campaign.deleteMany({ userId: { $in: [userId, other] } });
    console.log('\nCleaned up.');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
