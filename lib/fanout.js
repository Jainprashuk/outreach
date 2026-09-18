const User = require('../models/User');
const Settings = require('../models/Settings');

// Scheduled work used to be a single pass over a single account's data. With
// several accounts a sweep has to visit each one, and three things matter:
//
//  - Isolation. One user's expired Gmail password must not stop everyone else's
//    mailbox being checked.
//  - A deadline. Vercel kills the function at 60s, and a sweep that is killed
//    mid-flight leaves no report at all, so it stops early and says what is left.
//  - Fairness. Stopping early always in the same order would starve whoever sorts
//    last, forever. Callers pass an ordering that puts the longest-waiting first.
//
// This runs users sequentially rather than in parallel: each one opens an IMAP
// or SMTP connection, and a free Atlas tier with a pool of 5 is not the place to
// fan out concurrently.

/** Every account, oldest `lastCheckedField` first, so nobody is starved. */
async function usersByStaleness(lastCheckedField) {
  const users = await User.find({}, { _id: 1 }).lean();
  if (users.length <= 1) return users.map(u => u._id);

  const settings = await Settings.find({}, { userId: 1, [lastCheckedField]: 1 }).lean();
  const seenAt = new Map(settings.map(s => [String(s.userId), s[lastCheckedField] ? new Date(s[lastCheckedField]).getTime() : 0]));

  return users
    .map(u => u._id)
    .sort((a, b) => (seenAt.get(String(a)) ?? 0) - (seenAt.get(String(b)) ?? 0));
}

/**
 * Runs `fn(userId)` for each id, isolating failures and stopping when `budget`
 * expires. `budget` is a lib/http.js deadline(). Returns a report the cron
 * workflow can print.
 */
async function runForUsers(userIds, fn, { budget = null } = {}) {
  const report = { total: userIds.length, processed: 0, skipped: 0, failed: 0, remaining: 0, results: [] };

  for (let i = 0; i < userIds.length; i++) {
    if (budget && budget.expired()) {
      report.remaining = userIds.length - i;
      break;
    }

    const userId = userIds[i];
    try {
      const result = await fn(userId);
      if (result && result.ok === false && result.skipped) report.skipped++;
      else report.processed++;
      report.results.push({ userId: String(userId), ...result });
    } catch (err) {
      report.failed++;
      report.results.push({ userId: String(userId), ok: false, error: err.message });
    }
  }

  return report;
}

module.exports = { usersByStaleness, runForUsers };
