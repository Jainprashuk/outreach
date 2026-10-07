/**
 * Sends ONE lifecycle email slot, safely.
 *
 *   1. load the account and the switches, fresh
 *   2. confirm the slot is still due (setup not finished since, still idle, …)
 *   3. gate.decide() — every switch, opt-out and config check
 *   4. claim the slot in the ledger (unique index = exactly-once)
 *   5. build, send, record
 *
 * Master switch OFF writes nothing: the whole feature is paused, and nothing is
 * decided. Every other "no" writes a 'skipped' row, which is what makes "turning
 * one back on does not catch up" true. Test mode's "no" is recorded under a
 * separate `#test` key so that it does NOT use up the real slot.
 */
const User = require('../../models/User');
const Settings = require('../../models/Settings');
const Contact = require('../../models/Contact');
const Campaign = require('../../models/Campaign');
const Interview = require('../../models/Interview');
const LifecycleEmail = require('../../models/LifecycleEmail');
const { getLifecycleConfig } = require('./config');
const { decide } = require('./gate');
const { TYPES } = require('./types');
const { currentInactiveKey, USER_FIELDS, weekKey, dayKey } = require('./candidates');
const templates = require('./templates');
const { unsubscribeUrl, appUrl } = require('./unsubscribe');
const { sendSystemEmail } = require('../systemMail');
const { checkReadiness } = require('../onboarding');
const { buildReportStats } = require('../reportStats');
const { buildAdminDigest } = require('../adminDigestStats');
const { renderReportPdf } = require('../reportPdf');
const { lastFullWeek, lastNDays, istDateString, DAY_MS } = require('../reportPeriod');
const { CATEGORY_LABELS } = require('../reportStats');
const { NEEDS_YOU_FILTER } = require('../actionQueue');

const MAX_ATTEMPTS = 3;

const isDup = (err) => err && err.code === 11000;

/** Inserts a terminal 'skipped' row. A slot that already has a row keeps it. */
async function recordSkip({ userId, type, key, reason, to = '' }) {
  try {
    await LifecycleEmail.create({ userId, type, key, status: 'skipped', reason, to });
  } catch (err) {
    if (!isDup(err)) throw err;
  }
}

/**
 * Claims the slot for sending. Returns the row, or null when someone else holds
 * it (already sent, skipped, in flight, or failed too often).
 */
async function claim({ userId, type, key, to, testMode }) {
  try {
    return await LifecycleEmail.create({ userId, type, key, status: 'claimed', to, testMode, attempts: 1 });
  } catch (err) {
    if (!isDup(err)) throw err;
  }
  // Only a FAILED slot may be retried, and only a few times. A 'claimed' row
  // whose instance died mid-send is deliberately left alone: re-sending would
  // risk a duplicate, and one lost email is the better failure.
  return LifecycleEmail.findOneAndUpdate(
    { userId, type, key, status: 'failed', attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: 'claimed', to, testMode, error: null }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
}

// ── Content builders, one per type ───────────────────────────────────────────

async function inactiveNews(user, since, now) {
  const userId = user._id;
  const [replies, needsAttention, replyPeople, finishedCampaigns, upcomingInterviews] = await Promise.all([
    Contact.countDocuments({ userId, deleted: { $ne: true }, repliedAt: { $gte: since } }),
    Contact.countDocuments({ userId, deleted: { $ne: true }, repliedAt: { $gte: since }, ...NEEDS_YOU_FILTER(now) }),
    Contact.find({ userId, deleted: { $ne: true }, repliedAt: { $gte: since } }, { name: 1, company: 1, replyCategory: 1 })
      .sort({ repliedAt: -1 }).limit(5).lean(),
    Campaign.find({ userId, deleted: { $ne: true }, completedAt: { $gte: since } }, { name: 1 }).limit(5).lean(),
    Interview.countDocuments({ userId, deleted: { $ne: true }, status: { $nin: ['selected', 'rejected'] }, interviewAt: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY_MS) } }),
  ]);
  return {
    replies, needsAttention, upcomingInterviews,
    finishedCampaigns: finishedCampaigns.map(c => ({ name: c.name })),
    replyPeople: replyPeople.map(c => ({ name: c.name || '', company: c.company || '', label: CATEGORY_LABELS[c.replyCategory || 'unclassified'] || 'Reply' })),
  };
}

/**
 * Builds { subject, text, html, attachments?, headers? } for a type. Also used
 * by the admin's "send me a sample" and by manual reports.
 */
