/**
 * Parity check for the Stage 1 query narrowing. READ-ONLY — it never writes.
 *
 * The send counters (sent-24h, sendHeadroom, buildTimeline, campaign detail and
 * pause) now fetch `items.status` / `items.processedAt` instead of whole items,
 * and the campaign outcomes $lookup now projects three contact fields instead of
 * the whole contact. The code that consumes those results is unchanged, so if
 * the narrowed queries hand it the same data, its output is the same. This
 * script proves that, job by job and campaign by campaign.
 *
 *   node scripts/parity/stage1-projections.js           # dev database
 *   NODE_ENV=prod node scripts/parity/stage1-projections.js
 *
 * Exits 1 on the first class of mismatch it finds.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const assert = require('assert');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const pick = (items, fields) => (items || []).map(i => Object.fromEntries(fields.map(f => [f, i[f] ?? null])));

async function checkSendJobs(db) {
  const jobs = db.collection('sendjobs');
  let checked = 0;
  for await (const full of jobs.find({}, { projection: { items: 1 } })) {
    const narrow = await jobs.findOne({ _id: full._id }, { projection: { 'items.status': 1, 'items.processedAt': 1 } });
    // Same length and order (timeline uses the index), same values for the fields read.
    assert.strictEqual((narrow.items || []).length, (full.items || []).length, `job ${full._id}: item count differs`);
    assert.deepStrictEqual(pick(narrow.items, ['status', 'processedAt']), pick(full.items, ['status', 'processedAt']),
      `job ${full._id}: status/processedAt differ`);
    checked++;
  }
  console.log(`✅  sendjobs: ${checked} jobs identical on the fields the counters read`);
}

async function checkCampaignOutcomes(db) {
  const rows = db.collection('campaignrows');
  const userIds = await rows.distinct('userId');
  const pipeline = (lookup) => (userId) => [
    { $match: { userId, status: 'released', contactId: { $ne: null } } },
    { $addFields: { cid: { $toObjectId: '$contactId' } } },
    { $lookup: lookup },
    { $unwind: '$c' },
    { $match: { 'c.deleted': { $ne: true }, 'c.userId': userId } },
    { $group: { _id: { campaignId: '$campaignId', status: '$c.status' }, n: { $sum: 1 } } },
    { $sort: { '_id.campaignId': 1, '_id.status': 1 } },
  ];
  const oldP = pipeline({ from: 'contacts', localField: 'cid', foreignField: '_id', as: 'c' });
  const newP = pipeline({ from: 'contacts', localField: 'cid', foreignField: '_id', as: 'c',
    pipeline: [{ $project: { status: 1, deleted: 1, userId: 1 } }] });

  for (const userId of userIds) {
    const [a, b] = await Promise.all([
      rows.aggregate(oldP(userId)).toArray(),
      rows.aggregate(newP(userId)).toArray(),
    ]);
    assert.deepStrictEqual(b, a, `user ${userId}: campaign outcomes differ`);
  }
  console.log(`✅  campaign outcomes: identical for ${userIds.length} users`);
}

// backfillFollowUpReplied moved its JS skip test into the query as $expr.
async function checkFollowUpRepliedFilter(db) {
  const contacts = db.collection('contacts');
  const oldIds = (await contacts.find({ status: 'replied', followUpSentAt: { $ne: null } },
    { projection: { repliedAt: 1, followUpSentAt: 1 } }).toArray())
    .filter(c => !(!c.repliedAt || new Date(c.repliedAt) <= new Date(c.followUpSentAt)))
    .map(c => String(c._id)).sort();
  const newIds = (await contacts.find({ status: 'replied', followUpSentAt: { $ne: null },
    $expr: { $gt: ['$repliedAt', '$followUpSentAt'] } }, { projection: { _id: 1 } }).toArray())
    .map(c => String(c._id)).sort();
  assert.deepStrictEqual(newIds, oldIds, 'backfillFollowUpReplied selects different contacts');
  console.log(`✅  backfillFollowUpReplied: same ${oldIds.length} contacts selected`);
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  console.log(`Parity (read-only) against ${env} / ${db.databaseName}`);
  await checkSendJobs(db);
  await checkCampaignOutcomes(db);
  await checkFollowUpRepliedFilter(db);
  await mongoose.disconnect();
  console.log('All Stage 1 projection checks passed.');
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
