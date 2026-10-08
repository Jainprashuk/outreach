#!/usr/bin/env node
/**
 * Prints one user's replied conversations, in full, to the terminal.
 * READ-ONLY — safe against any database, prod included.
 *
 * This is the deliberate exception to the admin dashboard's aggregates-only rule
 * (see the routes/admin.js header): it lives here, on the owner's machine with the
 * database URI, and never behind an HTTP route.
 *
 *   node scripts/view-replies.js --list --env=prod                 # who has replies
 *   node scripts/view-replies.js --email=user@x.com --env=prod     # their replied threads
 *   node scripts/view-replies.js --email=user@x.com --contact=hr@acme.com
 *   node scripts/view-replies.js --email=user@x.com --limit=5 --since=2026-10-01
 *   node scripts/view-replies.js --email=user@x.com --summary      # one line per thread
 *
 * Defaults to dev, like invite-user.js. Connects with mongoose directly, never
 * through db.js — that would run backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Contact = require('../models/Contact');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };

const ENV = value('env') === 'prod' ? 'prod' : 'dev';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const EMAIL = (value('email') || '').trim().toLowerCase();
const CONTACT = (value('contact') || '').trim().toLowerCase();
const LIMIT = Math.max(1, Number(value('limit')) || 20);
const SINCE = value('since') ? new Date(value('since')) : null;

const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');
// Prefer the plain-text part; fall back to stripping the HTML one.
const bodyOf = (m) => (m.text && m.text.trim())
  || String(m.html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

// Same definition of "replied" the mailbox uses: an inbound message on record.
const repliedFilter = (userId) => ({
  userId,
  deleted: { $ne: true },
  $or: [{ repliedAt: { $ne: null } }, { 'thread.direction': 'inbound' }],
});

async function listUsers() {
  const users = await User.find({}, { email: 1, name: 1 }).lean();
  const counts = await Contact.aggregate([
    { $match: { deleted: { $ne: true }, $or: [{ repliedAt: { $ne: null } }, { 'thread.direction': 'inbound' }] } },
    { $group: { _id: '$userId', replied: { $sum: 1 }, latest: { $max: '$lastInboundAt' } } },
  ]);
  const byId = new Map(counts.map(c => [String(c._id), c]));
  console.log(`\n[${ENV}] users and replied-thread counts\n`);
  for (const u of users) {
    const c = byId.get(String(u._id));
    console.log(`  ${u.email.padEnd(40)} ${String(c ? c.replied : 0).padStart(5)} replied   latest ${fmt(c && c.latest)}`);
  }
}

async function showUser() {
  const user = await User.findOne({ email: EMAIL }, { email: 1, name: 1 }).lean();
  if (!user) throw new Error(`No user with email ${EMAIL} in ${ENV}`);

  const q = repliedFilter(user._id);
  if (CONTACT) q.email = CONTACT;
  if (SINCE) q.$and = [{ $or: [{ lastInboundAt: { $gte: SINCE } }, { repliedAt: { $gte: SINCE } }] }];

  const total = await Contact.countDocuments(q);
  const rows = await Contact.find(q, {
    name: 1, email: 1, company: 1, status: 1, replyCategory: 1, repliedAt: 1,
    lastInboundAt: 1, replySnippet: 1, thread: 1, 'action.state': 1,
  }).sort({ lastInboundAt: -1, repliedAt: -1 }).limit(LIMIT).lean();

  console.log(`\n[${ENV}] ${user.email} — ${total} replied thread(s), showing ${rows.length}\n`);

  for (const c of rows) {
    const head = `${c.name} <${c.email}>${c.company ? ` @ ${c.company}` : ''}`;
    const meta = `status=${c.status}  category=${c.replyCategory || '—'}  action=${(c.action && c.action.state) || '—'}  last reply ${fmt(c.lastInboundAt || c.repliedAt)}`;
    if (flag('summary')) {
      console.log(`• ${head}\n    ${meta}\n    ${(c.replySnippet || '').replace(/\s+/g, ' ').slice(0, 140)}\n`);
      continue;
    }
    console.log('='.repeat(90));
    console.log(head);
    console.log(meta);
    const thread = (c.thread || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    if (!thread.length) {
      console.log(`\n  (no stored thread — snippet only)\n  ${c.replySnippet || ''}\n`);
      continue;
    }
    for (const m of thread) {
      const who = m.direction === 'inbound' ? '<<< THEM' : '>>> USER';
      console.log(`\n--- ${who}  ${fmt(m.at)}  ${m.subject || ''}`);
      console.log(bodyOf(m).split('\n').map(l => `  ${l}`).join('\n'));
    }
    console.log('');
  }
}

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  if (!flag('list') && !EMAIL) {
    console.log('Usage: --list | --email=user@x.com [--contact=] [--limit=] [--since=YYYY-MM-DD] [--summary]  [--env=prod]');
    process.exit(1);
  }
  await mongoose.connect(URI);
  try {
    if (flag('list')) await listUsers();
    else await showUser();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
