const crypto = require('crypto');
const User = require('../models/User');

// Bearer tokens that identify an ACCOUNT, for callers that have no session: the
// scrape worker on a Mac, and a read-only share link handed to an outsider.
//
// Factored rather than written twice because the details are the security: only
// the SHA-256 is stored, lookup is by hash (so there is no secret-dependent
// comparison to leak timing), and the legacy global secret is honoured only
// while a single account exists — with several, one shared secret would speak
// for whichever account it liked.

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function createTokenAuth({ field, prefix }) {
  return {
    /** Issues or rotates the token. The raw value is returned once. */
    async issue(userId) {
      const raw = `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
      await User.updateOne({ _id: userId }, { $set: { [field]: hashToken(raw) } });
      return raw;
    },

    async revoke(userId) {
      await User.updateOne({ _id: userId }, { $set: { [field]: null } });
    },

    /** The account this token belongs to, or null. */
    async resolve(rawToken, { legacySecret = null } = {}) {
      if (typeof rawToken !== 'string' || !rawToken) return null;

      const user = await User.findOne({ [field]: hashToken(rawToken) }, { _id: 1 }).lean();
      if (user) return user._id;

      if (legacySecret && rawToken === legacySecret) {
        const users = await User.find({}, { _id: 1 }).limit(2).lean();
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
