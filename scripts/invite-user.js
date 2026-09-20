#!/usr/bin/env node
/**
 * Whitelists an email address, which is the whole of account creation.
 *
 * Sign-in is an emailed one-time code, so there is no password to set, print or
 * hand over. Creating the row IS the whitelist: lib/loginCode.js will only send
 * a code to an address that has one, and the unique index on email means the
 * users collection is the allow-list itself rather than a second thing to keep
 * in sync with it.
 *
 * The admin dashboard can do all of this too. This stays because of the
 * bootstrap problem: the FIRST admin cannot be made through an interface that
 * requires being an admin.
 *
 * Connects with mongoose.connect() rather than require('../db'): db.js fires
 * three contact backfills on connect.
 *
 *   node scripts/invite-user.js --list --env=dev
 *   node scripts/invite-user.js --email=new@example.com --env=dev
 *   node scripts/invite-user.js --email=new@example.com --env=dev --execute
 *   node scripts/invite-user.js --email=new@example.com --execute --no-notify
 *   node scripts/invite-user.js --email=you@example.com --admin --execute
 *   node scripts/invite-user.js --email=x@y.com --disable --execute
 *   node scripts/invite-user.js --email=x@y.com --enable --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const { ONBOARDING_VERSION } = require('../lib/onboarding');
const { sendAccessApproved } = require('../lib/emailOtp');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const LIST = flag('list');
const MAKE_ADMIN = flag('admin');
const DISABLE = flag('disable');
const ENABLE = flag('enable');
// On by default: an account the person is never told about is not much use.
const NOTIFY = !flag('no-notify');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').trim().toLowerCase();

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');

async function list() {
  const users = await User.find({}, {
    email: 1, name: 1, isAdmin: 1, status: 1, createdAt: 1, lastLoginAt: 1, onboarding: 1,
  }).sort({ createdAt: 1 }).lean();

  console.log(`\n${users.length} account(s):\n`);
  console.log(`  ${'EMAIL'.padEnd(32)} ${'STATUS'.padEnd(9)} ${'ADMIN'.padEnd(6)} ${'ONBOARDED'.padEnd(10)} ${'LAST LOGIN'.padEnd(17)} CREATED`);
  for (const u of users) {
    // `=== true`, never a truthiness test: .lean() skips schema defaults, so a
    // row written before these fields existed reads back undefined.
    const onboarded = !!(u.onboarding && u.onboarding.completedAt);
    console.log(`  ${u.email.padEnd(32)} ${String(u.status || '?').padEnd(9)} ${(u.isAdmin === true ? 'yes' : 'no').padEnd(6)} ${(onboarded ? 'yes' : 'no').padEnd(10)} ${fmt(u.lastLoginAt).padEnd(17)} ${fmt(u.createdAt)}`);
  }
  console.log('');
}

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`\nDatabase: ${mongoose.connection.db.databaseName}  (MONGODB_URI_${ENV.toUpperCase()})`);

  if (LIST) return list();
  if (!EMAIL) throw new Error('Pass --email=<address>, or --list to see the existing accounts');
  if (DISABLE && ENABLE) throw new Error('Pass one of --disable or --enable, not both');

  const existing = await User.findOne({ email: EMAIL });

  if (DISABLE || ENABLE) {
    if (!existing) throw new Error(`No account for ${EMAIL}`);
    const status = DISABLE ? 'disabled' : 'active';

    if (DISABLE && existing.isAdmin === true) {
      const admins = await User.countDocuments({ isAdmin: true, status: { $ne: 'disabled' } });
      // Disabling the only admin leaves the install with no way to administer
      // itself, recoverable only by editing the database by hand.
      if (admins <= 1) throw new Error(`${EMAIL} is the only active admin — promote someone else first.`);
    }

    if (!EXECUTE) {
      console.log(`\nDry run — would set ${EMAIL} to ${status}${DISABLE ? ' and revoke their sessions' : ''}.`);
      console.log(`Re-run with --execute to apply.\n`);
      return;
    }
    await User.updateOne({ _id: existing._id }, { $set: { status } });
    if (DISABLE) {
      // Sessions are the enforcement point. requireAuth does not re-check status
      // on every request, so destroying the sessions is what actually ends
      // access; without this, a disabled user stays signed in for 30 days.
      const { deletedCount } = await Session.deleteMany({ userId: existing._id });
      console.log(`\n${EMAIL} disabled; ${deletedCount} session(s) revoked.\n`);
    } else {
      console.log(`\n${EMAIL} re-enabled. They can request a sign-in code again.\n`);
    }
    return;
  }

  if (existing) {
    if (MAKE_ADMIN && existing.isAdmin !== true) {
      if (!EXECUTE) {
        console.log(`\nDry run — ${EMAIL} already exists; would promote them to admin.`);
        console.log(`Re-run with --execute to apply.\n`);
        return;
      }
      await User.updateOne({ _id: existing._id }, { $set: { isAdmin: true } });
      console.log(`\n${EMAIL} promoted to admin.\n`);
      return;
    }
    throw new Error(`${EMAIL} already has an account (status: ${existing.status}, admin: ${existing.isAdmin === true}).`);
  }

  if (!EXECUTE) {
    console.log(`\nDry run — would whitelist ${EMAIL}${MAKE_ADMIN ? ' as an ADMIN' : ''}.`);
    console.log(`They would then sign in at /login with a code emailed to that address.`);
    console.log(NOTIFY
      ? `They would be emailed to say their access is ready.`
      : `They would NOT be emailed (--no-notify) — you would have to tell them yourself.`);
    console.log(`\nRe-run with --execute to apply.\n`);
    return;
  }

  await User.create({
    email: EMAIL,
    name: value('name') || '',
    isAdmin: MAKE_ADMIN,
    status: 'invited',
    invitedAt: new Date(),
    // A brand-new account starts at version 0 so the wizard runs for them. The
    // subdocument is written out in full rather than left to defaults, to match
    // what the migration writes.
    onboarding: { startedAt: null, completedAt: null, step: 0, skipped: [], version: 0 },
  });

  console.log(`\nWhitelisted ${EMAIL}${MAKE_ADMIN ? ' as an ADMIN' : ''}.`);

  if (NOTIFY) {
    // Never throws: the account exists regardless, and failing the whole command
    // over a mail hiccup would be the wrong end to break.
    const mail = await sendAccessApproved({ to: EMAIL, appUrl: process.env.OUTREACH_URL || '' });
    console.log(mail.delivered
      ? `Emailed them to say they can sign in.`
      : `NOT emailed${mail.dev ? ' (no RESEND_API_KEY set)' : ''} — tell them yourself that they can sign in at /login.`);
  } else {
    console.log(`Not emailed (--no-notify). Tell them to sign in at /login with that address.`);
  }
  console.log(`\nNote: adding a second account switches off every "sole account" fallback`);
  console.log(`(the GMAIL_EMAIL env credential and the global WORKER_SECRET). Make sure`);
  console.log(`scripts/import-gmail-credential.js has run and the worker has its own token.\n`);
  console.log(`Current accounts:`);
  await list();
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
