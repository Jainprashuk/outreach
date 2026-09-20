/**
 * Issuing and verifying emailed sign-in codes.
 *
 * Two properties drive nearly every decision in here, and both are easy to lose
 * by accident:
 *
 *  1. Requesting a code for an address that has no account must be
 *     indistinguishable from requesting one for an address that does. The old
 *     password endpoint took care to return one message and one status for both
 *     "no such account" and "wrong password"; that property is preserved here.
 *
 *  2. Six digits is only ~20 bits, so the attempt cap is not a nicety, it is the
 *     entire reason a short code is acceptable. Five attempts per code and five
 *     codes per hour bounds an attacker to ~25 guesses an hour against a million
 *     possibilities.
 */
const crypto = require('crypto');
const User = require('../models/User');
const LoginCode = require('../models/LoginCode');
const { sendLoginCode } = require('./emailOtp');

const CODE_TTL_MS = 10 * 60 * 1000;        // how long a code works
const ROW_TTL_MS = 60 * 60 * 1000;         // how long the row survives as a counter
const MAX_ATTEMPTS = 5;                    // verification attempts per code
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
const MAX_CODES_PER_IP_PER_HOUR = 20;
const MAX_LOCKOUTS_PER_EMAIL_PER_HOUR = 3;

// Both paths through requestCode take at least this long, and the path that
// does not call Resend pads to roughly what a send costs. See the note in
// requestCode: this narrows a timing side channel, it does not close it.
const RESPONSE_FLOOR_MS = 450;
const DECOY_DELAY_MS = 400;

// Under a sustained spray, decoy rows are write amplification against a free-tier
// cluster. Past this many rows in five minutes we stop writing them, accepting a
// brief enumeration window while actively under attack — the alternative is
// letting an attacker drive our write load.
const DECOY_CIRCUIT_LIMIT = 500;
const DECOY_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const normaliseEmail = (raw) => String(raw || '').trim().toLowerCase();

/**
 * randomInt, not randomBytes % 1e6: the modulo of a 32-bit value by a million is
 * biased toward low codes, and randomInt rejects out-of-range draws for us.
 */
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const hashCode = (code, salt) =>
  crypto.createHmac('sha256', salt).update(String(code)).digest('hex');

/**
 * The caller's address. Off Vercel, X-Forwarded-For is attacker-controlled, so
 * the per-IP cap is a courtesy that slows down casual spraying — the per-email
 * cap is the one carrying real weight.
 */
function resolveIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || '';
}

/**
 * Issue a code, or convincingly pretend to.
 *
 * Always resolves { ok: true }. Never reports rate limiting, an unknown address,
 * a disabled account or a delivery failure to the caller — each of those would
 * distinguish a real address from an unknown one, which is the single property
 * this endpoint exists to protect. In particular it never answers 429: a 429 for
 * one address beside a 200 for another IS the disclosure, restated.
 */
