#!/usr/bin/env node
/**
 * One-time migration: moves existing accounts onto OTP sign-in.
 *
 * Nothing about a user's data changes. What changes is how they prove who they
 * are, so this backfills the three fields the new auth and admin code reads, and
 * marks everyone who is already set up as already onboarded so that no existing
 * user is ever shown the first-run wizard.
 *
 * The fields are backfilled EXPLICITLY rather than left to their schema
 * defaults, because this codebase reads users with .lean() in the hot path and
 * .lean() does not apply defaults — an un-backfilled row would read back
 * isAdmin: undefined and status: undefined forever.
 *
 * passwordHash is only removed under --drop-passwords, deliberately a separate
 * later run: leaving the column in place through one deploy cycle is the
 * rollback path, the same way LEGACY_LOGIN was during the multi-tenant swap.
 *
 * Connects with mongoose.connect() rather than require('../db') on purpose:
 * db.js fires three contact backfills on connect.
 *
 *   node scripts/migrate-otp-auth.js --env=dev --admin=you@example.com
 *   node scripts/migrate-otp-auth.js --env=dev --admin=you@example.com --execute
 *   node scripts/migrate-otp-auth.js --env=prod --admin=... --execute --drop-passwords
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ONBOARDING_VERSION } = require('../lib/onboarding');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const DROP_PASSWORDS = flag('drop-passwords');
const REVOKE_SESSIONS = flag('revoke-sessions');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const ADMIN = (value('admin') || '').trim().toLowerCase();

// Unique indexes that were declared `sparse` but sit on fields defaulting to
// null. Sparse only skips documents where the field is ABSENT; `default: null`
// makes it present, so every tokenless account was indexed under the same null
// and the SECOND one could not be created. The partial replacements live in
// models/User.js — mongoose builds those on its own but never drops a
// superseded index, so that has to happen here.
const STALE_INDEXES = [
  { collection: 'users', index: 'workerTokenHash_1' },
  { collection: 'users', index: 'shareTokenHash_1' },
];

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!ADMIN) throw new Error('Pass --admin=<the email that should own the admin dashboard>');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const settings = db.collection('settings');
  console.log(`\nDatabase: ${db.databaseName}  (MONGODB_URI_${ENV.toUpperCase()})`);

  // ── Survey ────────────────────────────────────────────────────────────────
  const all = await users.find({}).toArray();
  const totalBefore = all.length;
  if (!totalBefore) throw new Error('No users in this database — nothing to migrate.');

  const admin = all.find(u => u.email === ADMIN);
  if (!admin) {
    throw new Error(
      `No account for ${ADMIN} in ${db.databaseName}. ` +
      `Existing accounts: ${all.map(u => u.email).join(', ')}. ` +
      `Create it with scripts/invite-user.js first, or correct --admin.`);
  }

  // Who counts as already set up. A stored Gmail credential is the primary
  // signal — but the original owner may still be running on the GMAIL_EMAIL /
  // GMAIL_APP_PASSWORD environment fallback, which only works while exactly one
  // account exists (lib/mailer.js isSoleAccount). Keying on the stored
  // credential alone would mark that person un-onboarded and trap them in a
  // wizard they do not need. scripts/import-gmail-credential.js is supposed to
  // have run before this, which makes the second branch unnecessary — it stays
  // because "unnecessary" and "guaranteed" are not the same thing.
  const withCredential = new Set(
    (await settings.find(
      { gmailAppPasswordEnc: { $nin: [null, ''] } },
      { projection: { userId: 1 } },
    ).toArray()).map(s => String(s.userId)),
  );
  const envFallbackLive = !!(process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) && totalBefore === 1;
  const isSetUp = (u) => withCredential.has(String(u._id)) || (envFallbackLive && totalBefore === 1);

  console.log(`\nBefore:`);
  console.log(`  users                        ${totalBefore}`);
  console.log(`  with passwordHash            ${all.filter(u => u.passwordHash).length}`);
  console.log(`  already have isAdmin         ${all.filter(u => u.isAdmin !== undefined).length}`);
  console.log(`  already have status          ${all.filter(u => u.status !== undefined).length}`);
  console.log(`  already have onboarding      ${all.filter(u => u.onboarding !== undefined).length}`);
  console.log(`  sessions                     ${await db.collection('sessions').countDocuments()}`);
  if (envFallbackLive) {
    console.log(`\n  NOTE: GMAIL_EMAIL/GMAIL_APP_PASSWORD are set and there is exactly one`);
    console.log(`        account, so that account is still sending through the environment`);
    console.log(`        fallback. It will be marked onboarded. Run`);
    console.log(`        scripts/import-gmail-credential.js --execute before inviting anyone,`);
    console.log(`        or its sending stops the moment a second account exists.`);
  }

  console.log(`\nPlan:`);
  for (const u of all) {
    const bits = [];
    if (u.isAdmin === undefined) bits.push('isAdmin=false');
    if (u.email === ADMIN) bits.push('isAdmin=true');
    if (u.status === undefined) bits.push("status=active");
    if (u.onboarding === undefined) bits.push(isSetUp(u) ? 'onboarding=complete' : 'onboarding=pending');
    if (DROP_PASSWORDS && u.passwordHash) bits.push('drop passwordHash');
    console.log(`  ${u.email.padEnd(32)} ${bits.length ? bits.join(', ') : '(nothing to do)'}`);
  }

  const idx = await users.indexes();
  const stalePresent = STALE_INDEXES.filter(t => idx.some(i => i.name === t.index && i.sparse));
  if (stalePresent.length) {
    console.log(`\n  Stale sparse unique index(es) to replace: ${stalePresent.map(t => t.index).join(', ')}`);
    console.log(`  (these cap the install at ONE account without a worker/share token)`);
  }

  if (!EXECUTE) {
    console.log(`\nDry run — nothing written.`);
    console.log(`Re-run with --execute to apply.${DROP_PASSWORDS ? '' : '  (passwordHash is kept; pass --drop-passwords in a LATER run.)'}\n`);
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  console.log('\nApplying:');

  // Every pre-existing account had a working sign-in, so they are active, not
  // invited. Invited is for addresses an admin has whitelisted since.
  const r1 = await users.updateMany({ isAdmin: { $exists: false } }, { $set: { isAdmin: false } });
  console.log(`  isAdmin backfilled           ${r1.modifiedCount}`);
  const r2 = await users.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
  console.log(`  status backfilled            ${r2.modifiedCount}`);

  let onboarded = 0;
  for (const u of all) {
    if (u.onboarding !== undefined) continue;
    const done = isSetUp(u);
    await users.updateOne({ _id: u._id }, {
      $set: {
        onboarding: done
          // Backdated to their creation date rather than stamped with today's,
          // so the record does not claim they completed a wizard that did not
          // exist when they signed up.
          ? { startedAt: u.createdAt || null, completedAt: u.createdAt || new Date(), step: 99, skipped: [], version: ONBOARDING_VERSION }
          : { startedAt: null, completedAt: null, step: 0, skipped: [], version: 0 },
      },
    });
    if (done) onboarded++;
  }
  console.log(`  onboarding stamped complete  ${onboarded} of ${totalBefore}`);

  const r3 = await users.updateOne({ email: ADMIN }, { $set: { isAdmin: true } });
  console.log(`  admin set                    ${ADMIN} (${r3.modifiedCount} changed)`);

  if (DROP_PASSWORDS) {
    const r4 = await users.updateMany({ passwordHash: { $exists: true } }, { $unset: { passwordHash: '' } });
    console.log(`  passwordHash removed         ${r4.modifiedCount}`);
  }

  // Sessions are deliberately left alone. The login METHOD changed; session
  // semantics did not, and wiping them would sign everybody out for no reason.
  if (REVOKE_SESSIONS) {
    const r5 = await db.collection('sessions').deleteMany({});
    console.log(`  sessions revoked             ${r5.deletedCount}`);
  }

  // ── Indexes ───────────────────────────────────────────────────────────────
  console.log('\nReplacing stale sparse unique indexes:');
  for (const { collection, index } of STALE_INDEXES) {
    try {
      await db.collection(collection).dropIndex(index);
      console.log(`  dropped ${collection}.${index}`);
    } catch (err) {
      // IndexNotFound (27) — already gone, which is the desired end state.
      if (err.code === 27) console.log(`  ${collection}.${index} already absent`);
      else throw err;
    }
  }
  // Rebuilt from the schema by mongoose on the next connect. Created here too so
  // that this script leaves the database in its final state rather than one that
  // only becomes correct after the app next boots.
  await users.createIndex({ workerTokenHash: 1 }, { unique: true, partialFilterExpression: { workerTokenHash: { $type: 'string' } } });
  await users.createIndex({ shareTokenHash: 1 }, { unique: true, partialFilterExpression: { shareTokenHash: { $type: 'string' } } });
  console.log('  created partial replacements');

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log('\nVerifying:');
  const after = await users.find({}).toArray();
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  };

  check('user count unchanged', after.length === totalBefore, `${totalBefore} -> ${after.length}`);
  check('every user has a boolean isAdmin', after.every(u => typeof u.isAdmin === 'boolean'));
  check('exactly one admin', after.filter(u => u.isAdmin === true).length === 1,
    after.filter(u => u.isAdmin === true).map(u => u.email).join(', ') || 'none');
  check('every user has a valid status',
    after.every(u => ['invited', 'active', 'disabled'].includes(u.status)));

  // The one that actually protects the existing user: nobody who was already
  // set up may come out of this needing to run the wizard.
  const trapped = after.filter(u => isSetUp(u) && !(u.onboarding && u.onboarding.completedAt));
  check('no already-configured user was left un-onboarded', trapped.length === 0,
    trapped.map(u => u.email).join(', '));

  const finalIdx = await users.indexes();
  const stillSparse = finalIdx.filter(i => i.sparse && i.unique);
  check('no sparse unique index remains on users', stillSparse.length === 0,
    stillSparse.map(i => i.name).join(', '));
  check('worker/share token indexes are partial',
    ['workerTokenHash_1', 'shareTokenHash_1'].every(n =>
      finalIdx.some(i => i.name === n && i.partialFilterExpression)));

  if (DROP_PASSWORDS) {
    check('no passwordHash remains', after.every(u => u.passwordHash === undefined));
  } else {
    console.log(`  ..   passwordHash kept on ${after.filter(u => u.passwordHash).length} user(s) — rollback path intact`);
  }

  if (failures) throw new Error(`${failures} check(s) failed — do NOT deploy the OTP routes until this is resolved.`);
  console.log(`\nMigration verified: ${db.databaseName} is ready for OTP sign-in.\n`);
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
