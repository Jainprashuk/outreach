/**
 * Records that a PERSON used the app — the "last visit" the inactivity email is
 * based on. Called only for a real session (requireAuth), never for cron, the
 * scrape worker or a share link, none of which mean somebody opened the app.
 *
 * At most one write per account per hour: the filter only matches when the
 * stored value is missing or over an hour old, so the other requests in that
 * hour cost a no-op update. The in-memory map skips even that on a warm
 * instance. Hour granularity is plenty for a three-day threshold.
 */
const User = require('../../models/User');

const HOUR_MS = 60 * 60 * 1000;
const _recent = new Map();   // userId -> ms of this instance's last write

function touchActivity(userId) {
  if (!userId) return;
  const id = String(userId);
  const now = Date.now();
  if (now - (_recent.get(id) || 0) < HOUR_MS) return;
  _recent.set(id, now);
  if (_recent.size > 5000) _recent.clear();
  User.updateOne(
    // `null` matches a missing field too — every account from before this.
    { _id: userId, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lt: new Date(now - HOUR_MS) } }] },
    { $set: { lastActiveAt: new Date(now) } },
  ).catch(err => {
    _recent.delete(id);
    console.error('[activity] lastActiveAt write failed:', err.message);
  });
}

module.exports = { touchActivity };
