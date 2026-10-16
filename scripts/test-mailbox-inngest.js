#!/usr/bin/env node
/**
 * Tests the scheduled mailbox check on Inngest (lib/mailbox/inngest.js) and the
 * scan lease + phases it relies on (server.js checkMailboxForUser).
 *
 *   NODE_ENV=dev node scripts/test-mailbox-inngest.js          lease + sweep, no IMAP
 *   NODE_ENV=dev node scripts/test-mailbox-inngest.js --imap   also scans the dev
 *       account's real mailbox (read-only over IMAP; writes to the dev database)
 *
 * Refuses to run against the production database.
 */
require('dotenv').config();
if (process.env.NODE_ENV === 'prod') {
  console.error('Refusing to run against prod. Use NODE_ENV=dev.');
  process.exit(1);
}
const mongoose = require('mongoose');
const db = require('../db');

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log(`  ok   ${msg}`)) : (fail++, console.log(`  FAIL ${msg}`)); };

async function main() {
  await db.connect();
  if (!/dev/.test(mongoose.connection.name)) throw new Error(`Not a dev database: ${mongoose.connection.name}`);
  const { checkMailboxForUser } = require('../server');
  const { dueAccounts } = require('../lib/mailbox/inngest');
  const Settings = require('../models/Settings');
  const Contact = require('../models/Contact');
  const mailer = require('../lib/mailer');

  const { due, users } = await dueAccounts();
  const all = await dueAccounts(Date.now() + 365 * 24 * 3600 * 1000);   // a year on: everyone is due
  const userId = all.due[0] && all.due[0].userId;
  if (!userId) throw new Error('No account with Gmail credentials in the dev database');
  const sender = await mailer.getSenderFor(userId);
  if (!sender.email || !sender.appPassword) throw new Error('The dev account has no usable Gmail login');
  const original = await Settings.findOne({ userId }, { lastMailboxCheckAt: 1 }).lean();

  console.log('\nSweep:');
  check(all.due.length >= 1 && all.due.length <= users, 'a year on, every credentialed account is due');
  check(all.due.every(d => d.phased), 'an account unchecked for a year is scanned in phases');
  check(due.every((d, i) => i === 0 || due[i - 1].last <= d.last), 'due accounts are oldest-check first');
  {
    await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: new Date(Date.now() - 60 * 1000) } });
    const r = await dueAccounts();
    const me = r.due.find(d => d.userId === userId);
    check(!me || !me.phased, 'an account checked a minute ago is not phased');
    await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: new Date(Date.now() - 13 * 3600 * 1000) } });
    const r2 = await dueAccounts();
    check(r2.due.some(d => d.userId === userId && d.phased), 'an account unchecked for 13h is due and phased');
  }

  console.log('\nLease:');
  {
    await Settings.updateOne({ userId }, { $set: { mailboxScanUntil: new Date(Date.now() + 60 * 1000) } });
    const r = await checkMailboxForUser(userId);
    check(r.skipped === 'already_running', 'a held lease makes another scan step aside');
    const s = await Settings.findOne({ userId }, { mailboxScanUntil: 1 }).lean();
    check(s.mailboxScanUntil && s.mailboxScanUntil > new Date(), 'and leaves the holder\'s lease alone');
    const p = await checkMailboxForUser(userId, { phase: 'finalize', carry: {} });
    check(p.skipped === 'already_running', 'phases respect the lease too');
    await Settings.updateOne({ userId }, { $set: { mailboxScanUntil: null } });
  }

  if (process.argv.includes('--imap')) {
    console.log('\nPhased scan against the real mailbox (read-only IMAP):');
    const T = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const threads = async () => (await Contact.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $project: { n: { $size: { $ifNull: ['$thread', []] } } } },
      { $group: { _id: null, n: { $sum: '$n' } } },
    ]))[0]?.n || 0;

    // Phased, from T.
    await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: T } });
    const inbox = await checkMailboxForUser(userId, { phase: 'inbox' });
    check(inbox.ok && inbox.phase === 'inbox', `inbox phase ran (${inbox.scanned} scanned, ${inbox.replied.length} new replies)`);
    const stillT = await Settings.findOne({ userId }, { lastMailboxCheckAt: 1 }).lean();
    check(+stillT.lastMailboxCheckAt === +T, 'a scan phase does not move lastMailboxCheckAt');
    const sent = await checkMailboxForUser(userId, { phase: 'sent' });
    check(sent.ok && sent.phase === 'sent', `sent phase ran (${sent.scanned} scanned)`);
    const fin = await checkMailboxForUser(userId, {
      phase: 'finalize',
      carry: { replied: inbox.replied, bounced: inbox.bounced, scanned: inbox.scanned + sent.scanned, startedAt: inbox.startedAt.toISOString() },
    });
    const stamped = await Settings.findOne({ userId }, { lastMailboxCheckAt: 1, mailboxScanUntil: 1 }).lean();
    check(fin.ok && +stamped.lastMailboxCheckAt === +new Date(inbox.startedAt), 'finalize stamps the time the inbox phase started');
    check(fin.backfill && fin.backfill.skipped === 'slow_scan', 'finalize skips the backfill, like a slow full scan');
    check(!stamped.mailboxScanUntil, 'every phase released its lease');
    const afterPhased = await threads();

    // The full scan over the same window must see the same mail, and capture
    // nothing again.
    await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: T } });
    const full = await checkMailboxForUser(userId);
    check(full.ok, `full scan ran (${full.scanned} scanned)`);
    check(full.scanned === inbox.scanned + sent.scanned, `same window, same mail: ${inbox.scanned + sent.scanned} phased vs ${full.scanned} full`);
    check(full.replied.length === 0 && full.bounced.length === 0, 'nothing the phases captured is captured twice');
    check((await threads()) === afterPhased, 'thread entries unchanged by the repeat scan');
  }

  // Leave the account as it was found, unless the IMAP scan advanced it legitimately.
  if (!process.argv.includes('--imap')) {
    await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: original ? original.lastMailboxCheckAt : null } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
