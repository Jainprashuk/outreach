#!/usr/bin/env node
/**
 * One-time migration: creates the first User and attaches every existing
 * document to it.
 *
 * Everything currently in the database belongs to one person, so the backfill is
 * unambiguous — but it is still a write against live data, so this is a dry run
 * unless --execute is passed, and it verifies counts on both sides.
 *
 * `userId` is nullable in the schemas on purpose: this migration has to be able
 * to run against a database whose documents predate the field, and a document
 * that somehow misses the backfill should fail closed (match nobody's queries)
 * rather than fail open.
 *
 *   node scripts/migrate-multi-tenant.js --email=you@example.com
 *   node scripts/migrate-multi-tenant.js --email=you@example.com --password=... --execute
 *   node scripts/migrate-multi-tenant.js --env=dev --email=... --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { hashPassword } = require('../lib/password');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').toLowerCase().trim();
const PASSWORD = value('password');

// Collections that get a userId, and the model file each belongs to. Listed
// explicitly rather than derived from the models directory: a new model that
// nobody thought about should show up as "unhandled" below, not be silently
// swept into the first user's account.
const OWNED = [
  'activitylogs', 'blocklists', 'campaignrows', 'campaigns', 'contacts',
  'interviews', 'jobboards', 'jobpostings', 'leads', 'scraperuns',
  'scrapeschedules', 'scrapeworkers', 'sendjobs', 'settings', 'templates',
];

// Global unique indexes that multi-tenancy makes wrong. The compound
// replacements live in the schemas; mongoose creates those on its own, but it
// never drops a superseded one.
const STALE_INDEXES = [
  { collection: 'templates', index: 'key_1' },
  { collection: 'blocklists', index: 'type_1_value_1' },
];

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!EMAIL) throw new Error('Pass --email=<the owner\'s login email>');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  console.log(`\nDatabase: ${db.databaseName}  (MONGODB_URI_${ENV.toUpperCase()})`);

  const present = (await db.listCollections({ type: 'collection' }).toArray())
    .map(c => c.name)
    .filter(n => !n.startsWith('system.'));

  const unhandled = present.filter(n => !OWNED.includes(n) && !['users', 'sessions'].includes(n));
  if (unhandled.length) {
    throw new Error(`Collections with no migration rule: ${unhandled.join(', ')}. Add them to OWNED (or decide they are system-wide) before running this.`);
  }

  // ── Survey ────────────────────────────────────────────────────────────────
  const before = {};
  let totalUnowned = 0;
  console.log('\nBefore:');
  for (const name of OWNED) {
    if (!present.includes(name)) { before[name] = { total: 0, unowned: 0 }; continue; }
    const col = db.collection(name);
    const total = await col.countDocuments();
    const unowned = await col.countDocuments({ userId: { $in: [null, undefined] } });
    before[name] = { total, unowned };
    totalUnowned += unowned;
    console.log(`  ${name.padEnd(20)} ${String(total).padStart(7)} docs, ${String(unowned).padStart(7)} without userId`);
  }

  const existingUsers = present.includes('users') ? await db.collection('users').countDocuments() : 0;
  console.log(`\n  users collection: ${existingUsers} existing`);

  if (!EXECUTE) {
    console.log(`\nDry run — nothing written.`);
    console.log(`Would create/reuse the user ${EMAIL} and stamp ${totalUnowned} documents with their id.`);
    console.log(`Would drop stale indexes: ${STALE_INDEXES.map(s => `${s.collection}.${s.index}`).join(', ')}`);
    console.log(`\nRe-run with --execute --password=<password> to apply.\n`);
    return;
  }

  // ── The user ──────────────────────────────────────────────────────────────
  const users = db.collection('users');
  await users.createIndex({ email: 1 }, { unique: true });

  let user = await users.findOne({ email: EMAIL });
  if (user) {
    console.log(`\nReusing existing user ${EMAIL} (${user._id})`);
  } else {
    if (!PASSWORD) throw new Error('Pass --password=<password> to create the user');
    if (PASSWORD.length < 10) throw new Error('Use a password of at least 10 characters');
    const now = new Date();
    const { insertedId } = await users.insertOne({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: '',
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    user = await users.findOne({ _id: insertedId });
    console.log(`\nCreated user ${EMAIL} (${user._id})`);
  }

  // ── Backfill ──────────────────────────────────────────────────────────────
  console.log('\nBackfilling:');
  for (const name of OWNED) {
    if (!present.includes(name)) continue;
    const res = await db.collection(name).updateMany(
      { userId: { $in: [null, undefined] } },
      { $set: { userId: user._id } },
    );
    console.log(`  ${name.padEnd(20)} stamped ${String(res.modifiedCount).padStart(7)}`);
  }

  // ── Stale indexes ─────────────────────────────────────────────────────────
  console.log('\nDropping superseded global unique indexes:');
  for (const { collection, index } of STALE_INDEXES) {
    if (!present.includes(collection)) continue;
    try {
      await db.collection(collection).dropIndex(index);
      console.log(`  dropped ${collection}.${index}`);
    } catch (err) {
      // IndexNotFound (27) — already gone, which is the desired end state.
      if (err.code === 27) console.log(`  ${collection}.${index} already absent`);
      else throw err;
    }
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log('\nVerifying:');
  let failures = 0;
  for (const name of OWNED) {
    if (!present.includes(name)) continue;
    const col = db.collection(name);
    const total = await col.countDocuments();
    const mine = await col.countDocuments({ userId: user._id });
    const stillUnowned = await col.countDocuments({ userId: { $in: [null, undefined] } });

    // Total must not have changed, everything must be owned, nothing left over.
    const ok = total === before[name].total && mine === total && stillUnowned === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} was ${before[name].total}, now ${total}, owned ${mine}, unowned ${stillUnowned}`);
  }

  if (failures) throw new Error(`${failures} collection(s) failed verification — investigate before deploying any code that assumes userId.`);
  console.log(`\nMigration verified: every document in ${db.databaseName} belongs to ${EMAIL}.\n`);
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
