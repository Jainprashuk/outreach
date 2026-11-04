const crypto = require('crypto');
const Session = require('../models/Session');
const { APP } = require('./apps');

// Per app: Clientline issues clientline_session. Each cookie lives on its own
// app's domain, so signing in to one app does not sign you in to the other.
const COOKIE = `${APP}_session`;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The cookie carries the raw token; only its SHA-256 lands in the database, so a
// dump of the sessions collection cannot be replayed as a login. Plain SHA-256
// rather than scrypt is right here: the token is 256 bits of CSPRNG output, so
// there is no low-entropy guess to slow an attacker down to.
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const readCookie = (req, name) => {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').find(c => c.trim().startsWith(name + '='));
  return hit ? decodeURIComponent(hit.trim().slice(name.length + 1)) : '';
};

async function createSession(userId) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await Session.create({
    userId,
    tokenHash: hashToken(raw),
    app: APP,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return raw;
}

/** The live session for this request, or null. Expiry is enforced in the query
 *  as well as by the TTL index — Mongo's reaper runs about once a minute, so an
 *  expired token would otherwise stay usable for that long. The app is too: the
 *  collection is shared, and a Clientline token pasted into this app's cookie
 *  must not sign anyone in here. */
async function resolveSession(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  return Session.findOne({ tokenHash: hashToken(raw), app: APP, expiresAt: { $gt: new Date() } }).lean();
}

async function destroySession(req) {
  const raw = readCookie(req, COOKIE);
  if (raw) await Session.deleteOne({ tokenHash: hashToken(raw) });
}

/** Revokes a user's sessions — every app's by default (the account is
 *  disabled), or just one app's when only that app's access is taken away. */
const destroyAllForUser = (userId, app = null) => Session.deleteMany(app ? { userId, app } : { userId });

// Secure is gated on VERCEL rather than NODE_ENV on purpose: the committed .env
// sets NODE_ENV=prod, so keying off it would mark the cookie Secure on a local
// http://localhost run and silently break login there.
const setCookieHeader = (raw) =>
  `${COOKIE}=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}` +
  (process.env.VERCEL ? '; Secure' : '');

const clearCookieHeader = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

module.exports = {
  COOKIE, TTL_MS, readCookie,
  createSession, resolveSession, destroySession, destroyAllForUser,
  setCookieHeader, clearCookieHeader,
};
