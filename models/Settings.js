const mongoose = require('mongoose');

const variableSchema = new mongoose.Schema({
  key: { type: String, required: true },
  value: { type: String, default: '' },
}, { _id: false });

const resumeSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  data: { type: Buffer, required: true },
  size: { type: Number, required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

// One record per user.
const settingsSchema = new mongoose.Schema({
  // Indexed by the unique index declared below, not here — declaring both makes
  // mongoose build two indexes on the same key.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  senderName: { type: String, default: 'Your Name' },
  senderCompany: { type: String, default: 'Your Company' },
  gmailEmail: { type: String, default: '' },
  // AES-256-GCM ciphertext, never the password itself — see lib/credentials.js.
  // Stripped in toJSON below so it cannot reach the browser even by accident.
  gmailAppPasswordEnc: { type: String, default: '' },
  customVariables: { type: [variableSchema], default: [] },
  resume: { type: resumeSchema, default: null },
  lastMailboxCheckAt: { type: Date, default: null },

  // ── Job-posting sync (see lib/postingSync.js) ────────────────────────────
  // Scalars, so the singleton is the right home; the boards themselves are a
  // collection because they carry per-board state written on every run.
  lastPostingSyncAt: { type: Date, default: null },
  // Advisory lease. Stops two tabs, or cron plus a click, from syncing at once.
  // Held for at most LOCK_TTL_MS so a killed invocation self-heals.
  postingSyncLockAt: { type: Date, default: null },
  // "What I actually want" — applied when a sync decides what to STORE, so a
  // 600-role board only keeps the roles you'd read. See lib/criteria.js.
  jobCriteria: {
    enabled:    { type: Boolean, default: false },
    include:    { type: [String], default: undefined },
    exclude:    { type: [String], default: undefined },
    locations:  { type: [String], default: undefined },
    remoteOnly: { type: Boolean, default: false },
  },
}, { timestamps: true });

settingsSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // The client only ever needs to know whether one is set, never its value.
    ret.hasGmailAppPassword = !!ret.gmailAppPasswordEnc;
    delete ret.gmailAppPasswordEnc;
    if (ret.resume) {
      ret.resume = {
        filename: ret.resume.filename,
        contentType: ret.resume.contentType,
        size: ret.resume.size,
        uploadedAt: ret.resume.uploadedAt,
      };
    }
    return ret;
  }
});

// One settings document per account. Added late: getForUser used to be a
// read-then-create, so two concurrent first-time requests could each miss and
// each insert. scripts/dedupe-settings.js collapses any existing duplicates and
// MUST have been run against a database before this index can build there.
settingsSchema.index({ userId: 1 }, { unique: true });

settingsSchema.statics.getForUser = async function (userId) {
  try {
    // Upsert rather than find-then-create: the old form raced, and the onboarding
    // wizard mounting several panels at once is exactly the trigger.
    return await this.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    // Two concurrent upserts under the unique index: one inserts, the other gets
    // E11000. The document exists by now, so a plain read is the correct retry.
    if (err && err.code === 11000) return this.findOne({ userId });
    throw err;
  }
};

module.exports = mongoose.model('Settings', settingsSchema);
