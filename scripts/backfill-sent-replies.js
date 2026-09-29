#!/usr/bin/env node
/**
 * One-time catch-up: reads each account's Gmail Sent folder further back than the regular
 * mailbox check does, so replies you typed in Gmail are in the conversation history.
 *
 * Until the Needs you queue, the Sent-folder pass opened a folder that doesn't exist
 * ('[Gmail]/Sent'), so none of those replies were ever captured. The regular check only
 * looks back to its previous run, so it will never find them on its own. Without this, the
 * migration can't tell that you already answered, and a "send your resume" you replied to
 * weeks ago would show up as waiting on you.
 *
 * Run it BEFORE scripts/migrate-action-state.js: the migration reads the captured replies
 * to decide who has been answered.
 *
 * It runs one normal mailbox check per account (inbox too), with only the Sent pass
 * widened. The check skips messages it has already captured, so re-running it is harmless.
 * Dry run lists the accounts it would check; --execute does it.
 *
 *   node scripts/backfill-sent-replies.js
 *   node scripts/backfill-sent-replies.js --execute
 *   node scripts/backfill-sent-replies.js --env=dev --days=60 --execute
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
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const DAYS = Number(value('days') || 120);

(async () => {
  if (!URI) {
    console.error(`No MONGODB_URI_${ENV.toUpperCase()} in the environment.`);
    process.exit(1);
  }
  // Connect first: the server module then sees a live connection and never opens its own
  // (which would pick the database from NODE_ENV instead of --env).
  await mongoose.connect(URI);
  const { checkMailboxForUser } = require('../server');
  const Settings = require('../models/Settings');
  const Contact = require('../models/Contact');
  console.log(`connected to ${ENV}${EXECUTE ? '' : '  (DRY RUN — pass --execute to read the mailboxes)'}\n`);

  const accounts = await Settings.find({ userId: { $ne: null }, gmailEmail: { $ne: '' } }, { userId: 1, gmailEmail: 1 }).lean();
  console.log(`  accounts with Gmail connected: ${accounts.length}   Sent lookback: ${DAYS} days`);

  // Every outbound message on file for one account — the number this run should grow.
  const outboundCount = async (userId) => {
    const [r] = await Contact.aggregate([
      { $match: { userId, deleted: { $ne: true } } },
      { $project: { n: { $size: { $filter: { input: { $ifNull: ['$thread', []] }, cond: { $eq: ['$$this.direction', 'outbound'] } } } } } },
      { $group: { _id: null, n: { $sum: '$n' } } },
    ]);
    return r ? r.n : 0;
  };

  for (const a of accounts) {
    if (!EXECUTE) { console.log(`    would check ${a.gmailEmail}`); continue; }
    try {
      const before = await outboundCount(a.userId);
      const started = Date.now();
      const r = await checkMailboxForUser(a.userId, { sentLookbackDays: DAYS });
      if (r.skipped) { console.log(`    ${a.gmailEmail}: skipped (${r.skipped})`); continue; }
      const after = await outboundCount(a.userId);
      console.log(`    ${a.gmailEmail}: scanned ${r.scanned} messages in ${Math.round((Date.now() - started) / 1000)}s · `
        + `${r.replied.length} new replies · your messages on file ${before} → ${after} (+${after - before})`);
    } catch (err) {
      console.log(`    ${a.gmailEmail}: FAILED — ${err.message}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('\nBACKFILL ERROR:', e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
