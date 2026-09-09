const mongoose = require('mongoose');

// One public ATS job board you track, identified by its source and its slug
// (`greenhouse` + `stripe`). Carries the per-board sync bookkeeping, which is
// written on every run — hence a collection rather than a Settings subdocument:
// the Settings singleton holds a resume Buffer, and a sync racing a settings
// save would clobber it.
const jobBoardSchema = new mongoose.Schema({
  source: { type: String, enum: ['greenhouse', 'lever', 'ashby', 'muse', 'jobicy'], required: true },
  // For a company board this is the ATS slug. For a 'search' source it is just a
  // name for the saved search — the real parameters live in `query` below.
  token:  { type: String, required: true },   // stored lowercased + trimmed
  // Search parameters. Empty for company boards. Kept loose (a small fixed set
  // of optional strings) because each search source has its own vocabulary,
  // validated by its adapter.
  query: {
    category: { type: String, default: '' },   // muse
    company:  { type: String, default: '' },   // muse — scope to one employer
    industry: { type: String, default: '' },   // jobicy
    level:    { type: String, default: '' },   // both
    location: { type: String, default: '' },   // muse
    geo:      { type: String, default: '' },   // jobicy
    tag:      { type: String, default: '' },   // jobicy
  },
  // Display name. For lever/ashby this IS the company — neither exposes one, so
  // there is nothing else to show or to stamp onto their postings.
  label:   { type: String, default: '' },
  enabled: { type: Boolean, default: true },

  // Per-board sync outcome. One board's failure is never global, so this is
  // recorded per board rather than as a single run status.
  lastSyncAt:    { type: Date, default: null },  // last time we TALKED to it, any outcome
  lastSuccessAt: { type: Date, default: null },  // last time we got a usable posting set
  // Set ONCE, on first success. Lets the UI show a board's initial 619 postings
  // as "imported with the board" rather than 619 things that are new to the
  // world — otherwise the New tab drowns on the one run you most want to read.
  firstSyncAt:   { type: Date, default: null },
  lastSyncStatus: {
    type: String,
    enum: ['never', 'ok', 'empty', 'not-found', 'error', 'skipped'],
    default: 'never',
  },
  lastError:      { type: String, default: '' },
  lastHttpStatus: { type: Number, default: null },
  lastPostingCount: { type: Number, default: 0 },
  lastNewCount:     { type: Number, default: 0 },
  lastClosedCount:  { type: Number, default: 0 },
  consecutiveFailures: { type: Number, default: 0 },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// Non-unique, matching every other model here: this app soft-deletes, and a
// unique index would forbid re-adding a board you removed. Duplicate boards are
// prevented in routes/postings.js, which revives a soft-deleted match instead of
// inserting a second row.
jobBoardSchema.index({ source: 1, token: 1 });
jobBoardSchema.index({ enabled: 1, source: 1 });

jobBoardSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('JobBoard', jobBoardSchema);
