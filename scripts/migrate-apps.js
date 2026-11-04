#!/usr/bin/env node
/**
 * One-time migration: the account store becomes shared with Clientline.
 *
 * Two things, both idempotent:
 *   1. Every user, session, sign-in code and access request written before the
 *      split belongs to Outreach and is marked so. db.js does the same on every
 *      connect, so this only reports it, or does it ahead of the deploy.
 *   2. The old unique { email: 1 } index on accessrequests is dropped. Mongoose
 *      builds the new { email, app } one but never removes the superseded one,
 *      and while it stands an Outreach user cannot ask to join Clientline.
 *
 * Connects with mongoose.connect() rather than require('../db') on purpose:
 * db.js fires its backfills on connect, and a dry run must not write.
 *
 *   node scripts/migrate-apps.js --env=dev
 *   node scripts/migrate-apps.js --env=dev --execute
 *   node scripts/migrate-apps.js --env=prod --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'dev' ? process.env.MONGODB_URI_DEV : process.env.MONGODB_URI_PROD;

const BACKFILL = [
  ['users', 'apps', ['outreach']],
  ['sessions', 'app', 'outreach'],
  ['logincodes', 'app', 'outreach'],
  ['accessrequests', 'app', 'outreach'],
];
const OLD_INDEX = 'email_1';

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);

  console.log(`${EXECUTE ? 'Migrating' : 'Dry run against'} the ${ENV} database\n`);

  for (const [col, field, val] of BACKFILL) {
    if (!present.includes(col)) { console.log(`  ${col.padEnd(16)} (no collection)`); continue; }
    const filter = { [field]: { $exists: false } };
    const missing = await db.collection(col).countDocuments(filter);
    if (EXECUTE && missing) await db.collection(col).updateMany(filter, { $set: { [field]: val } });
    console.log(`  ${col.padEnd(16)} ${missing} without ${field}${EXECUTE && missing ? ' -> set' : ''}`);
  }

  // A duplicate (email, app) would make the new unique index fail to build.
  // Impossible today — the old index was unique on email alone — but checked
  // rather than assumed, since it is what the drop below relies on.
  if (present.includes('accessrequests')) {
    const requests = db.collection('accessrequests');
    const dupes = await requests.aggregate([
      { $group: { _id: { email: '$email', app: { $ifNull: ['$app', 'outreach'] } }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();
    if (dupes.length) throw new Error(`${dupes.length} duplicate (email, app) access requests — resolve them first`);

    const has = (await requests.indexes()).some(i => i.name === OLD_INDEX);
    if (has && EXECUTE) await requests.dropIndex(OLD_INDEX);
    console.log(`\n  accessrequests.${OLD_INDEX}: ${has ? (EXECUTE ? 'dropped' : 'present, would drop') : 'already gone'}`);
  }

  if (!EXECUTE) console.log('\nNothing written. Re-run with --execute.');
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
