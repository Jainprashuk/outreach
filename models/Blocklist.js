const mongoose = require('mongoose');

const blocklistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  type: { type: String, enum: ['email', 'domain'], required: true },
  value: { type: String, required: true }, // lowercased email address or bare domain (e.g. "acme.com")
  reason: { type: String, default: '' },
}, { timestamps: true });

// The old global unique index on (type, value) is dropped by
// scripts/migrate-multi-tenant.js — one user blocking an address must not stop
// another user from contacting it.
blocklistSchema.index({ userId: 1, type: 1, value: 1 }, { unique: true });

blocklistSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Blocklist', blocklistSchema);
