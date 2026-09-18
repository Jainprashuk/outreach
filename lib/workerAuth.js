const { createTokenAuth } = require('./accountToken');

// The LinkedIn scrape worker runs on a Mac and has no cookie, so it carries a
// bearer token in X-Worker-Secret. That token says WHOSE runs are being claimed:
// a run, the leads it ingests and the 7-day LinkedIn block it can trigger all
// belong to exactly one account.
const workerTokens = createTokenAuth({ field: 'workerTokenHash', prefix: 'wk' });

module.exports = {
  issueWorkerToken: workerTokens.issue,
  revokeWorkerToken: workerTokens.revoke,
  resolveWorkerUser: workerTokens.resolve,
  hasWorkerToken: workerTokens.isRegistered,
};
