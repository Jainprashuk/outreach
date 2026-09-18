const { createTokenAuth } = require('./accountToken');

// A read-only export link handed to someone outside the app. The token is the
// credential — 24 random bytes in the URL rather than a password to type — and
// it names the account whose contacts are shown, which one global EXPORT_PASSWORD
// could not do.
const shareTokens = createTokenAuth({ field: 'shareTokenHash', prefix: 'sh' });

module.exports = {
  issueShareToken: shareTokens.issue,
  revokeShareToken: shareTokens.revoke,
  resolveShareUser: shareTokens.resolve,
  hasShareToken: shareTokens.isRegistered,
};