async function requestCode(req, rawEmail) {
  const startedAt = Date.now();
  const email = normaliseEmail(rawEmail);
  const ip = resolveIp(req);
  const now = new Date();
  const hourAgo = new Date(now - 60 * 60 * 1000);

  // Pad to a constant floor on every return path, so that the cheap suppressed
  // paths (which do no writes and no network I/O) do not stand out from the
  // expensive real one.
  const settle = async () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < RESPONSE_FLOOR_MS) await sleep(RESPONSE_FLOOR_MS - elapsed);
    return { ok: true };
  };

  if (!email || !email.includes('@')) return settle();

  // ── Rate limits, all counted in the database ──────────────────────────────
  // Never a module-level Map: Vercel runs many isolates and recycles them, so an
  // in-memory limiter here would be decorative rather than a limit.
  const [recent, perEmail, perIp, lockouts] = await Promise.all([
    LoginCode.countDocuments({ email, createdAt: { $gt: new Date(now - RESEND_COOLDOWN_MS) } }),
    LoginCode.countDocuments({ email, createdAt: { $gt: hourAgo } }),
    ip ? LoginCode.countDocuments({ requestIp: ip, createdAt: { $gt: hourAgo } }) : Promise.resolve(0),
    LoginCode.countDocuments({ email, consumedReason: 'locked', createdAt: { $gt: hourAgo } }),
  ]);

  const suppressed = recent > 0
    || perEmail >= MAX_CODES_PER_EMAIL_PER_HOUR
    || perIp >= MAX_CODES_PER_IP_PER_HOUR
    || lockouts >= MAX_LOCKOUTS_PER_EMAIL_PER_HOUR;

  if (suppressed) return settle();

  const user = await User.findOne({ email }, { _id: 1, status: 1 }).lean();
  const eligible = !!user && user.status !== 'disabled';

  // Any code already outstanding for this address stops working the moment a new
  // one is requested. The rows stay — they are the counters — only their
  // usefulness ends.
  await LoginCode.updateMany(
    { email, consumedAt: null, validUntil: { $gt: now } },
    { $set: { consumedAt: now, consumedReason: 'superseded' } },
  );

  const validUntil = new Date(now.getTime() + CODE_TTL_MS);
  const expiresAt = new Date(now.getTime() + ROW_TTL_MS);

  if (!eligible) {
    // A decoy. It counts toward every limit above and can never verify, because
    // a null codeHash fails every comparison.
    const flooded = await LoginCode.countDocuments({
      createdAt: { $gt: new Date(now - DECOY_CIRCUIT_WINDOW_MS) },
    });
    if (flooded < DECOY_CIRCUIT_LIMIT) {
      await LoginCode.create({ userId: null, email, codeHash: null, codeSalt: null, requestIp: ip, validUntil, expiresAt });
    }
    await sleep(DECOY_DELAY_MS);
    return settle();
  }

  const code = generateCode();
  const codeSalt = crypto.randomBytes(16).toString('hex');
  const row = await LoginCode.create({
    userId: user._id,
    email,
    codeHash: hashCode(code, codeSalt),
    codeSalt,
    requestIp: ip,
    validUntil,
    expiresAt,
  });

  // Awaited, never fire-and-forget: Vercel freezes the invocation once the
  // response is sent, so an un-awaited send is one that may simply never happen.
  try {
    await sendLoginCode({ to: email, code, ttlMinutes: Math.round(CODE_TTL_MS / 60000) });
  } catch (err) {
    // The row is deliberately NOT removed. Deleting it on a send failure would
    // let someone reset their own rate limit by inducing one. The caller still
    // gets the same answer as everyone else; the failure surfaces to the admin
    // through deliveryError instead.
    await LoginCode.updateOne({ _id: row._id }, { $set: { deliveryError: String(err.message).slice(0, 200) } });
    console.error(`[otp] delivery failed for a sign-in code: ${err.message}`);
  }

  return settle();
}

/**
 * Check a submitted code.
 *
 * Resolves { ok: true, user } or { ok: false }. Every failure — wrong, expired,
 * already used, superseded, locked out, decoy address, unknown address — is the
 * same single outcome, and the route turns it into one message.
 */
async function verifyCode(rawEmail, rawCode) {
  const email = normaliseEmail(rawEmail);
  const code = String(rawCode || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return { ok: false };

  const now = new Date();

  // Increment first, compare second. A crash between the two can only
  // over-count, never under-count, and `attempts: { $lt: MAX }` inside the
  // FILTER is what makes the cap hold under concurrency: two racing requests
  // cannot both find the row sitting at attempt four.
  const row = await LoginCode.findOneAndUpdate(
    { email, consumedAt: null, validUntil: { $gt: now }, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { sort: { createdAt: -1 }, new: true },
  );

  if (!row || !row.codeHash || !row.codeSalt) return { ok: false };

  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashCode(code, row.codeSalt), 'hex');
  const matched = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matched) {
    if (row.attempts >= MAX_ATTEMPTS) {
      // Burn the CODE, not the account. Locking an account on failed attempts
      // would turn a cheap guessing attempt into free denial of service against
      // a real person, and a whitelist-only app has no self-service unlock. The
      // per-hour caps already bound the total guess budget.
      await LoginCode.updateOne({ _id: row._id }, { $set: { consumedAt: new Date(), consumedReason: 'locked' } });
    }
    return { ok: false };
  }

  const user = await User.findById(row.userId);
  // Whitelisted, then disabled, while a code was in flight.
  if (!user || user.status === 'disabled') return { ok: false };

  await LoginCode.updateOne({ _id: row._id }, { $set: { consumedAt: new Date(), consumedReason: 'verified' } });
  return { ok: true, user };
}

module.exports = {
  requestCode,
  verifyCode,
  normaliseEmail,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
};
