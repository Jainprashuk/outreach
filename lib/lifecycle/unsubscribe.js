/**
 * Signed one-click unsubscribe links.
 *
 * The token names an account and ONE preference ('reminders' or
 * 'weekly-report'), and is an HMAC over both, so it cannot be edited into
 * someone else's id or a different preference. It deliberately never expires:
 * an unsubscribe link in a six-month-old email still has to work.
 *
 * The key is derived from CREDENTIAL_KEY, which every deployment already needs,
 * rather than adding one more secret to keep in step.
 */
const crypto = require('crypto');
const { isPref } = require('./types');

const secret = () => {
  const base = process.env.LIFECYCLE_SECRET || process.env.CREDENTIAL_KEY || '';
  return base ? crypto.createHash('sha256').update(`lifecycle-unsubscribe:${base}`).digest() : null;
};

const sign = (payload, key) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

const isConfigured = () => !!secret();

function makeToken(userId, pref) {
  const key = secret();
  if (!key || !isPref(pref)) return null;
  const payload = `${String(userId)}.${pref}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload, key)}`;
}

/** Returns { userId, pref } or null. Constant-time on the signature. */
function readToken(token) {
  const key = secret();
  if (!key || typeof token !== 'string') return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch (_) { return null; }
  const expected = sign(payload, key);
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const [userId, pref] = payload.split('.');
  if (!/^[a-f0-9]{24}$/.test(userId || '') || !isPref(pref)) return null;
  return { userId, pref };
}

const appUrl = () => String(process.env.OUTREACH_URL || '').replace(/\/+$/, '');

const unsubscribeUrl = (userId, pref) => {
  const t = makeToken(userId, pref);
  return t && appUrl() ? `${appUrl()}/api/email/unsubscribe?t=${encodeURIComponent(t)}` : null;
};

module.exports = { makeToken, readToken, unsubscribeUrl, appUrl, isConfigured };
