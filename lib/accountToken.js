const crypto = require('crypto');
const User = require('../models/User');
const { inApp } = require('./apps');

// Bearer tokens that identify an ACCOUNT, for callers that have no session: the
// scrape worker on a Mac, and a read-only share link handed to an outsider.
//
// Factored rather than written twice because the details are the security: only
// the SHA-256 is stored, lookup is by hash (so there is no secret-dependent
// comparison to leak timing), and the legacy global secret is honoured only
// while a single account exists — with several, one shared secret would speak
// for whichever account it liked.

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Workers check in every 20s each; a found token is remembered for a minute so
// those check-ins skip the User lookup. Issue/revoke in this process clear it.
const CACHE_MS = 60 * 1000;

function createTokenAuth({ field, prefix }) {
  const cache = new Map();   // tokenHash -> { userId, until }
  return {
    /** Issues or rotates the token. The raw value is returned once. */
    async issue(userId) {
      const raw = `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
      await User.updateOne({ _id: userId }, { $set: { [field]: hashToken(raw) } });
      cache.clear();
      return raw;
    },

    async revoke(userId) {
      await User.updateOne({ _id: userId }, { $set: { [field]: null } });
      cache.clear();
    },

    /** The account this token belongs to, or null. */
    async resolve(rawToken, { legacySecret = null } = {}) {
      if (typeof rawToken !== 'string' || !rawToken) return null;

      const tokenHash = hashToken(rawToken);
      const hit = cache.get(tokenHash);
      if (hit && hit.until > Date.now()) return hit.userId;
      const user = await User.findOne({ [field]: tokenHash }, { _id: 1 }).lean();
      if (user) {
        if (cache.size > 1000) cache.clear();
        cache.set(tokenHash, { userId: user._id, until: Date.now() + CACHE_MS });
        return user._id;
      }

      if (legacySecret && rawToken === legacySecret) {
        const users = await User.find(inApp(), { _id: 1 }).limit(2).lean();
        if (users.length === 1) return users[0]._id;
      }

      return null;
    },

    async isRegistered(userId) {
      const user = await User.findById(userId, { [field]: 1 }).lean();
      return !!(user && user[field]);
    },
  };
}

module.exports = { createTokenAuth };
