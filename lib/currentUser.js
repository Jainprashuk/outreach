const User = require('../models/User');

// Requests that carry a session already know who they are — requireAuth sets
// req.userId from it. This fills the gap for requests that legitimately have no
// session: the GitHub Actions cron, the scrape worker on the Mac, the read-only
// share link, and local AUTH_OPEN development.
//
// Those all still assume a single account. Resolving "the" user is therefore a
// deliberate stopgap, and it refuses rather than guessing once a second account
// exists — phase 4 gives the cron a real per-user fan-out, phase 5 does the same
// for the worker.
let cached = null;

async function resolveSoleUserId() {
  if (cached) return cached;

  const users = await User.find().select('_id').limit(2).lean();
  if (users.length === 0) {
    throw new Error('No user account exists yet — run scripts/migrate-multi-tenant.js');
  }
  if (users.length > 1) {
    throw new Error('This request has no session, and more than one account exists, so its owner is ambiguous. Machine endpoints need a per-user owner (phases 4 and 5) before a second account is usable.');
  }

  cached = users[0]._id;
  return cached;
}

const attachUser = async (req, res, next) => {
  if (req.userId) return next();
  // A scheduled sweep has no single owner by design — it visits every account in
  // turn (lib/fanout.js). Resolving "the" user here would 503 the whole cron the
  // moment a second account exists, which is exactly when the fan-out matters.
  if (req.isCron) return next();
  try {
    req.userId = await resolveSoleUserId();
    next();
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
};

module.exports = { attachUser, resolveSoleUserId };
