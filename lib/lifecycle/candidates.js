/**
 * WHO is due WHICH lifecycle email at a given instant.
 *
 * Read-only by design: nothing in this file writes. The daily/weekly sweeps
 * call it and then hand each result to deliver(); scripts/lifecycle-preview.js
 * calls the very same functions against prod, which is what makes the preview
 * an honest answer rather than a re-implementation that might drift.
 *
 * A candidate is { userId, type, key, due, context } — `key` is the ledger slot
 * (models/LifecycleEmail.js), and anything that already has a row for that slot
 * is not a candidate.
 */
const User = require('../../models/User');
const Contact = require('../../models/Contact');
const LifecycleEmail = require('../../models/LifecycleEmail');
const { SETUP_REMINDER_AFTER_DAYS, INACTIVE_AFTER_DAYS } = require('./types');
const { lastFullWeek, istDateString, DAY_MS } = require('../reportPeriod');

const USER_FIELDS = {
  email: 1, name: 1, status: 1, createdAt: 1, lastLoginAt: 1, firstLoginAt: 1, lastActiveAt: 1,
  onboarding: 1, emailOptOut: 1, emailBlockedByAdmin: 1, isAdmin: 1,
};

/** Slots that already have a row, as a Set of `${userId}|${type}|${key}`. */
async function takenSlots(type, keys = null) {
  const rows = await LifecycleEmail.find(
    { type, ...(keys ? { key: { $in: keys } } : {}) },
    { userId: 1, type: 1, key: 1 },
  ).lean();
  return new Set(rows.map(r => `${r.userId}|${r.type}|${r.key}`));
}
const slot = (userId, type, key) => `${userId}|${type}|${key}`;

/** When a signed-in-but-not-set-up account's five days started. */
const setupAnchor = (u) => u.firstLoginAt || (u.onboarding && u.onboarding.startedAt) || u.lastLoginAt || null;

// ── A. Setup reminder ────────────────────────────────────────────────────────
async function setupReminderCandidates(now = new Date()) {
  const cutoff = new Date(now.getTime() - SETUP_REMINDER_AFTER_DAYS * DAY_MS);
  // status 'active' = has signed in at least once. `completedAt: null` also
  // matches a missing field, which is what a pre-onboarding account has.
  const users = await User.find({ status: 'active', 'onboarding.completedAt': null }, USER_FIELDS).lean();
  const taken = await takenSlots('setup-reminder', ['setup-reminder']);
  return users
    .filter(u => { const a = setupAnchor(u); return a && a <= cutoff; })
    .filter(u => !taken.has(slot(u._id, 'setup-reminder', 'setup-reminder')))
    .map(u => ({
      user: u, userId: u._id, type: 'setup-reminder', key: 'setup-reminder',
      due: new Date(setupAnchor(u).getTime() + SETUP_REMINDER_AFTER_DAYS * DAY_MS),
    }));
}

/**
 * The most recent send per account — latest of lastSentAt/followUpSentAt, which
 * the send workers stamp at the moment an email goes out.
 */
async function lastSendByUser(userIds) {
  const rows = await Contact.aggregate([
    { $match: { userId: { $in: userIds }, $or: [{ lastSentAt: { $ne: null } }, { followUpSentAt: { $ne: null } }] } },
    { $group: { _id: '$userId', a: { $max: '$lastSentAt' }, b: { $max: '$followUpSentAt' } } },
  ]);
  return new Map(rows.map(r => [String(r._id), [r.a, r.b].filter(Boolean).reduce((x, y) => (y > x ? y : x), null)]));
}

/**
 * The instant a quiet spell began: the latest of the last visit, the last send,
 * and the day lifecycle emails were first switched on (nobody's visits were
 * recorded before then, so nobody may be judged idle from before it).
 */
function inactiveAnchor(u, lastSend, firstEnabledAt) {
  return [u.lastActiveAt, lastSend, firstEnabledAt]
    .filter(Boolean).map(d => new Date(d))
    .reduce((x, y) => (y > x ? y : x), new Date(0));
}

// ── C. Inactivity nudge ──────────────────────────────────────────────────────
async function inactiveCandidates(now = new Date(), config) {
  // Never enabled = the clock has not started. Treat "now" as the start, which
  // makes nobody due — exactly right for a database that has never sent one.
  const firstEnabledAt = config.firstEnabledAt || now;
  const cutoff = new Date(now.getTime() - INACTIVE_AFTER_DAYS * DAY_MS);
  const users = await User.find({ status: 'active', 'onboarding.completedAt': { $ne: null } }, USER_FIELDS).lean();
  if (!users.length) return [];
  const [sends, taken] = await Promise.all([lastSendByUser(users.map(u => u._id)), takenSlots('inactive')]);

  const out = [];
  for (const u of users) {
    const anchor = inactiveAnchor(u, sends.get(String(u._id)), firstEnabledAt);
    if (anchor > cutoff) continue;
    const key = `inactive:${anchor.toISOString()}`;
    if (taken.has(slot(u._id, 'inactive', key))) continue;
    out.push({ user: u, userId: u._id, type: 'inactive', key, due: new Date(anchor.getTime() + INACTIVE_AFTER_DAYS * DAY_MS), context: { since: anchor } });
  }
  return out;
}

/** Re-derives the inactive key for one user — deliver() uses it to confirm still-due. */
async function currentInactiveKey(u, config, now = new Date()) {
  const sends = await lastSendByUser([u._id]);
  const anchor = inactiveAnchor(u, sends.get(String(u._id)), config.firstEnabledAt || now);
  return { key: `inactive:${anchor.toISOString()}`, since: anchor, due: anchor <= new Date(now.getTime() - INACTIVE_AFTER_DAYS * DAY_MS) };
}

// ── D. Weekly report ─────────────────────────────────────────────────────────
const weekKey = (now = new Date()) => `week:${istDateString(lastFullWeek(now).from)}`;

async function weeklyReportCandidates(now = new Date()) {
  const key = weekKey(now);
  const users = await User.find({ status: 'active', 'onboarding.completedAt': { $ne: null } }, USER_FIELDS).lean();
  const taken = await takenSlots('weekly-report', [key]);
  return users
    .filter(u => !taken.has(slot(u._id, 'weekly-report', key)))
    .map(u => ({ user: u, userId: u._id, type: 'weekly-report', key, due: now, context: { period: lastFullWeek(now) } }));
}

// ── E. Daily admin digest ────────────────────────────────────────────────────
const dayKey = (now = new Date()) => `day:${istDateString(now)}`;

async function adminDigestCandidates(now = new Date()) {
  const key = dayKey(now);
  // `isAdmin: true`, never `$ne: false` — see models/User.js.
  const users = await User.find({ status: 'active', isAdmin: true }, USER_FIELDS).lean();
  const taken = await takenSlots('admin-daily', [key]);
  return users
    .filter(u => !taken.has(slot(u._id, 'admin-daily', key)))
    .map(u => ({ user: u, userId: u._id, type: 'admin-daily', key, due: now }));
}

module.exports = {
  setupReminderCandidates, inactiveCandidates, weeklyReportCandidates, adminDigestCandidates,
  currentInactiveKey, setupAnchor, weekKey, dayKey, USER_FIELDS,
};
