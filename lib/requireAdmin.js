/**
 * Gate for the fleet-wide admin routes.
 *
 * Deliberately not cached and deliberately not carried on the session row:
 * revoking someone's admin must take effect on their next request, and a warm
 * serverless instance would otherwise keep honouring it. Same reasoning as
 * resolveSoleUserId and mailer.isSoleAccount, both of which re-read for the
 * same reason.
 */
const User = require('../models/User');

async function requireAdmin(req, res, next) {
  // 401 and 403 mean different things to the client: "you are not signed in"
  // versus "you are, and the answer is still no".
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  // Admin is a SESSION-only property. A cron secret, a worker bearer token, a
  // share link and the AUTH_OPEN dev bypass all set req.userId with no human
  // behind them; none of them may ever read every account's totals.
  if (req.isCron || req.isWorker || req.isShareLink) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const user = await User.findById(req.userId, { isAdmin: 1, status: 1 }).lean();
    // `=== true`, never `!== false`: .lean() skips schema defaults, so a row
    // written before isAdmin existed reads back as undefined.
    if (!user || user.isAdmin !== true || user.status === 'disabled') {
      // 403 rather than 404: the existence of an admin area is not a secret,
      // and pretending otherwise makes this miserable to debug.
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.isAdmin = true;
    req.adminEmail = user.email;
    return next();
  } catch (err) {
    return res.status(503).json({ error: `Database not available: ${err.message}` });
  }
}

module.exports = { requireAdmin };
