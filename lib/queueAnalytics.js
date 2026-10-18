// The Mailbox "Needs you" queue as numbers, for Analytics → Outreach. Reads only
// Contact.action and buckets each item with bucketOf — the in-memory twin of the
// filter the Mailbox tabs use (lib/actionQueue.js), so the card and the tabs
// can't disagree. Contact.action keeps only the current state, so "resolved"
// counts items whose current state is done and started within the window.

const mongoose = require('mongoose');
const { QUEUE_BUCKETS, bucketOf, effectiveReason } = require('./actionQueue');

const DAY = 864e5;
const REASON_LABELS = {
  'resume-requested': 'Asked for your resume', 'needs-attention': 'Needs your attention', unclassified: 'Not yet sorted',
  reviewing: 'Reviewing', reconnect: 'Time to reconnect', 'no-response': 'No reply in a week',
  declined: 'Said no', 'no-action': 'Nothing to do', 'you-replied': 'You replied', manual: 'Set by you',
};
const RESOLVED_LABELS = { 'you-replied': 'You replied', manual: 'Marked done by you', auto: 'Closed automatically' };

async function queueAnalytics(Contact, userId, { days = 30, now = new Date() } = {}) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const rows = await Contact.find(
    { userId: uid, deleted: { $ne: true }, 'action.state': { $ne: null } },
    { action: 1 },
  ).lean();
  const since = new Date(now.getTime() - days * DAY);

  const buckets = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, 0]));
  const reasons = new Map();   // open buckets only: needs-you and follow-up
  const resolved = { 'you-replied': 0, manual: 0, auto: 0, other: 0 };
  let resolvedTotal = 0;
  for (const { action } of rows) {
    const b = bucketOf(action, now);
    if (!b || buckets[b] == null) continue;
    buckets[b]++;
    if (b === 'needs-you' || b === 'follow-up') {
      const why = effectiveReason(action, now) || 'unclassified';
      const key = `${b}:${why}`;
      const r = reasons.get(key) || { bucket: b, reason: why, label: REASON_LABELS[why] || why, n: 0 };
      r.n++;
      reasons.set(key, r);
    }
    if (b === 'done' && action.since && new Date(action.since) >= since) {
      resolvedTotal++;
      resolved[RESOLVED_LABELS[action.resolvedBy] ? action.resolvedBy : 'other']++;
    }
  }
  return {
    days,
    buckets,
    reasons: [...reasons.values()].sort((a, b) => b.n - a.n || a.bucket.localeCompare(b.bucket) || a.reason.localeCompare(b.reason)),
    resolved: { total: resolvedTotal, by: Object.entries(resolved).filter(([, n]) => n).map(([k, n]) => ({ key: k, label: RESOLVED_LABELS[k] || 'Other', n })) },
  };
}

module.exports = { queueAnalytics };
