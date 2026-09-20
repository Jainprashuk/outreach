const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  // Legacy. Sign-in is an emailed one-time code now (lib/loginCode.js); nothing
  // reads this any more. No longer required, because an invited account never
  // has one. Dropped for good by scripts/migrate-otp-auth.js --drop-passwords,
  // deliberately a later run so the OTP deploy stays reversible.
  passwordHash: { type: String, default: null },
  name: { type: String, default: '' },
  lastLoginAt: { type: Date, default: null },

  // Two tiers, not a role system: everyone, and the person who can see the
  // per-account totals. An enum here would invite a third tier nobody has
  // designed for.
  //
  // Backfilled explicitly by scripts/migrate-otp-auth.js rather than left to
  // this default. `.lean()` reads never apply schema defaults, so a row written
  // before this field existed reads back as `undefined` — which is why every
  // check must be `isAdmin === true`, never `isAdmin !== false`.
  isAdmin: { type: Boolean, default: false },

  // invited  — an admin whitelisted the address; has never signed in
  // active   — has completed at least one sign-in
  // disabled — access revoked, data kept
  //
  // This replaces passwordHash's old implicit role as the "is this account
  // usable" bit, and gives revocation somewhere to live that isn't deleting the
  // row — which would orphan documents across sixteen collections.
  status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited', index: true },
  invitedAt: { type: Date, default: null },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // First-run setup state. Kept on User rather than Settings for three reasons:
  // Settings is the document with the duplicate hazard, /api/share/session
  // already loads a User so the gate costs no extra round trip, and only an
  // explicit stamp survives the user later deleting every template.
  onboarding: {
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    step: { type: Number, default: 0 },
    skipped: { type: [String], default: [] },
    // Bump ONBOARDING_VERSION to make an existing account re-run a future wizard.
    version: { type: Number, default: 0 },
  },
  // SHA-256 of this account's scrape-worker token. The worker on the Mac has no
  // cookie, so it authenticates with a bearer token that identifies WHICH
  // account's runs it is claiming — see lib/workerAuth.js.
  workerTokenHash: { type: String, default: null },
  // SHA-256 of this account's read-only export link token — see lib/shareAuth.js.
  shareTokenHash: { type: String, default: null },
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });
// Partial, NOT sparse. These fields default to null, which means they are
// PRESENT on every account that has not registered a token — and a sparse index
// only skips documents where the field is ABSENT. So under `sparse` the nulls
// were all indexed, collided with each other, and the second tokenless account
// could not be created at all. Filtering on $type: 'string' indexes real tokens
// only, which is what sparse was reaching for.
//
// scripts/migrate-otp-auth.js drops the old sparse indexes: mongoose builds
// these but never removes a superseded one.
userSchema.index(
  { workerTokenHash: 1 },
  { unique: true, partialFilterExpression: { workerTokenHash: { $type: 'string' } } },
);
userSchema.index(
  { shareTokenHash: 1 },
  { unique: true, partialFilterExpression: { shareTokenHash: { $type: 'string' } } },
);

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
