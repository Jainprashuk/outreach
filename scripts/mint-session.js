#!/usr/bin/env node
/**
 * Break-glass: mints a signed-in session without sending an email.
 *
 * Sign-in depends on Resend. If the domain lapses, the API key is rotated, or
 * Resend is simply down, nobody can get in — there is no password to fall back
 * to any more. This is the way back in. It needs database credentials, which is
 * the only thing gating it, so treat it as equivalent to full access.
 *
 * Not a backdoor in the app: it mints an ordinary Session row that /logout and
 * the admin "revoke sessions" action destroy like any other.
 *
 * Connects with mongoose.connect() rather than require('../db'): db.js fires
 * three contact backfills on connect.
 *
 *   node scripts/mint-session.js --email=you@example.com --env=dev
 *   node scripts/mint-session.js --email=you@example.com --env=prod --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { createSession } = require('../lib/session');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').trim().toLowerCase();
const ORIGIN = value('origin') || (ENV === 'prod' ? 'https://outreach-gray.vercel.app' : 'http://localhost:3000');

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!EMAIL) throw new Error('Pass --email=<the account to sign in as>');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`\nDatabase: ${mongoose.connection.db.databaseName}  (MONGODB_URI_${ENV.toUpperCase()})`);

  const user = await User.findOne({ email: EMAIL }, { email: 1, status: 1, isAdmin: 1 }).lean();
  if (!user) throw new Error(`No account for ${EMAIL}`);
  // Deliberately refused. An operator who wants back into a disabled account
  // should re-enable it on purpose, so the change is visible, rather than
  // sidestepping the decision with a minted cookie.
  if (user.status === 'disabled') throw new Error(`${EMAIL} is disabled — re-enable it first with scripts/invite-user.js --enable`);

  if (!EXECUTE) {
    console.log(`\nDry run — would mint a 30-day session for ${EMAIL} (admin: ${user.isAdmin === true}).`);
    console.log(`Re-run with --execute to apply.\n`);
    return;
  }

  const token = await createSession(user._id);

  console.log(`\nSession minted for ${EMAIL}. Paste this into the browser console on ${ORIGIN}:\n`);
  // Set from the console rather than printed as a Set-Cookie header, because the
  // real cookie is HttpOnly and cannot be written this way — this is a
  // deliberately more awkward path that only works when you already control the
  // machine. Secure is omitted for http://localhost.
  console.log(`  document.cookie = 'outreach_session=${encodeURIComponent(token)}; path=/; max-age=2592000${ORIGIN.startsWith('https') ? '; secure' : ''}';`);
  console.log(`\nThen reload ${ORIGIN}. Sign out normally when you are done, to destroy it.\n`);
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
