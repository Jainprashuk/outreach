/**
 * The numbers behind the admin's daily digest: what happened across EVERY
 * account in one window (normally today, 00:00 IST until now).
 *
 * The admin sees aggregates and per-account COUNTS only, the same rule as
 * routes/admin.js: no contact names, companies or message text leave here. The
 * one string per account is its login email, which the admin dashboard already
 * shows; the one other string is a campaign's name, the account's own label.
 *
 * Per-account queries are scoped with an explicit `userId`, and the send/reply
 * counts come from the same contactEvents() as the weekly report, so the digest
 * and that account's own report never disagree.
 */
const User = require('../models/User');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const SendJob = require('../models/SendJob');
const Interview = require('../models/Interview');
const Settings = require('../models/Settings');
const AccessRequest = require('../models/AccessRequest');
const { contactEvents } = require('./reportStats');
const { NEEDS_YOU_FILTER } = require('./actionQueue');
const { DAY_MS } = require('./reportPeriod');

// "Interested" in the digest = the reply categories that want something from you.
const INTERESTED = ['reviewing', 'resume-requested'];
const MAILBOX_STALE_MS = DAY_MS;

async function accountRow(u, settings, from, to, now) {
  const userId = u._id;
  const live = { userId, deleted: { $ne: true } };
  const repliedToday = { ...live, repliedAt: { $gte: from, $lt: to } };
  const [ev, interested, notSorted, contactsAdded, needsYou, campaignsRunning, interviewsNew] = await Promise.all([
    contactEvents(userId, from, to),
    Contact.countDocuments({ ...repliedToday, replyCategory: { $in: INTERESTED } }),
    // Not sorted = the classifier has not succeeded on the latest reply yet. Its
    // own success flag, not replyCategory, because a failed call can still leave
    // an old category behind.
    Contact.countDocuments({ ...repliedToday, replyClassifierOk: { $ne: true } }),
    Contact.countDocuments({ ...live, createdAt: { $gte: from, $lt: to } }),
    Contact.countDocuments({ ...live, ...NEEDS_YOU_FILTER(now) }),
    Campaign.countDocuments({ ...live, status: 'running' }),
    Interview.countDocuments({ ...live, createdAt: { $gte: from, $lt: to } }),
  ]);
  return {
    userId: String(userId),
    email: u.email,
    name: u.name || '',
    status: u.status,
    onboarded: !!(u.onboarding && u.onboarding.completedAt),
    activeToday: !!(u.lastActiveAt && u.lastActiveAt >= from),
    firstSignInToday: !!(u.firstLoginAt && u.firstLoginAt >= from && u.firstLoginAt < to),
    sent: ev.sent,
    firstSends: ev.firstSends,
    followUps: ev.followUps,
    replies: ev.replies,
    interested,
    notSorted,
    bounced: ev.bounced,
    failed: ev.failed,
    contactsAdded,
    needsYou,
    campaignsRunning,
    interviewsNew,
    hasGmail: !!(settings && settings.gmailAppPasswordEnc),
    lastMailboxCheckAt: (settings && settings.lastMailboxCheckAt) || null,
  };
}

/** Did this account DO anything in the window? Only these get a line in the email. */
const didSomething = (r) => r.activeToday || r.sent > 0 || r.replies > 0 || r.bounced > 0 || r.failed > 0
  || r.contactsAdded > 0 || r.interviewsNew > 0 || r.firstSignInToday;

/**
 * @param {{from: Date, to: Date}} p
 * @param {{ now?: Date }} opts
 */
async function buildAdminDigest(p, { now = new Date() } = {}) {
  const { from, to } = p;
  const [users, settings, accessRequests, finished] = await Promise.all([
    User.find({ status: { $ne: 'disabled' } },
      { email: 1, name: 1, status: 1, onboarding: 1, lastActiveAt: 1, firstLoginAt: 1 }).sort({ createdAt: 1 }).lean(),
    // Health only: the encrypted password is read to become a boolean, never returned.
    Settings.find({}, { userId: 1, gmailAppPasswordEnc: 1, lastMailboxCheckAt: 1 }).lean(),
    AccessRequest.countDocuments({ status: 'pending' }),
    Campaign.find({ deleted: { $ne: true }, completedAt: { $gte: from, $lt: to } }, { userId: 1, name: 1 }).lean(),
  ]);

  const settingsOf = new Map(settings.map(s => [String(s.userId), s]));
  const rows = await Promise.all(users.map(u => accountRow(u, settingsOf.get(String(u._id)), from, to, now)));
  const emailOf = new Map(rows.map(r => [r.userId, r.email]));

  // What each campaign that finished in the window sent over its whole life.
  const sentRows = finished.length
    ? await SendJob.aggregate([
      { $match: { campaignId: { $in: finished.map(c => c._id) } } },
      { $unwind: '$items' },
      { $match: { 'items.status': 'sent' } },
      { $group: { _id: '$campaignId', sent: { $sum: 1 } } },
    ])
    : [];
  const sentOf = new Map(sentRows.map(r => [String(r._id), r.sent]));
  const campaignsFinished = finished.map(c => ({
    name: c.name || 'Untitled campaign',
    email: emailOf.get(String(c.userId)) || '(deleted account)',
    sent: sentOf.get(String(c._id)) || 0,
  }));

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const totals = {
    accounts: rows.length,
    activeToday: rows.filter(r => r.activeToday).length,
    sent: sum('sent'),
    firstSends: sum('firstSends'),
    followUps: sum('followUps'),
    replies: sum('replies'),
    interested: sum('interested'),
    notSorted: sum('notSorted'),
    bounced: sum('bounced'),
    failed: sum('failed'),
    contactsAdded: sum('contactsAdded'),
    interviewsNew: sum('interviewsNew'),
    firstSignIns: rows.filter(r => r.firstSignInToday).length,
    campaignsFinished: campaignsFinished.length,
    accessRequestsPending: accessRequests,
  };

  // Problems worth a look, most urgent first. Counts and account emails only.
  const flags = [];
  if (totals.notSorted > 0) {
    flags.push(`${totals.notSorted} ${totals.notSorted === 1 ? 'reply' : 'replies'} from today not sorted yet. The reply classifier (Gemini) may be failing.`);
  }
  for (const r of rows) {
    if (r.campaignsRunning > 0 && !r.hasGmail) flags.push(`${r.email}: a campaign is running but Gmail is not connected.`);
    if (r.failed > 0) flags.push(`${r.email}: ${r.failed} ${r.failed === 1 ? 'send' : 'sends'} failed today.`);
    if (r.hasGmail && r.onboarded && r.status === 'active'
      && (!r.lastMailboxCheckAt || now - r.lastMailboxCheckAt > MAILBOX_STALE_MS)) {
      const hours = r.lastMailboxCheckAt ? Math.floor((now - r.lastMailboxCheckAt) / 3600000) : null;
      flags.push(`${r.email}: mailbox ${hours === null ? 'never checked' : `not checked in ${hours}h`}, so replies and bounces are not being picked up.`);
    }
  }

  const active = rows.filter(didSomething).sort((a, b) => b.sent - a.sent || b.replies - a.replies);
  const quiet = active.length === 0 && totals.campaignsFinished === 0 && totals.accessRequestsPending === 0;

  return {
    period: { from, to },
    generatedAt: now,
    quiet,
    totals,
    accounts: active,
    otherAccounts: rows.length - active.length,
    campaignsFinished,
    flags,
  };
}

module.exports = { buildAdminDigest, INTERESTED };
