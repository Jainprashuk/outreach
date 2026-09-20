/**
 * Refuses to send email for an account that has not finished first-run setup.
 *
 * The wizard redirect in the client is UX — it can be skipped with a curl. This
 * is the part that means something, and it is deliberately narrow: it guards
 * only the endpoints that actually emit email, not the whole API. A blanket
 * gate on /api would also catch cron, the scrape worker, Inngest, the share
 * endpoints and the wizard's own calls to /api/settings and /api/config, which
 * is how a safety check turns into an outage.
 */
const User = require('../models/User');
const { isOnboarded } = require('./onboarding');

async function requireOnboarded(req, res, next) {
  // Machine callers are exempt. A scheduled release acts on behalf of an account
  // that was already set up when the campaign was created, and re-deciding that
  // here would let an unrelated Settings hiccup silently stall a running
  // campaign. Background work derives its owner from the document it processes.
  if (req.isCron || req.isWorker) return next();
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await User.findById(req.userId, { onboarding: 1 }).lean();
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (isOnboarded(user)) return next();

    // 403 with a machine-readable marker, so the client can route to the wizard
    // rather than showing a dead-end error.
    return res.status(403).json({
      error: 'Finish setting up your account before sending.',
      onboardingRequired: true,
    });
  } catch (err) {
    return res.status(503).json({ error: `Database not available: ${err.message}` });
  }
}

module.exports = { requireOnboarded };
