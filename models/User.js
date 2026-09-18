const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  lastLoginAt: { type: Date, default: null },
  // SHA-256 of this account's scrape-worker token. The worker on the Mac has no
  // cookie, so it authenticates with a bearer token that identifies WHICH
  // account's runs it is claiming — see lib/workerAuth.js.
  workerTokenHash: { type: String, default: null },
  // SHA-256 of this account's read-only export link token — see lib/shareAuth.js.
  shareTokenHash: { type: String, default: null },
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });
// Sparse: most accounts never register a worker, and several nulls must not
// collide under a unique index.
userSchema.index({ workerTokenHash: 1 }, { unique: true, sparse: true });
userSchema.index({ shareTokenHash: 1 }, { unique: true, sparse: true });

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    ret.hasWorkerToken = !!ret.workerTokenHash;
    delete ret.workerTokenHash;
    ret.hasShareToken = !!ret.shareTokenHash;
    delete ret.shareTokenHash;
    return ret;
  }
});

module.exports = mongoose.model('User', userSchema);
