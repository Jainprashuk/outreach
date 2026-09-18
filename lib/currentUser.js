const User = require('../models/User');

// Every caller now establishes its own owner before reaching a route handler:
// a session (requireAuth), a worker token, a share link, or a cron sweep that
// visits every account in turn. So a request arriving here with no owner is a
// bug, not a case to guess at.
//
// It used to guess — resolve "the sole account" and carry on. That silently
// worked while one account existed and turned into an opaque 503 the moment a
// second one did, which is the worst possible time to find out. Now it fails
// the same way whether there is one account or fifty.
//
// The single exception is AUTH_OPEN, the local-development bypass, which has no
// session by definition. That resolution lives in requireAuth, next to the
// bypass itself, rather than hiding down here.

// Deliberately not cached. This is a guard, and a cached "yes" would keep
// answering after a second account appeared — a warm instance would go on
// honouring the legacy shared password precisely when it must stop. It is an
// indexed query capped at two documents, on paths that are rare by design.
async function resolveSoleUserId() {
  const users = await User.find().select('_id').limit(2).lean();
  if (users.length === 0) {
    throw new Error('No user account exists yet — run scripts/migrate-multi-tenant.js');
  }
  if (users.length > 1) {
    throw new Error('more than one account exists, so there is no single owner to assume — sign in with email and password');
  }

  return users[0]._id;
}

const attachUser = (req, res, next) => {
  if (req.userId) return next();
  // A scheduled sweep has no single owner by design — it visits every account
  // (lib/fanout.js), so the route, not this middleware, decides who to act for.
  if (req.isCron) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

module.exports = { attachUser, resolveSoleUserId };
