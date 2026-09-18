const mongoose = require('mongoose');

// Sessions live in the DB rather than in a signed JWT so they can be revoked
// server-side — "log out everywhere" and "someone else has my cookie" both need
// a server-side kill switch, which a stateless token cannot give.
const sessionSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // The cookie carries the raw token; only its hash is stored, so a dump of this
  // collection cannot be replayed as a login.
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

sessionSchema.index({ tokenHash: 1 }, { unique: true });
// Mongo reaps expired sessions on its own; nothing in the app has to sweep them.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
