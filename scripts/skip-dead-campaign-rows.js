#!/usr/bin/env node
/**
 * One-off repair (2026-10-09): campaign rows still `pending` whose contact had
 * already bounced. They were let in before lib/deadAddress.js existed; the
 * release scan now skips them anyway, but this settles them up front so the
 * campaign's counts are honest and the contacts stop showing `in-campaign`.
 *
 * For each such row: row → skipped (skipReason 'bounced'); its contact, if still
 * reserved as `in-campaign`, goes back to its real status. Campaign stats move
 * pending → skipped. Uses the same isDeadAddress() rule as the app.
 *
 *   NODE_ENV=prod node scripts/skip-dead-campaign-rows.js          # dry run (default)
 *   NODE_ENV=prod node scripts/skip-dead-campaign-rows.js --apply  # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { isDeadAddress, lastRealStatus } = require('../lib/deadAddress');

const APPLY = process.argv.includes('--apply');
const uri = process.env.NODE_ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

(async () => {
  // Connect directly: db.connect() would also run the startup backfills.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, maxPoolSize: 2 });
  const db = mongoose.connection.db;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${db.databaseName}\n`);

  const rows = await db.collection('campaignrows').find(
    { status: 'pending', sourceContactId: { $ne: null } },
    { projection: { userId: 1, campaignId: 1, email: 1, sourceContactId: 1 } },
  ).toArray();
  const contacts = new Map((await db.collection('contacts').find(
    { _id: { $in: rows.map(r => new mongoose.Types.ObjectId(String(r.sourceContactId))) } },
    { projection: { status: 1, bounceReason: 1, 'statusHistory.status': 1 } },
  ).toArray()).map(c => [String(c._id), c]));

  const dead = rows.filter(r => isDeadAddress(contacts.get(String(r.sourceContactId))));
  const byCampaign = {};
  dead.forEach(r => { byCampaign[String(r.campaignId)] = (byCampaign[String(r.campaignId)] || 0) + 1; });
  const names = new Map((await db.collection('campaigns').find(
    { _id: { $in: Object.keys(byCampaign).map(id => new mongoose.Types.ObjectId(id)) } }, { projection: { name: 1 } },
  ).toArray()).map(c => [String(c._id), c.name]));

  console.log(`${rows.length} pending contact-backed rows checked, ${dead.length} point at a dead address:`);
  Object.entries(byCampaign).forEach(([id, n]) => console.log(`  ${n}  ${names.get(id) || id}`));
  dead.forEach(r => {
    const c = contacts.get(String(r.sourceContactId));
    console.log(`    ${r.email.padEnd(45)} contact now ${c.status} → ${c.status === 'in-campaign' ? lastRealStatus(c) : '(unchanged)'}`);
  });

  if (APPLY && dead.length) {
    const now = new Date();
    const rowRes = await db.collection('campaignrows').updateMany(
      { _id: { $in: dead.map(r => r._id) }, status: 'pending' },
      { $set: { status: 'skipped', skipReason: 'bounced' } },
    );
    let contactsRestored = 0;
    for (const r of dead) {
      const c = contacts.get(String(r.sourceContactId));
      const res = await db.collection('contacts').updateOne(
        { _id: c._id, status: 'in-campaign' },
        { $set: { status: lastRealStatus(c), updatedAt: now },
          $push: { statusHistory: { status: lastRealStatus(c), changedAt: now, note: 'Released from campaign — this address bounced before' } } },
      );
      contactsRestored += res.modifiedCount;
    }
    for (const [id, n] of Object.entries(byCampaign)) {
      await db.collection('campaigns').updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $inc: { 'stats.pending': -n, 'stats.skipped': n } });
    }
    console.log(`\nWROTE: ${rowRes.modifiedCount} rows skipped, ${contactsRestored} contacts restored, ${Object.keys(byCampaign).length} campaign(s) recounted.`);
  } else if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply to make these changes.');
  }
  await mongoose.disconnect();
})().catch(async e => { console.error('FAILED', e.message); await mongoose.disconnect(); process.exit(1); });
