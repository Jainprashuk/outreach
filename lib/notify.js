const Notification = require('../models/Notification');
const User = require('../models/User');

/**
 * The notification catalog. Every type the app can raise is listed here, with its
 * default severity and whether it is admin-only. `notify()` refuses an unknown
 * type, so the list in the bell can never grow by accident.
 *
 * S = success · P = needs attention · I = info · A = admin only (the ids the
 * owner picked from, 2026-10).
 */
const TYPES = {
  // success
  'send.finished':        { severity: 'success' },  // S1
  'replies.new':          { severity: 'success' },  // S2
  'campaign.finished':    { severity: 'success' },  // S3
  'scrape.finished':      { severity: 'success' },  // S4
  'naukri.applied':       { severity: 'success' },  // S5
  'discover.finished':    { severity: 'success' },  // S6
  'send.resumed':         { severity: 'success' },  // S7
  'setup.complete':       { severity: 'success' },  // S8
  'report.sent':          { severity: 'success' },  // S9
  // needs attention
  'send.quota_paused':    { severity: 'warning' },  // P1
  'send.failed':          { severity: 'error' },    // P2
  'gmail.auth_failed':    { severity: 'error' },    // P3
  'campaign.error':       { severity: 'error' },    // P4
  'scrape.worker_offline':{ severity: 'warning' },  // P5
  'scrape.worker_back':   { severity: 'success' },  // P5 (recovered)
  'naukri.attention':     { severity: 'warning' },  // P6
  'interview.due':        { severity: 'warning' },  // P7
  'send.high_bounce':     { severity: 'warning' },  // P8
  'send.skipped_bounced': { severity: 'info' },     // P9
  'scrape.failed':        { severity: 'error' },    // P10
  // info
  'reply.needs_you':      { severity: 'info' },     // I1
  'setup.incomplete':     { severity: 'info' },     // I2
  'contact.unsubscribed': { severity: 'info' },     // I3
  // admin
  'admin.access_request': { severity: 'info', admin: true },     // A1
  'admin.issue':          { severity: 'warning', admin: true },  // A2
  'admin.cron_stalled':   { severity: 'error', admin: true },    // A3
  'admin.user_joined':    { severity: 'info', admin: true },     // A4
};

const clip = (value, max) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/**
 * Raise a notification for one user. Resolves to the stored row, or null when it
 * was not stored (unknown type, duplicate `dedupeKey`, or a database error) —
 * never throws, so callers can fire it without a try/catch.
 *
 * `dedupeKey` makes the call idempotent per user: an Inngest retry or a second
 * worker finishing the same job raises the notification once. Build it from the
 * thing that happened (`send.finished:<jobId>`), not from the clock.
 */
async function notify(userId, { type, title, body = '', link = '', severity, dedupeKey, meta = {} }) {
  try {
    const def = TYPES[type];
    if (!def) { console.error(`notify: unknown notification type "${type}"`); return null; }
    if (!userId || !title) return null;
    const doc = {
      userId, type, title: clip(title, 140), body: clip(body, 300), link: clip(link, 200),
      severity: severity || def.severity, meta, createdAt: new Date(),
    };
    if (dedupeKey) {
      const res = await Notification.updateOne(
        { userId, dedupeKey: String(dedupeKey) },
        { $setOnInsert: { ...doc, dedupeKey: String(dedupeKey) } },
        { upsert: true },
      );
      return res.upsertedCount ? doc : null;
    }
    return await Notification.create(doc);
  } catch (err) {
    // A duplicate-key race on the unique index is the dedupe working, not a fault.
    if (err && err.code !== 11000) console.error('notify failed:', err.message);
    return null;
  }
}

/** Same notification to every active admin (access requests, new issues, a stalled scheduler). */
async function notifyAdmins(payload) {
  try {
    const admins = await User.find({ isAdmin: true, status: { $ne: 'disabled' } }, { _id: 1 }).lean();
    await Promise.all(admins.map(a => notify(a._id, {
      ...payload,
      dedupeKey: payload.dedupeKey ? `${payload.dedupeKey}` : undefined,
    })));
  } catch (err) {
    console.error('notifyAdmins failed:', err.message);
  }
}

module.exports = { notify, notifyAdmins, TYPES };
