#!/usr/bin/env node
/**
 * One-time bell notice for the shared Library launch: "your contacts, leads and
 * Discover people are now part of the shared Library — turn it off in Settings".
 * Every account that shares (not disabled, not opted out) gets it, because they
 * contribute whether or not an admin has let them SEE the tab.
 *
 * DRY-RUN by default — prints who would be told. Idempotent: the dedupeKey means
 * a second --execute tells nobody twice.
 *
 *   node scripts/notify-library-launch.js                       # dev, dry run
 *   node scripts/notify-library-launch.js --execute             # dev, send
 *   NODE_ENV=prod node scripts/notify-library-launch.js --execute
 *
 * Connects with mongoose directly, never through db.js — that would seed and run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { notify } = require('../lib/notify');

const EXECUTE = process.argv.includes('--execute');
const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

(async () => {
  if (!URI) throw new Error(`No ${PROD ? 'MONGODB_URI_PROD' : 'MONGODB_URI_DEV'} in .env`);
  await mongoose.connect(URI);
  console.log(`${PROD ? 'PROD' : 'dev'} — ${EXECUTE ? 'EXECUTE' : 'dry run'}`);
  const users = await User.find({ status: { $ne: 'disabled' }, libraryOptOut: { $ne: true } }, { email: 1 }).lean();
  let sent = 0;
  for (const u of users) {
    if (!EXECUTE) { console.log(`  would notify ${u.email}`); continue; }
    const row = await notify(u._id, {
      type: 'library.shared',
      title: 'Your contacts are now in the shared Library',
      body: 'Contact details you add (never your sends, replies or notes) can be reused by other users. Turn it off in Settings.',
      link: '/settings',
      dedupeKey: 'library.shared:launch',
    });
    if (row) { sent++; console.log(`  notified ${u.email}`); } else console.log(`  already told ${u.email}`);
  }
  console.log(EXECUTE ? `Done: ${sent} new notification(s).` : `${users.length} account(s) would be told. Re-run with --execute.`);
  await mongoose.disconnect();
})().catch(async (err) => { console.error(err.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
