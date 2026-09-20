const mongoose = require('mongoose');

/**
 * One issued (or deliberately faked) sign-in code.
 *
 * Unlike every other secret in this codebase, a code is NOT looked up by its
 * hash. Session tokens (lib/session.js) and account tokens (lib/accountToken.js)
 * are 32 bytes, so a global lookup by hash is safe: guessing one is impossible.
 * Six digits is a million possibilities. A global lookup by hash would let
 * someone submit 402913 and be signed in as whoever happens to hold that code
 * right now — an attack that gets EASIER with every extra user. So verification
 * always resolves the newest live row for the submitted address first, and only
 * then compares. There is deliberately no index on codeHash.
 */
const loginCodeSchema = new mongoose.Schema({
  // Null on a decoy row — a request for an address with no account. Those rows
  // exist so the rate-limit counters below behave identically for real and
  // unknown addresses; without them "you can spray this address but not that
  // one" is itself a way to discover which addresses have accounts.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email: { type: String, required: true, lowercase: true, trim: true },

  // HMAC-SHA256(code, codeSalt). Null on a decoy row, which is what makes such a
  // row structurally unable to verify.
  //
  // Salted per row. A six-digit space is a million preimages, which no hash
  // makes expensive — the salt only prevents ONE precomputed table covering
  // every row at once. The real defences are validUntil and the attempt cap.
  codeHash: { type: String, default: null },
  codeSalt: { type: String, default: null },

  attempts: { type: Number, default: 0 },
  consumedAt: { type: Date, default: null },
  consumedReason: { type: String, enum: ['verified', 'superseded', 'locked', null], default: null },

  requestIp: { type: String, default: '' },
  // Set when Resend refused or timed out. The row is NOT deleted on a delivery
  // failure: removing it would hand an attacker a free rate-limit reset.
  deliveryError: { type: String, default: null },

  // Two clocks on purpose. validUntil is how long the CODE works; expiresAt is
  // how long the ROW is kept, which is longer, because the rows ARE the
  // rate-limit counters. Reaping at validUntil would reset every counter every
  // ten minutes and make the caps meaningless.
  validUntil: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Verification and the per-address caps both want the newest rows for an address.
loginCodeSchema.index({ email: 1, createdAt: -1 });
loginCodeSchema.index({ requestIp: 1, createdAt: -1 });
// Mongo reaps the row itself once it is no longer useful as a counter.
loginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoginCode', loginCodeSchema);
