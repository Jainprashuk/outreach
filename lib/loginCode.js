/**
 * Issuing and verifying emailed sign-in codes.
 *
 * Two things worth knowing before changing anything here:
 *
 *  1. REQUESTING a code tells the caller whether the address has an account.
 *     That is a deliberate reversal of the original design, which answered
 *     identically either way to stop anyone harvesting which addresses are
 *     registered. It was traded for a usable dead end: sign-in is whitelist-only,
 *     so somebody not on the list would otherwise sit at a code screen forever
 *     waiting for mail that is never coming. They are now told, and offered the
 *     access request in models/AccessRequest.js.
 *
 *     VERIFYING a code has NOT been loosened — it still answers with one message
 *     for every failure. Do not "improve" it to match; a wrong-code response
 *     that differs from an expired-code response hands an attacker a progress
 *     meter.
 *
 *  2. Six digits is only ~20 bits, so the attempt cap is not a nicety, it is the
 *     entire reason a short code is acceptable. Five attempts per code and five
 *     codes per hour bounds an attacker to ~25 guesses an hour against a million
 *     possibilities.
 */
const crypto = require('crypto');
const User = require('../models/User');
const AccessRequest = require('../models/AccessRequest');
const LoginCode = require('../models/LoginCode');
const { sendLoginCode } = require('./emailOtp');

const CODE_TTL_MS = 10 * 60 * 1000;        // how long a code works
const ROW_TTL_MS = 60 * 60 * 1000;         // how long the row survives as a counter
const MAX_ATTEMPTS = 5;                    // verification attempts per code
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
const MAX_CODES_PER_IP_PER_HOUR = 20;
const MAX_LOCKOUTS_PER_EMAIL_PER_HOUR = 3;

// A floor on how fast this endpoint can answer. It no longer hides WHETHER an
// address is registered — the outcome says that outright — but it still keeps
// the endpoint from being a fast oracle for anything else, and drags bulk
// enumeration down to roughly two addresses a second per connection.
const RESPONSE_FLOOR_MS = 450;

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
 * Issue a sign-in code.
 *
 * Resolves an outcome the route turns into a response:
 *   sent         — a code is on its way
 *   throttled    — asked too recently or too often; nothing was sent
 *   unknown      — no account, and no access request on file
 *   requested    — no account, but they have already asked for access
 *   rejected     — their access request was declined
 *   disabled     — the account exists but access was revoked
 *   invalid      — not an email address
 *
 * A delivery failure still resolves as `sent`: the row records it, the admin
 * sees it in otp-health, and the person is told to check their mail either way
 * — "we could not email you" is not something they can act on.
 */
async function requestCode(req, rawEmail) {
  const startedAt = Date.now();
  const email = normaliseEmail(rawEmail);
  const ip = resolveIp(req);
  const now = new Date();
  const hourAgo = new Date(now - 60 * 60 * 1000);

  // Kept even though the outcomes now differ: it stops the endpoint becoming a
  // fast oracle for anything the outcome does NOT already say out loud, and it
  // costs nothing.
  const settle = async (outcome) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < RESPONSE_FLOOR_MS) await sleep(RESPONSE_FLOOR_MS - elapsed);
    return outcome;
  };

  if (!email || !email.includes('@')) return settle({ outcome: 'invalid' });

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

  const user = await User.findOne({ email }, { _id: 1, status: 1 }).lean();

  // Answered BEFORE the throttle check, and deliberately so: someone who is not
  // registered should be told that immediately rather than being throttled into
  // the same dead end the access request exists to avoid. Nothing is sent and no
  // row is written on these paths, so they cost nothing to serve.
  if (!user) {
    const existing = await AccessRequest.findOne({ email }, { status: 1 }).lean();
    if (existing && existing.status === 'pending') return settle({ outcome: 'requested' });
    if (existing && existing.status === 'rejected') return settle({ outcome: 'rejected' });
    return settle({ outcome: 'unknown' });
  }
  if (user.status === 'disabled') return settle({ outcome: 'disabled' });

  if (suppressed) return settle({ outcome: 'throttled' });

  // Any code already outstanding for this address stops working the moment a new
  // one is requested. The rows stay — they are the counters — only their
  // usefulness ends.
  await LoginCode.updateMany(
    { email, consumedAt: null, validUntil: { $gt: now } },
    { $set: { consumedAt: now, consumedReason: 'superseded' } },
  );

  const validUntil = new Date(now.getTime() + CODE_TTL_MS);
  const expiresAt = new Date(now.getTime() + ROW_TTL_MS);

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

  return settle({ outcome: 'sent' });
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

// A request form open to the public is a spam target, so it is capped harder
// than anything else here. Per address it is effectively "ask again and we note
// it"; per IP it is a hard stop.
const MAX_REQUESTS_PER_IP_PER_DAY = 10;

/**
 * Record somebody asking for access.
 *
 * Resolves one of:
 *   created   — a new request is in the queue
 *   updated   — they had already asked; the count and note were refreshed
 *   pending   — already queued, nothing changed
 *   rejected  — previously declined, and re-asking does not reopen it
 *   exists    — they already have an account and should just sign in
 *   throttled — too many requests from this address today
 *   invalid   — not an email address
 *
 * Re-asking after a rejection deliberately does NOT move the row back to
 * pending: otherwise "no" is only ever temporary and the admin gets to decline
 * the same person indefinitely.
 */
async function requestAccess(req, rawEmail, rawName, rawNote) {
  const email = normaliseEmail(rawEmail);
  if (!email || !email.includes('@')) return { outcome: 'invalid' };

  const name = String(rawName || '').trim().slice(0, 120);
  const note = String(rawNote || '').trim().slice(0, 500);
  const ip = resolveIp(req);

  const user = await User.findOne({ email }, { _id: 1 }).lean();
  if (user) return { outcome: 'exists' };

  const existing = await AccessRequest.findOne({ email });
  if (existing) {
    if (existing.status === 'rejected') return { outcome: 'rejected' };
    if (existing.status === 'approved') return { outcome: 'exists' };
    await AccessRequest.updateOne({ _id: existing._id }, {
      $inc: { requestCount: 1 },
      $set: {
        lastRequestedAt: new Date(),
        ...(name ? { name } : {}),
        ...(note ? { note } : {}),
      },
    });
    return { outcome: name || note ? 'updated' : 'pending' };
  }

  if (ip) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fromIp = await AccessRequest.countDocuments({ requestIp: ip, createdAt: { $gt: dayAgo } });
    if (fromIp >= MAX_REQUESTS_PER_IP_PER_DAY) return { outcome: 'throttled' };
  }

  try {
    await AccessRequest.create({ email, name, note, requestIp: ip, status: 'pending' });
    return { outcome: 'created' };
  } catch (err) {
    // Two requests for the same address at once; the unique index caught the
    // second. The row exists either way, which is all the caller needs.
    if (err && err.code === 11000) return { outcome: 'pending' };
    throw err;
  }
}

module.exports = {
  requestCode,
  requestAccess,
  verifyCode,
  normaliseEmail,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
};
