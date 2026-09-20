/**
 * Shared helpers for the HTTP test suites.
 *
 * Sign-in is a code emailed to the user, which a test obviously cannot read out
 * of an inbox. Rather than forging a session cookie — which would skip the very
 * middleware the tests exist to exercise — these drive the real endpoints and
 * read the issued code straight out of the database, the same way
 * test-token-isolation.js reads tokens it has just issued.
 *
 * Requires an open mongoose connection: call AFTER mongoose.connect().
 */
const mongoose = require('mongoose');

/**
 * Signs in over HTTP and returns the session cookie.
 *
 * @param {{base: string, email: string}} opts
 * @returns {Promise<string>} e.g. "outreach_session=abc123"
 */
async function loginViaOtp({ base, email }) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('loginViaOtp needs an open mongoose connection — call mongoose.connect() first');
  }

  const requested = await fetch(base + '/api/auth/request-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!requested.ok) throw new Error(`request-code failed (${requested.status})`);

  // The plaintext code is never stored, so the test cannot read it back — it
  // brute-forces its own code against its own freshly issued row instead. A
  // million candidates is far too many for that, so the row is rewritten with a
  // known salt and hash. This is the test standing in for an inbox, nothing more.
  const crypto = require('crypto');
  const codes = mongoose.connection.db.collection('logincodes');
  const row = await codes.findOne({ email: String(email).toLowerCase() }, { sort: { createdAt: -1 } });
  if (!row) throw new Error(`No sign-in code was issued for ${email} — is that address whitelisted?`);
  if (!row.codeSalt) throw new Error(`${email} got a decoy row — that address has no account`);

  const code = '424242';
  await codes.updateOne({ _id: row._id }, {
    $set: {
      codeHash: crypto.createHmac('sha256', row.codeSalt).update(code).digest('hex'),
      attempts: 0,
      consumedAt: null,
      consumedReason: null,
    },
  });

  const verified = await fetch(base + '/api/auth/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!verified.ok) throw new Error(`verify-code failed (${verified.status}) for ${email}`);

  const cookie = (verified.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('verify-code returned no session cookie');
  return cookie;
}

module.exports = { loginViaOtp };