async function buildMessage(type, user, { now = new Date(), period = null, since = null, manual = false } = {}) {
  // Every path that sends — sweeps, manual reports AND the admin's sample —
  // comes through here, so this is where a relative (dead) link is stopped.
  if (!appUrl()) throw new Error('OUTREACH_URL is not set, so the links in this email would not work. Set it to the app\'s public URL, e.g. https://outreach.example.com');
  const pref = TYPES[type] && TYPES[type].pref;
  const unsub = pref ? unsubscribeUrl(user._id, pref) : null;
  const headers = unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;

  if (type === 'welcome') {
    const s = await Settings.findOne({ userId: user._id }, { gmailEmail: 1, senderName: 1 }).lean();
    return templates.welcome({ name: user.name || (s && s.senderName), gmail: s && s.gmailEmail });
  }
  if (type === 'setup-reminder') {
    const s = await Settings.findOne({ userId: user._id }, { gmailAppPasswordEnc: 1, senderName: 1 }).lean();
    const ready = checkReadiness(s);
    const missing = Object.entries(ready).filter(([, ok]) => !ok).map(([k]) => k);
    return { ...templates.setupReminder({ name: user.name, missing: missing.length ? missing : ['gmail'], unsub }), headers };
  }
  if (type === 'inactive') {
    const from = since || new Date(now.getTime() - 3 * DAY_MS);
    return { ...templates.inactive({ name: user.name, since: from, news: await inactiveNews(user, from, now), unsub }), headers };
  }
  if (type === 'weekly-report' || type === 'manual-report') {
    const p = period || lastFullWeek(now);
    const stats = await buildReportStats(user._id, p, { now });
    const msg = templates.report({ name: user.name, stats, unsub, manual: manual || type === 'manual-report' });
    const attach = !(stats.quiet && type === 'weekly-report' && !manual);
    const attachments = attach
      ? [{ filename: `outreach-report-${istDateString(p.from)}.pdf`, content: await renderReportPdf(stats, { name: user.name, email: user.email }) }]
      : [];
    return { ...msg, attachments, headers: type === 'weekly-report' ? headers : undefined, quiet: stats.quiet };
  }
  if (type === 'admin-daily') {
    // Today so far, 00:00 IST until now. Admins only, whoever calls this.
    if (user.isAdmin !== true) throw new Error('The daily digest is for admins only');
    const stats = await buildAdminDigest(lastNDays(1, now), { now });
    return { ...templates.adminDigest({ name: user.name, stats }), quiet: stats.quiet };
  }
  throw new Error(`No template for ${type}`);
}

/** Is this slot STILL due right now? Things change between the sweep and the send. */
async function stillDue(type, key, user, config, now) {
  if (type === 'welcome') return !!(user.onboarding && user.onboarding.completedAt);
  if (type === 'setup-reminder') return user.status === 'active' && !(user.onboarding && user.onboarding.completedAt);
  if (type === 'inactive') {
    const cur = await currentInactiveKey(user, config, now);
    return cur.due && cur.key === key ? { since: cur.since } : false;
  }
  if (type === 'weekly-report') return !!(user.onboarding && user.onboarding.completedAt) && key === weekKey(now);
  // A digest delivered after midnight would describe the wrong day: drop it.
  if (type === 'admin-daily') return user.isAdmin === true && user.status === 'active' && key === dayKey(now);
  return false;
}

/**
 * The one entry point for scheduled and event-driven lifecycle mail.
 * @returns {{ status: string, reason?: string }}  never throws for a "no";
 *   throws only when the SEND failed, so Inngest retries it.
 */
async function deliver({ type, userId, key }, { now = new Date() } = {}) {
  const [user, config] = await Promise.all([
    User.findById(userId, USER_FIELDS).lean(),
    getLifecycleConfig(),
  ]);
  if (!user) return { status: 'skipped', reason: 'no-user' };

  const due = await stillDue(type, key, user, config, now);
  if (!due) return { status: 'skipped', reason: 'not-due' };

  const decision = decide(type, user, config);
  if (!decision.send) {
    if (decision.reason === 'master-off') return { status: 'paused', reason: 'master-off' };
    // Deployment config gaps are not a decision about this person either; do
    // not burn their slot over a missing env var.
    if (decision.reason === 'sender-not-configured' || decision.reason === 'links-not-configured') {
      return { status: 'paused', reason: decision.reason };
    }
    const testOnly = decision.reason === 'test-mode' || decision.reason === 'test-mode-no-recipient';
    await recordSkip({ userId: user._id, type, key: testOnly ? `${key}#test` : key, reason: decision.reason, to: user.email });
    return { status: 'skipped', reason: decision.reason };
  }

  // Test-mode sends to the admin also go under #test, so the admin still gets
  // the real one once test mode is switched off.
  const slotKey = decision.testMode ? `${key}#test` : key;
  const row = await claim({ userId: user._id, type, key: slotKey, to: decision.to, testMode: decision.testMode });
  if (!row) return { status: 'skipped', reason: 'already-handled' };

  try {
    const msg = await buildMessage(type, user, { now, since: due && due.since });
    const { id } = await sendSystemEmail({ ...msg, to: decision.to });
    await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'sent', providerId: id, sentAt: new Date(), reason: msg.quiet ? 'quiet-note' : null } });
    return { status: 'sent', to: decision.to, testMode: decision.testMode };
  } catch (err) {
    await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'failed', error: String(err.message).slice(0, 300) } });
    throw err;
  }
}

module.exports = { deliver, buildMessage, recordSkip, claim };
