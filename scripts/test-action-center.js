// Proves the Action Center's counts mean what its buttons act on. Run with:
//
//   node scripts/test-action-center.js                                  # part 1 only, no database
//   node scripts/test-action-center.js --email=you@x.com [--env=prod]   # + part 2 against a database (READ-ONLY)
//
// Part 1: the follow-up filter (routes/actionCenter.js) and the Contacts list's
// isFollowUpDue (lib/contactList.js) agree on every edge case — they are two
// spellings of one rule, and a drift is the "button says 3, list shows 5" bug. The
// query is evaluated with sift (mongoose's own matcher dependency).
//
// Part 2: on real data, each summary count equals the length of the id list its
// button loads, the follow-up count equals the Contacts list's Follow-up due tab,
// and another account's id sees nothing of this one's.

require('dotenv').config();
const sift = require('sift').default || require('sift');
const ac = require('../routes/actionCenter')._test;
const contactList = require('../lib/contactList');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

const DAY = 24 * 3600 * 1000;
const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };

console.log('\npart 1 — follow-up due: the button filter vs the Contacts list rule');
{
  const now = Date.now();
  const uid = 'u1';
  const base = { userId: uid, deleted: false };
  const cases = [
    ['sent 4d ago, no follow-up', { status: 'sent', lastSentAt: new Date(now - 4 * DAY), followUpSentAt: null }],
    ['sent exactly 3d ago', { status: 'sent', lastSentAt: new Date(now - 3 * DAY), followUpSentAt: null }],
    ['sent 2d ago', { status: 'sent', lastSentAt: new Date(now - 2 * DAY), followUpSentAt: null }],
    ['sent, lastSentAt missing', { status: 'sent', followUpSentAt: null }],
    ['sent, lastSentAt null', { status: 'sent', lastSentAt: null }],
    ['already followed up', { status: 'sent', lastSentAt: new Date(now - 9 * DAY), followUpSentAt: new Date(now - DAY) }],
    ['replied', { status: 'replied', lastSentAt: new Date(now - 9 * DAY) }],
    ['in a campaign', { status: 'in-campaign', lastSentAt: new Date(now - 9 * DAY) }],
  ];
  const match = sift(ac.followUpFilter(uid, now));
  for (const [label, c] of cases) {
    const doc = { ...base, ...c };
    const a = match(doc), b = contactList.isFollowUpDue(doc, now);
    ok(`${label}: ${a ? 'due' : 'not due'}`, a === !!b, `filter=${a} list=${b}`);
  }
  ok('a deleted contact is never due', !match({ ...cases[0][1], userId: uid, deleted: true }));
  ok("another account's contact is never due", !match({ ...cases[0][1], userId: 'u2', deleted: false }));
}

console.log('\npart 1 — the other filters');
{
  const uid = 'u1';
  const ready = sift(ac.readyFilter(uid));
  ok('ready: queued + approved + never sent', ready({ userId: uid, status: 'queued', approvalStatus: 'approved', lastSentAt: null }));
  ok('ready: not once it was sent', !ready({ userId: uid, status: 'queued', approvalStatus: 'approved', lastSentAt: new Date() }));
  ok('ready: not while pending', !ready({ userId: uid, status: 'queued', approvalStatus: 'pending', lastSentAt: null }));
  const pending = sift(ac.pendingFilter(uid));
  ok('pending: queued + pending', pending({ userId: uid, status: 'queued', approvalStatus: 'pending' }));
  ok('pending: not an old sent contact that is still "pending"', !pending({ userId: uid, status: 'sent', approvalStatus: 'pending' }));
  const leads = sift(ac.leadsFilter(uid));
  ok('leads: new with an email', leads({ userId: uid, status: 'new', email: 'a@b.co', fitScore: 3 }));
  ok('leads: not a hard reject', !leads({ userId: uid, status: 'new', email: 'a@b.co', fitScore: -999 }));
  ok('leads: not without an email', !leads({ userId: uid, status: 'new', email: null, fitScore: 3 }));
  const pr = sift(ac.prospectsFilter(uid));
  ok('prospects: ready + high', pr({ userId: uid, status: 'ready', email: 'a@b.co', emailConfidence: 'high' }));
  ok('prospects: not medium', !pr({ userId: uid, status: 'ready', email: 'a@b.co', emailConfidence: 'medium' }));
  ok('prospects: not one that is already a contact', !pr({ userId: uid, status: 'ready', email: 'a@b.co', emailConfidence: 'high', existingContactId: 'c1' }));
}

async function part2(email, env) {
  const mongoose = require('mongoose');
  const Contact = require('../models/Contact');
  const Lead = require('../models/Lead');
  const Prospect = require('../models/Prospect');
  const { listResponse, memoryListResponse } = require('../lib/contactListDb');
  const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`\npart 2 — ${mongoose.connection.db.databaseName}, ${email} (read-only)`);
  const user = await mongoose.connection.db.collection('users').findOne({ email });
  if (!user) throw new Error(`No user ${email}`);
  const userId = user._id;

  const counts = {
    followup: await Contact.countDocuments(ac.followUpFilter(userId)),
    ready: (await ac.readyIds(userId)).length,
    pending: await Contact.countDocuments(ac.pendingFilter(userId)),
    leads: await Lead.countDocuments(ac.leadsFilter(userId)),
    prospects: await Prospect.countDocuments(ac.prospectsFilter(userId)),
  };
  const lists = {
    followup: (await Contact.find(ac.followUpFilter(userId), { _id: 1 }).lean()).length,
    ready: (await ac.readyIds(userId)).length,
    pending: (await Contact.find(ac.pendingFilter(userId), { _id: 1 }).lean()).length,
    leads: (await Lead.find(ac.leadsFilter(userId), { _id: 1 }).lean()).length,
    prospects: (await Prospect.find(ac.prospectsFilter(userId), { _id: 1 }).lean()).length,
  };
  for (const k of Object.keys(counts)) ok(`${k}: count ${counts[k]} = ids ${lists[k]}`, counts[k] === lists[k]);

  // The Contacts list's own Follow-up due tab, through whichever path the route uses.
  const serialize = (c) => ({ ...c, id: String(c._id) });
  const q = { tab: 'followup-due', ids: '1', limit: '1' };
  const listed = (await listResponse(Contact, userId, q, serialize)) || (await memoryListResponse(Contact, userId, q, serialize));
  ok(`follow-up count ${counts.followup} = Contacts "Follow-up due" tab ${listed.ids.length}`, counts.followup === listed.ids.length);

  const stranger = new mongoose.Types.ObjectId();
  const leak = await Contact.countDocuments(ac.followUpFilter(stranger)) + await Contact.countDocuments(ac.pendingFilter(stranger))
    + (await ac.readyIds(stranger)).length;
  ok('an unknown account sees nothing', leak === 0, `saw ${leak}`);
  await mongoose.disconnect();
}

(async () => {
  const email = (value('email') || '').toLowerCase();
  if (email) await part2(email, value('env'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
