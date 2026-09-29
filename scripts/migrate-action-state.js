#!/usr/bin/env node
/**
 * One-time migration: puts every existing replied conversation into the Needs you queue
 * (Contact.action, lastInboundAt, lastOutboundAt — see lib/actionQueue.js).
 *
 * New replies get their place as they arrive. Without this, every conversation from before
 * the queue existed would be missing from the Mailbox tabs, so the list would start empty
 * and wrong. Each contact is placed from its own history, with the same rules a live reply
 * goes through:
 *   1. its category decides the starting place (as of their latest reply)
 *   2. if you wrote after that, the "you replied" rule runs (as of your latest message)
 *   3. a status you set by hand wins: closed / no-openings are done
 *   4. someone in the Interviews section is done here — that section tracks them
 *   5. a reply older than --stale-days (default 90) that is still open is done, so the
 *      first view isn't months of history nobody is going to answer now
 *
 * Contacts that already have an action are left alone, so it is safe to re-run.
 * Dry run unless --execute. Take a restore point first:  node scripts/clone-db.js --execute
 *
 *   node scripts/migrate-action-state.js
 *   node scripts/migrate-action-state.js --execute
 *   node scripts/migrate-action-state.js --env=dev --stale-days=60 --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const actionQueue = require('../lib/actionQueue');
const { loadInterviewSets, isInInterview } = require('../lib/interviewGuard');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const STALE_DAYS = Number(value('stale-days') || 90);
const BATCH = 500;

const latest = (entries, direction) => {
  const times = entries.filter(t => t.direction === direction && t.at).map(t => new Date(t.at).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

/** Where one contact belongs, and why — the reason is only for the dry-run summary. */
function place(c, now, inInterview) {
  const thread = c.thread || [];
  const lastInboundAt = latest(thread, 'inbound') || c.repliedAt;
  const outs = [latest(thread, 'outbound'), c.lastSentAt].filter(Boolean).map(d => new Date(d).getTime());
  const lastOutboundAt = outs.length ? new Date(Math.max(...outs)) : null;
  const done = (reason) => ({ state: 'done', reason, since: lastInboundAt, dueAt: null, resolvedBy: 'manual' });

  let action; let why;
  if (inInterview) { action = done('in-interview'); why = 'in Interviews'; }
  else if (['closed', 'no-openings'].includes(c.status)) { action = done('manual'); why = `status ${c.status}`; }
  else {
    const verdict = c.replyClassifierOk && c.replyCategory
      ? { success: true, category: c.replyCategory }
      : { success: false };
    action = actionQueue.onInbound(null, verdict, lastInboundAt).action;
    why = verdict.success ? `category ${c.replyCategory}` : 'unclassified';
    if (lastOutboundAt && lastOutboundAt > lastInboundAt) {
      const answered = actionQueue.onOutbound(action, lastOutboundAt, lastInboundAt, now);
      if (answered) { action = answered; why += ', you replied'; }
    }
    const open = actionQueue.bucketOf(action, now) !== 'done';
    if (open && now - new Date(lastInboundAt) > STALE_DAYS * 24 * 3600 * 1000) {
      action = { ...done('stale'), resolvedBy: 'auto' }; why = `older than ${STALE_DAYS} days`;
    }
  }
  return { set: { action, lastInboundAt, lastOutboundAt }, why };
}

(async () => {
  if (!URI) {
    console.error(`No MONGODB_URI_${ENV.toUpperCase()} in the environment.`);
    process.exit(1);
  }
  await mongoose.connect(URI);
  console.log(`connected to ${ENV}${EXECUTE ? '' : '  (DRY RUN — pass --execute to write)'}\n`);

  const now = new Date();
  const filter = { deleted: { $ne: true }, repliedAt: { $ne: null }, 'action.state': { $nin: actionQueue.STATES } };
  const contacts = await Contact.find(filter, {
    userId: 1, status: 1, repliedAt: 1, lastSentAt: 1, replyCategory: 1, replyClassifierOk: 1,
    'thread.direction': 1, 'thread.at': 1, email: 1,
  }).lean();
  console.log(`  replied contacts without a queue place: ${contacts.length}`);

  const interviewSets = new Map();
  const buckets = {}; const reasons = {};
  const ops = [];
  for (const c of contacts) {
    const uid = String(c.userId);
    if (!interviewSets.has(uid)) interviewSets.set(uid, await loadInterviewSets(c.userId));
    const inInterview = isInInterview({ id: c._id, email: c.email }, interviewSets.get(uid));
    const { set, why } = place(c, now, inInterview);
    const bucket = actionQueue.bucketOf(set.action, now);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    reasons[`${bucket} ← ${why}`] = (reasons[`${bucket} ← ${why}`] || 0) + 1;
    ops.push({ updateOne: { filter: { _id: c._id, userId: c.userId, 'action.state': { $nin: actionQueue.STATES } }, update: { $set: set } } });
  }

  console.log('\n  would land in:');
  for (const b of actionQueue.QUEUE_BUCKETS) console.log(`    ${b.padEnd(10)} ${buckets[b] || 0}`);
  console.log('\n  because:');
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);

  if (EXECUTE && ops.length) {
    let modified = 0;
    for (let i = 0; i < ops.length; i += BATCH) {
      const res = await Contact.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
      modified += res.modifiedCount || 0;
    }
    const left = await Contact.countDocuments(filter);
    console.log(`\n  modified: ${modified}   still without a place: ${left}`);
    if (left !== 0) { console.log('\nMISMATCH — some contacts were not placed. Investigate before trusting the Mailbox tabs.'); await mongoose.disconnect(); process.exit(1); }
    console.log('\nverified: every replied contact has a place.');
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('\nMIGRATION ERROR:', e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
