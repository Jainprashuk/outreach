#!/usr/bin/env node
/**
 * The Analytics cards added beside the Outreach summary:
 *   lib/queueAnalytics.js     Needs you buckets, reasons and what got closed
 *   lib/campaignAnalytics.js  campaigns, skip reasons, replies, Gmail-limit pauses
 *
 * Runs against a THROWAWAY database, `outreach_analytics_cards_test`, on the DEV
 * cluster (MONGODB_URI_DEV with the database name swapped), created and dropped
 * here. A second account's rows are seeded everywhere and must never be counted.
 *
 *   node scripts/test-analytics-cards.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const SendJob = require('../models/SendJob');
const ActivityLog = require('../models/ActivityLog');
const { queueAnalytics } = require('../lib/queueAnalytics');
const { campaignAnalytics } = require('../lib/campaignAnalytics');

const TEST_DB = 'outreach_analytics_cards_test';
const uri = () => {
  const base = process.env.MONGODB_URI_DEV;
  if (!base) throw new Error('MONGODB_URI_DEV is not set');
  const u = new URL(base);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
};

let passed = 0, failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? `  << ${detail}` : ''}`); }
};
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);
const ahead = (d) => new Date(Date.now() + d * DAY);

async function main() {
  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== TEST_DB) throw new Error(`refusing to run on ${mongoose.connection.name}`);
  await mongoose.connection.dropDatabase();

  const me = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  let n = 0;
  const contact = (o) => ({ userId: me, email: `p${++n}@example.invalid`, name: `P${n}`, ...o });

  console.log('\nNeeds you');
  await Contact.insertMany([
    contact({ action: { state: 'needs-you', reason: 'resume-requested', since: ago(1) } }),
    contact({ action: { state: 'needs-you', reason: 'needs-attention', since: ago(1) } }),
    // your own snooze ran out → back in needs-you, for its reason
    contact({ action: { state: 'snoozed', reason: 'manual', since: ago(5), dueAt: ago(1) } }),
    // waiting past dueAt → follow-up, "no response"
    contact({ action: { state: 'waiting', reason: 'reviewing', since: ago(10), dueAt: ago(2) } }),
    // reconnect snooze past due → follow-up
    contact({ action: { state: 'snoozed', reason: 'reconnect', since: ago(70), dueAt: ago(1) } }),
    contact({ action: { state: 'waiting', reason: 'you-replied', since: ago(1), dueAt: ahead(6) } }),
    contact({ action: { state: 'snoozed', reason: 'manual', since: ago(1), dueAt: ahead(3) } }),
    contact({ action: { state: 'done', reason: 'you-replied', resolvedBy: 'you-replied', since: ago(3) } }),
    contact({ action: { state: 'done', reason: 'declined', resolvedBy: 'auto', since: ago(4) } }),
    contact({ action: { state: 'done', reason: 'manual', resolvedBy: 'manual', since: ago(60) } }), // before the window
    contact({}), // never replied
    contact({ action: { state: 'needs-you', reason: 'resume-requested', since: ago(1) }, deleted: true }),
    { userId: other, name: 'Them', email: 'theirs@example.invalid', action: { state: 'needs-you', reason: 'resume-requested', since: ago(1) } },
  ]);
  const q = await queueAnalytics(Contact, me, { days: 30 });
  ok(q.buckets['needs-you'] === 3 && q.buckets['follow-up'] === 2, 'needs-you and follow-up buckets', JSON.stringify(q.buckets));
  ok(q.buckets.waiting === 1 && q.buckets.snoozed === 1 && q.buckets.done === 3, 'waiting / snoozed / done', JSON.stringify(q.buckets));
  const reason = (b, r) => (q.reasons.find(x => x.bucket === b && x.reason === r) || {}).n || 0;
  ok(reason('follow-up', 'no-response') === 1 && reason('follow-up', 'reconnect') === 1, 'follow-up reasons');
  ok(reason('needs-you', 'resume-requested') === 1 && reason('needs-you', 'manual') === 1, 'needs-you reasons');
  ok(q.resolved.total === 2 && q.resolved.by.length === 2, 'closed in the window, by who', JSON.stringify(q.resolved));

  console.log('\nCampaigns');
  const [c1, c2, old, theirs] = await Campaign.insertMany([
    { userId: me, name: 'Running one', templateKey: 't', status: 'running', stats: { total: 4, released: 3, skipped: 1, pending: 0 }, origin: 'action-center', actionKind: 'followup' },
    { userId: me, name: 'Done one', templateKey: 't', status: 'completed', completedAt: ago(2), stats: { total: 3, released: 1, skipped: 2, pending: 0 } },
    { userId: me, name: 'Old one', templateKey: 't', status: 'completed', completedAt: ago(80), stats: { total: 1, released: 1 } },
    { userId: other, name: 'Theirs', templateKey: 't', status: 'running', stats: { total: 9, released: 9 } },
  ]);
  await Campaign.collection.updateOne({ _id: old._id }, { $set: { createdAt: ago(90) } });
  const replied = await Contact.create(contact({ repliedAt: ago(1), status: 'replied' }));
  const quiet = await Contact.create(contact({ status: 'sent' }));
  const row = (camp, i, o) => ({ userId: camp.userId, campaignId: camp._id, rowIndex: i, ...o });
  await CampaignRow.insertMany([
    row(c1, 0, { email: replied.email, status: 'released', contactId: String(replied._id) }),
    row(c1, 1, { email: quiet.email, status: 'released', contactId: String(quiet._id) }),
    row(c1, 2, { email: 'x@example.invalid', status: 'released', contactId: String(new mongoose.Types.ObjectId()) }),
    row(c1, 3, { email: 'bad', status: 'skipped', skipReason: 'invalid_email' }),
    row(c2, 0, { email: replied.email, status: 'released', contactId: String(replied._id) }),
    row(c2, 1, { email: 'dup@example.invalid', status: 'skipped', skipReason: 'duplicate_contact' }),
    row(c2, 2, { email: 'dup2@example.invalid', status: 'skipped', skipReason: 'duplicate_contact' }),
    row(theirs, 0, { email: 'z@example.invalid', status: 'skipped', skipReason: 'invalid_email' }),
  ]);
  await SendJob.insertMany([
    { userId: me, status: 'paused', pauseReason: 'gmail_daily_limit', items: [] },
    { userId: me, status: 'paused', pauseReason: 'admin', items: [] },
    { userId: me, status: 'paused', items: [] },
    { userId: other, status: 'paused', pauseReason: 'gmail_daily_limit', items: [] },
  ]);
  await ActivityLog.insertMany([
    { userId: me, category: 'email', action: 'quota_paused', message: 'x' },
    { userId: me, category: 'email', action: 'quota_resumed', message: 'x' },
    { userId: other, category: 'email', action: 'quota_paused', message: 'x' },
  ]);

  const c = await campaignAnalytics(me, { days: 30 });
  ok(c.campaigns.length === 2 && !c.campaigns.some(x => x.name === 'Old one' || x.name === 'Theirs'), 'recent campaigns, mine only', c.campaigns.map(x => x.name).join(','));
  const run = c.campaigns.find(x => x.name === 'Running one');
  ok(run.replied === 1 && run.released === 3 && run.replyRate === 33.3, 'replies per campaign', JSON.stringify(run));
  ok(run.originLabel === 'Action Center' && run.actionKind === 'followup', 'Action Center campaigns are labelled');
  ok(c.campaigns.find(x => x.name === 'Done one').replied === 1, 'one contact can count for two campaigns');
  ok(c.totals.skipped === 3 && c.totals.running === 1, 'totals', JSON.stringify(c.totals));
  const skip = (k) => (c.skipReasons.find(r => r.key === k) || {}).n || 0;
  ok(skip('duplicate_contact') === 2 && skip('invalid_email') === 1, 'skip reasons, mine only', JSON.stringify(c.skipReasons));
  ok(c.quota.pauses === 1 && c.quota.lastPausedAt, 'Gmail-limit pauses in the window');
  ok(c.quota.pausedNow.gmailLimit === 1 && c.quota.pausedNow.admin === 1 && c.quota.pausedNow.you === 1, 'paused right now, by why');

  const none = await campaignAnalytics(new mongoose.Types.ObjectId());
  ok(none.campaigns.length === 0 && none.skipReasons.length === 0, 'an account with no campaigns gets empty lists');

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { if (mongoose.connection.name === TEST_DB) await mongoose.connection.dropDatabase(); } catch (_) { /* ignore */ }
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
