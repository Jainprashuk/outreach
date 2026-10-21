/**
 * "Is this person in the portal right now?" — minute granularity, for the job
 * platform workers' check-in interval (routes/naukri.js nextPollFor). A worker
 * checks in every 20s while its owner is here, so a run they start begins
 * within seconds; otherwise every few minutes, which is what keeps a cloud
 * worker's traffic inside the free hosting limits.
 *
 * lastActiveAt (lib/lifecycle/activity.js) is the same idea at hour
 * granularity, which is right for a three-day inactivity email and far too
 * coarse here, so this is its own field. At most one write per account per
 * minute: the filter only matches a missing or stale value, and the in-memory
 * map skips even that on a warm instance.
 */
const User = require('../models/User');

const WRITE_EVERY_MS = 60 * 1000;
// How long after the last request the person still counts as here.
const PRESENT_MS = 10 * 60 * 1000;
const _recent = new Map();   // userId -> ms of this instance's last write

function touchPortal(userId) {
  if (!userId) return;
  const id = String(userId);
  const now = Date.now();
  if (now - (_recent.get(id) || 0) < WRITE_EVERY_MS) return;
  _recent.set(id, now);
  if (_recent.size > 5000) _recent.clear();
  User.updateOne(
    { _id: userId, $or: [{ portalSeenAt: null }, { portalSeenAt: { $lt: new Date(now - WRITE_EVERY_MS) } }] },
    { $set: { portalSeenAt: new Date(now) } },
  ).catch(err => {
    _recent.delete(id);
    console.error('[presence] portalSeenAt write failed:', err.message);
  });
}

async function inPortal(userId) {
  const u = await User.findById(userId, { portalSeenAt: 1 }).lean();
  return !!(u && u.portalSeenAt && Date.now() - new Date(u.portalSeenAt).getTime() < PRESENT_MS);
}

module.exports = { touchPortal, inPortal, PRESENT_MS };
