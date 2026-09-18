const crypto = require('crypto');
const User = require('../models/User');

// The LinkedIn scrape worker runs on a Mac and has no cookie, so it carries a
// bearer token in X-Worker-Secret. With one owner that token only had to prove
// "you are the worker". Now it also has to say WHOSE runs are being claimed,
// because a run, the leads it ingests and the 7-day LinkedIn block it can
// trigger all belong to exactly one account.
//
// Only the SHA-256 is stored, so a leak of the users collection cannot be
// replayed. Looking the token up by hash is also constant-time by construction —
// there is no secret-dependent comparison to leak timing.

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/** Issues (or rotates) the token for one account. The raw value is shown once. */
async function issueWorkerToken(userId) {
  const raw = 'wk_' + crypto.randomBytes(24).toString('base64url');
  await User.updateOne({ _id: userId }, { $set: { workerTokenHash: hashToken(raw) } });
  return raw;
}

async function revokeWorkerToken(userId) {
  await User.updateOne({ _id: userId }, { $set: { workerTokenHash: null } });
}

/**
 * The account a presented worker token belongs to, or null.
 *
 * `legacySoleOwner` covers the single-owner deployment that predates per-user
 * tokens: the global WORKER_SECRET keeps working, but only while there is
 * exactly one account. Accepting it with several accounts would mean one shared
 * secret could claim anybody's runs — the same trap as the Gmail env fallback.
 */
async function resolveWorkerUser(rawToken, { legacySecret = null } = {}) {
  if (typeof rawToken !== 'string' || !rawToken) return null;

  const user = await User.findOne({ workerTokenHash: hashToken(rawToken) }, { _id: 1 }).lean();
  if (user) return user._id;

  if (legacySecret && rawToken === legacySecret) {
    const users = await User.find({}, { _id: 1 }).limit(2).lean();
    if (users.length === 1) return users[0]._id;
  }

  return null;
}

module.exports = { issueWorkerToken, revokeWorkerToken, resolveWorkerUser };
