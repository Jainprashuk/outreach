#!/usr/bin/env node
/**
 * Moves GMAIL_EMAIL / GMAIL_APP_PASSWORD out of the environment and into a
 * user's encrypted Settings document.
 *
 * Those env vars were the only credential source that survived a cold start
 * back when there was one owner. Multi-tenant, each account needs its own, so
 * they become per-user rows and the env vars stop being load-bearing.
 *
 *   node scripts/import-gmail-credential.js --email=you@example.com
 *   node scripts/import-gmail-credential.js --email=you@example.com --env=dev --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Settings = require('../models/Settings');
const credentials = require('../lib/credentials');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').trim().toLowerCase();

const mask = (s) => (s ? `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}` : '(unset)');

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!EMAIL) throw new Error('Pass --email=<the account to attach the credential to>');

  const gmailEmail = process.env.GMAIL_EMAIL;
  const gmailPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailEmail || !gmailPassword) throw new Error('GMAIL_EMAIL and GMAIL_APP_PASSWORD must both be set in the environment');
  if (!credentials.isConfigured()) throw new Error('CREDENTIAL_KEY is not set — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`\nDatabase: ${mongoose.connection.db.databaseName}`);

  const user = await User.findOne({ email: EMAIL });
  if (!user) throw new Error(`No account for ${EMAIL}`);

  const settings = await Settings.getForUser(user._id);
  console.log(`Account:  ${EMAIL} (${user._id})`);
  console.log(`Gmail:    ${gmailEmail}`);
  console.log(`Password: ${mask(gmailPassword)}`);
  console.log(`Currently stored: ${settings.gmailAppPasswordEnc ? 'yes (will be overwritten)' : 'no'}`);

  if (!EXECUTE) {
    console.log('\nDry run — nothing written. Re-run with --execute to store it.\n');
    return;
  }

  const enc = credentials.encrypt(gmailPassword);
  // Round-trip before committing: a credential that cannot be read back is
  // worse than none, because the failure would surface at send time.
  if (credentials.decrypt(enc) !== gmailPassword) throw new Error('Encryption round-trip failed — refusing to store');

  await Settings.updateOne(
    { _id: settings._id, userId: user._id },
    { $set: { gmailEmail, gmailAppPasswordEnc: enc } },
  );

  const check = await Settings.findOne({ userId: user._id }, { gmailEmail: 1, gmailAppPasswordEnc: 1 }).lean();
  const ok = check.gmailEmail === gmailEmail && credentials.decrypt(check.gmailAppPasswordEnc) === gmailPassword;
  console.log(ok
    ? '\nStored and verified. GMAIL_EMAIL / GMAIL_APP_PASSWORD can be removed once every account has its own.\n'
    : '\n✗ Stored value did not verify — investigate before relying on it.\n');
  if (!ok) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
