const mongoose = require('mongoose');

// The campaign's activity log. Two kinds of entry share it: a 'release' (a day's
// batch actually went out) and a 'reconcile' (rows were retired because they were
// already Contacts). Bounded with $slice so it never blows the document up.
const releaseSchema = new mongoose.Schema({
  kind:       { type: String, enum: ['release', 'reconcile'], default: 'release' },
  releasedOn: { type: String, required: true },   // 'YYYY-MM-DD' in IST
  trigger:    { type: String, enum: ['cron', 'manual', 'upload'], default: 'cron' },
  jobId:      { type: String, default: null },
  released:   { type: Number, default: 0 },       // items actually on the SendJob
  skipped:    { type: Number, default: 0 },
  scanned:    { type: Number, default: 0 },       // rows read to find `released` valid ones
  exhausted:  { type: Boolean, default: false },
  error:      { type: String, default: null },
  startedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { _id: false });

const campaignSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  name:        { type: String, required: true },
  fileName:    { type: String, default: '' },
  // ONE template for the whole campaign (Template.key). Not a per-row column.
  templateKey: { type: String, required: true },

  status: {
    type: String,
    enum: ['draft', 'running', 'paused', 'completed', 'failed'],
    default: 'draft',
  },

  // Config
  contactsPerDay: { type: Number, default: 20 },   // N released per IST day
  ratePerHour:    { type: Number, default: 5 },    // -> SendJob.ratePerHour (drip spacing)
  runHourIst:     { type: Number, default: 9 },    // 0-23, Asia/Kolkata
  attachResume:   { type: Boolean, default: false },

  // Metadata only. The CLIENT applied the mapping before uploading (it already
  // holds the parsed grid); this is kept so the Setup tab can show where each
  // field came from. PATCH refuses to change it — rows are already projected.
  columnMap:     { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  sourceColumns: { type: [String], default: [] },
  headerRow:     { type: Number, default: 0 },     // -1 = the sheet had no header row

  // Denormalised counters, maintained with $inc and self-healed by GET /:id,
  // which recomputes them from CampaignRow.
  stats: {
    total:    { type: Number, default: 0 },
    pending:  { type: Number, default: 0 },
    released: { type: Number, default: 0 },
    skipped:  { type: Number, default: 0 },
    removed:  { type: Number, default: 0 },
  },

  // ── Idempotency ──────────────────────────────────────────────────────────
  // A DATE STRING, not a Date. String equality against istDateKey() is the whole
  // double-fire guard: immune to clock skew, to "is 00:05 IST still today", and
  // to a Date round-tripping through BSON millisecond truncation.
  lastReleaseOn: { type: String, default: null },
  lastReleaseAt: { type: Date, default: null },
  lastJobId:     { type: String, default: null },
  lastError:     { type: String, default: null },
  // Advisory lease: stops two runners from releasing the same campaign at once.
  // Held at most LOCK_TTL_MS so a killed invocation self-heals.
  releaseLockAt: { type: Date, default: null },

  releases:    { type: [releaseSchema], default: [] },
  completedAt: { type: Date, default: null },
  pausedAt:    { type: Date, default: null },
  // Set only by lib/userSending.js when an admin paused the whole account, so the
  // admin's resume brings back exactly what it paused. Any resume clears it.
  pausedByAdmin: { type: Boolean, default: false },

  // How it was started, for Analytics: a spreadsheet upload, selected contacts, or
  // the Action Center (⚡) — with which of its actions. Null on campaigns made
  // before this was recorded.
  origin:     { type: String, enum: ['upload', 'contacts', 'action-center', null], default: null },
  actionKind: { type: String, enum: ['followup', 'ready', 'pending', 'leads', 'prospects', null], default: null },

  // Campaign operational updates are mailed back to the sender account. Keeping
  // the first Message-ID lets every update use one Gmail conversation.
  notificationThreadMessageId: { type: String, default: null },
  completionNotifiedAt: { type: Date, default: null },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// The due-campaign scan.
campaignSchema.index({ status: 1, deleted: 1 });
campaignSchema.index({ createdAt: -1 });
// Per-user list index — built on prod by scripts/build-perf-indexes.js.
campaignSchema.index({ userId: 1, createdAt: -1 });

campaignSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Campaign', campaignSchema);
