/**
 * Gate for the shared Library (routes/library.js) — the one place that returns
 * OTHER accounts' contact data. Same shape as lib/requireAdmin.js, for the same
 * reasons: re-read on every request so that an admin switching access off takes
 * effect on the next click, and session-only so that no token (cron, worker,
 * share link) can ever read across accounts.
 */
const User = require('../models/User');

/** Admins always see the Library; everyone else only once an admin turns it on. */
const canSeeLibrary = (user) =>
  !!user && user.status !== 'disabled' && (user.isAdmin === true || user.libraryAccess === true);

async function requireLibraryAccess(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.isCron || req.isWorker || req.isShareLink) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const user = await User.findById(req.userId, { isAdmin: 1, libraryAccess: 1, status: 1 }).lean();
    if (!canSeeLibrary(user)) return res.status(403).json({ error: 'The Library is not turned on for your account.' });
    return next();
  } catch (err) {
    return res.status(503).json({ error: `Database not available: ${err.message}` });
  }
}

module.exports = { requireLibraryAccess, canSeeLibrary };
