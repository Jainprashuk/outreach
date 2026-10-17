#!/usr/bin/env node
/**
 * Demo data that lights up every Action Center row (the floating ⚡ button).
 * DEV DATABASE ONLY — refuses to run against prod.
 *
 *   node scripts/seed-action-center-demo.js --email=you@x.com --inbox=you@gmail.com   # add
 *   node scripts/seed-action-center-demo.js --email=you@x.com --clean                 # remove it all
 *
 * --email   the dev account to seed (must exist in the dev database)
 * --inbox   a Gmail you can read. Every sendable demo contact is a plus-address of
 *           it (you+ac-fu1@gmail.com), so anything you send while testing lands in
 *           your own inbox. Without it the script refuses — no demo contact may be
 *           a real stranger's address.
 *
 * Everything added is tagged — "[ac-demo]" names, "ac-demo:" keys, the
 * example.net demo company (older seeds) — so --clean removes exactly it, plus what you
 * created FROM it while testing (contacts made by moves,
 * campaigns built only from demo contacts, searches started for demo jobs).
 *
 * Connects with mongoose directly, never through db.js.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const NaukriJob = require('../models/NaukriJob');
const Interview = require('../models/Interview');
const CompanyPattern = require('../models/CompanyPattern');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const Settings = require('../models/Settings');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = (value('email') || '').toLowerCase();
const INBOX = (value('inbox') || '').toLowerCase();
const CLEAN = args.includes('--clean');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms);
const TAG = '[ac-demo] ';
const KEY = 'ac-demo:';
// Reserved by IANA with a null MX (RFC 7505). Earlier versions of this demo put
// bounced contacts here; --clean still removes them.
const BOUNCE_DOMAIN = 'example.net';
const TAG_RE = { $regex: '^\\[ac-demo\\] ' };

function plus(tag) {
  const [local, domain] = INBOX.split('@');
  return `${local}+ac-${tag}@${domain}`;
}

async function clean(userId) {
  const jobs = await NaukriJob.find({ userId, sourceKey: { $regex: `^${KEY}` } }, { _id: 1 }).lean();
  const jobIds = jobs.map(j => String(j._id));
  const demoContacts = await Contact.find({ userId, $or: [{ name: TAG_RE }, { email: { $regex: `@${BOUNCE_DOMAIN.replace('.', '\\.')}$` } }] }, { _id: 1 }).lean();
  const demoIds = demoContacts.map(c => String(c._id));
  // Campaigns made while testing, from demo contacts only.
  const rows = demoIds.length ? await CampaignRow.find({ userId, sourceContactId: { $in: demoIds } }, { campaignId: 1 }).lean() : [];
  const campaignIds = [...new Set(rows.map(r => String(r.campaignId)))];
  const mixed = campaignIds.length
    ? await CampaignRow.distinct('campaignId', { userId, campaignId: { $in: campaignIds }, sourceContactId: { $nin: demoIds } })
    : [];
  const mixedSet = new Set(mixed.map(String));
  const demoCampaigns = campaignIds.filter(id => !mixedSet.has(id));
  if (mixed.length) console.log(`kept ${mixed.length} campaign(s) that also hold non-demo contacts`);

  // Searches the "Find people" row started for demo jobs, and whoever they found.
  const searchIds = (await ProspectSearch.find({ userId, naukriJobId: { $in: jobIds } }, { _id: 1 }).lean()).map(x => x._id);

  const r = await Promise.all([
    Contact.deleteMany({ userId, _id: { $in: demoIds } }),
    Lead.deleteMany({ userId, dedupeKey: { $regex: `^${KEY}` } }),
    Prospect.deleteMany({ userId, $or: [{ name: TAG_RE }, { searchId: { $in: searchIds } }] }),
    ProspectSearch.deleteMany({ userId, $or: [{ naukriJobId: { $in: jobIds } }, { companyName: TAG_RE }] }),
    NaukriJob.deleteMany({ userId, sourceKey: { $regex: `^${KEY}` } }),
    Interview.deleteMany({ userId, name: TAG_RE }),
    CompanyPattern.deleteMany({ userId, domain: BOUNCE_DOMAIN }),
    Campaign.deleteMany({ userId, _id: { $in: demoCampaigns } }),
    CampaignRow.deleteMany({ userId, campaignId: { $in: demoCampaigns } }),
  ]);
  const labels = ['contacts', 'leads', 'prospects', 'searches', 'naukri jobs', 'interviews', 'company formats', 'campaigns', 'campaign rows'];
  console.log('removed:', r.map((x, i) => `${x.deletedCount} ${labels[i]}`).join(', '));
}

async function seed(userId) {
  let n = 0;
  const hist = (...steps) => steps.map(([status, msAgo]) => ({ status, changedAt: ago(msAgo), note: 'ac-demo' }));
  const contact = (name, tag, extra = {}) => ({
    userId, name: `${TAG}${name}`, email: plus(tag), company: extra.company || 'Demo Co', role: extra.role || 'Recruiter',
    template: extra.template || '', status: 'queued', approvalStatus: 'pending', ...extra,
  });

  const contacts = [
    // B1 Follow up — sent 4–6 days ago, no reply, no follow-up yet.
    ...[4, 5, 6].map((d, i) => contact(`Follow-up ${i + 1}`, `fu${i + 1}`, {
      status: 'sent', approvalStatus: 'approved', lastSentAt: ago(d * DAY), lastOutboundAt: ago(d * DAY),
      sentSubject: `Hello from the Action Center demo ${i + 1}`, messageId: `<ac-demo-${i + 1}@demo.local>`,
      statusHistory: hist(['queued', (d + 1) * DAY], ['sent', d * DAY]),
    })),
    // B2 Ready — approved, never sent.
    ...[1, 2, 3].map(i => contact(`Ready ${i}`, `ready${i}`, { approvalStatus: 'approved' })),
    // B3 Pending — waiting for Step 2. Plus the edge cases a send must leave out:
    ...[1, 2, 3].map(i => contact(`Pending ${i}`, `pend${i}`)),
    contact('Pending (emailed 2h ago → cooldown)', 'edge-cool', { lastSentAt: ago(2 * HOUR), statusHistory: hist(['sent', 2 * HOUR], ['queued', HOUR]) }),
    contact('Pending (bounced before → dead)', 'edge-dead', { statusHistory: hist(['bounced', 3 * DAY], ['queued', DAY]), bounceReason: '550 5.1.1 user unknown' }),
    contact('Pending (replied, unanswered)', 'edge-reply', { lastSentAt: ago(5 * DAY), repliedAt: ago(DAY), statusHistory: hist(['sent', 5 * DAY], ['queued', HOUR]) }),
    contact('Pending (in interviews)', 'edge-iv'),
    // Chore: Retry failed.
    ...[1, 2].map(i => contact(`Failed ${i}`, `fail${i}`, { status: 'failed', approvalStatus: 'approved', failReason: 'demo: connection reset' })),
  ].map(c => ({ ...c, name: c.name.startsWith(TAG) ? c.name : `${TAG}${c.name}` }));
  const inserted = await Contact.insertMany(contacts);
  const ivContact = inserted.find(c => c.email === plus('edge-iv'));
  await Interview.create({ userId, name: `${TAG}Interview contact`, company: 'Demo Co', email: ivContact.email, sourceType: 'contact', sourceId: String(ivContact._id) });

  // B4 New leads — with an email, not hard-rejected.
  await Lead.insertMany([1, 2, 3, 4].map(i => ({
    userId, authorName: `${TAG}Lead ${i}`, email: plus(`lead${i}`), company: 'Demo Leads Inc', role: 'Engineering Manager',
    fitScore: 10 - i, postUrl: `https://www.linkedin.com/feed/update/ac-demo-${++n}`, hiring: true,
    dedupeKey: `${KEY}lead-${i}`, status: 'new', source: 'demo',
  })));

  // B5 Ready people on Discover — high confidence, not already contacts.
  await Prospect.insertMany([1, 2, 3].map(i => ({
    userId, domain: 'gmail.com', name: `${TAG}Prospect ${i}`, nameKey: `ac-demo-prospect-${i}`, title: 'Talent Partner',
    company: 'Demo Discover Ltd', email: plus(`prospect${i}`), emailConfidence: 'high', emailPattern: 'first.last', status: 'ready',
  })));

  // Chore: mailbox check overdue.
  const s = await Settings.updateOne({ userId }, { $set: { lastMailboxCheckAt: ago(3 * HOUR) } });
  if (!s.matchedCount) console.log('note: no Settings row for this user yet — "Check mailbox" shows as "Never checked"');

  console.log(`
Seeded. Open the app and click the ⚡ button (bottom-right). You should see:
  Do now        Check mailbox (3h old) · Retry 2 failed sends
  Workflows     Follow up 3 · Send to 3 ready · Approve & send 7 pending (4 are edge cases:
                the sheet should say "3 of 7 can be sent" — cooldown, bounced before,
                waiting on your reply, in your interviews) · Start outreach to 4 leads ·
                Reach 3 people
  Run           LinkedIn / Naukri / HN / Web

Every sendable demo address is ${plus('…')} — sends land in your own inbox.
Follow-ups have a made-up Message-ID, so Gmail shows them as "Re: …" in a NEW thread;
to check real threading, send to a demo contact first, wait, then follow up.

Remove it all:  node scripts/seed-action-center-demo.js --email=${EMAIL} --clean`);
}

async function main() {
  if (!EMAIL || (!CLEAN && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(INBOX))) {
    console.error('Usage: node scripts/seed-action-center-demo.js --email=<dev account> --inbox=<your gmail> [--clean]');
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'prod') { console.error('Refusing: NODE_ENV=prod. This script is for the dev database only.'); process.exit(2); }
  if (!process.env.MONGODB_URI_DEV) { console.error('Refusing: MONGODB_URI_DEV is not set.'); process.exit(2); }
  if (process.env.MONGODB_URI_PROD && process.env.MONGODB_URI_DEV === process.env.MONGODB_URI_PROD) {
    console.error('Refusing: MONGODB_URI_DEV is the same as MONGODB_URI_PROD.'); process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URI_DEV);
  const dbName = mongoose.connection.db.databaseName;
  if (/prod/i.test(dbName)) throw new Error(`Refusing: ${dbName} looks like production`);
  console.log(`database: ${dbName}`);
  const user = await mongoose.connection.db.collection('users').findOne({ email: EMAIL });
  if (!user) throw new Error(`No user ${EMAIL} in ${dbName}`);
  await clean(user._id); // re-running starts fresh rather than doubling up
  if (!CLEAN) await seed(user._id);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err.message); process.exit(1); });
