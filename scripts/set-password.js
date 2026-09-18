#!/usr/bin/env node
/**
 * Creates an account or resets its password.
 *
 * Signups are closed until email verification exists — without it nothing stops
 * someone registering as anybody — so accounts are made here instead.
 *
 * The password is read from a prompt, never an argument, so it does not land in
 * shell history or the process list.
 *
 *   node scripts/set-password.js --email=you@example.com
 *   node scripts/set-password.js --email=you@example.com --env=dev
 *   node scripts/set-password.js --email=new@example.com --create
 */
require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const { hashPassword } = require('../lib/password');
const User = require('../models/User');
const { destroyAllForUser } = require('../lib/session');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };

const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').trim().toLowerCase();
const CREATE = flag('create');

// Reads without echoing, so the password is not left on screen.
const promptHidden = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const onData = (char) => {
    if (['\n', '\r', ''].includes(char.toString('utf8'))) return;
    readline.moveCursor(process.stdout, -100, 0);
    readline.clearLine(process.stdout, 1);
    process.stdout.write(question + '*'.repeat(rl.line.length));
  };
  process.stdin.on('data', onData);
  rl.question(question, (answer) => {
    process.stdin.removeListener('data', onData);
    rl.close();
    process.stdout.write('\n');
    resolve(answer);
  });
});

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!EMAIL) throw new Error("Pass --email=<address>");

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`\nDatabase: ${mongoose.connection.db.databaseName}`);

  const existing = await User.findOne({ email: EMAIL });
  if (!existing && !CREATE) {
    throw new Error(`No account for ${EMAIL}. Pass --create to make one.`);
  }
  console.log(existing ? `Resetting the password for ${EMAIL}` : `Creating a new account for ${EMAIL}`);

  const pw = await promptHidden('New password: ');
  if (pw.length < 10) throw new Error('Use a password of at least 10 characters');
  const again = await promptHidden('Confirm password: ');
  if (pw !== again) throw new Error('Those did not match');

  const passwordHash = await hashPassword(pw);

  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: { passwordHash } });
    // A password reset must not leave old sessions logged in — that is the whole
    // point of resetting it when a credential may be compromised.
    const { deletedCount } = await destroyAllForUser(existing._id);
    console.log(`\nPassword updated. ${deletedCount} existing session(s) revoked.\n`);
  } else {
    const created = await User.create({ email: EMAIL, passwordHash });
    console.log(`\nAccount created: ${created._id}\n`);
  }
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
