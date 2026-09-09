const mongoose = require('mongoose');

// One role a company currently lists on a public ATS board.
//
// Deliberately NOT a Lead. A Lead is a person you found and might email; a
// JobPosting is a role a company lists. There is no join key between them —
// postings carry no email, and Lever/Ashby expose no company name to match
// against a Lead's email-domain-inferred company. Merging them would need fuzzy
// name matching, which produces wrong merges and destroys the one property
// tracking must have: trustworthiness. Same vocabulary, same UI grammar, no
// shared rows. Please don't "fix" this.
const jobPostingSchema = new mongoose.Schema({
  // ── identity ───────────────────────────────────────────────────────────────
  source:     { type: String, enum: ['greenhouse', 'lever', 'ashby', 'muse', 'jobicy'], required: true },
  boardToken: { type: String, required: true },
  boardId:    { type: String, default: null },   // JobBoard._id as a string
  sourceId:   { type: String, required: true },  // the board's own id, always stringified
  // Which saved searches surfaced this posting. Only meaningful for 'search'
  // sources, where the same job can be found by several queries and is stored
  // ONCE — the same approach Lead.queries takes for harvester search terms.
  queries:    { type: [String], default: [] },
  // `${source}:${boardToken}:${sourceId}`, precomputed on write so the upsert is
  // one indexed filter — the same trick as Lead.dedupeKey. The token has to be
  // in the key: Greenhouse ids are global ints but Lever/Ashby are UUIDs with no
  // cross-board guarantee, and a role listed on two boards you track is two rows
  // because you track it per board.
  sourceKey:  { type: String, required: true },

  // ── content, normalised across the three board shapes ──────────────────────
  title:      { type: String, required: true },
  company:    { type: String, default: '' },
  department: { type: String, default: '' },
  team:       { type: String, default: '' },
  location:   { type: String, default: '' },     // the one the board calls primary
  locations:  { type: [String], default: [] },   // every distinct one
  remote:     { type: Boolean, default: false }, // convenience flag
  workplaceType:  { type: String, default: '' }, // '' | 'onsite' | 'hybrid' | 'remote'
  employmentType: { type: String, default: '' }, // '' | 'full-time' | 'part-time' | 'contract' | 'intern' | 'temporary'
  country:    { type: String, default: '' },
  url:        { type: String, default: '' },
  applyUrl:   { type: String, default: '' },
  requisitionId: { type: String, default: '' },

  // Only Jobicy publishes pay among the current sources; null everywhere else.
  salaryMin:      { type: Number, default: null },
  salaryMax:      { type: Number, default: null },
  salaryCurrency: { type: String, default: '' },
  salaryPeriod:   { type: String, default: '' },

  // ── what the board says ────────────────────────────────────────────────────
  postedAt:        { type: Date, default: null },
  sourceUpdatedAt: { type: Date, default: null }, // greenhouse only; null elsewhere

  // ── what WE observed ───────────────────────────────────────────────────────
  firstSeenAt: { type: Date, default: Date.now }, // written once, via $setOnInsert
  lastSeenAt:  { type: Date, default: Date.now }, // stamped every run it appears in
  seenCount:   { type: Number, default: 1 },

  // ── lifecycle: the world's state ───────────────────────────────────────────
  listingStatus: { type: String, enum: ['open', 'closed'], default: 'open' },
  closedAt:   { type: Date, default: null },
  reopenedAt: { type: Date, default: null },
  closeCount: { type: Number, default: 0 },

  // ── your tracking: your state ──────────────────────────────────────────────
  // Orthogonal to listingStatus by design — the world changing and you acting
  // are different facts. A job you applied to that then closes keeps 'applied'
  // and gains 'closed', which is arguably the most interesting row on the page.
  // These fields live in $setOnInsert during a sync, so a resync physically
  // cannot overwrite them.
  applyStatus: {
    type: String,
    enum: ['not-applied', 'saved', 'applied', 'in-review', 'interviewing', 'offer', 'rejected', 'skipped'],
    default: 'not-applied',
  },
  appliedAt:  { type: Date, default: null },
  appliedVia: { type: String, default: null },   // which link you actually used
  applyNote:  { type: String, default: '' },
  applyHistory: [{
    status:    { type: String },
    changedAt: { type: Date, default: Date.now },
    note:      { type: String, default: '' },
  }],

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

jobPostingSchema.index({ sourceKey: 1 });                               // the upsert key
jobPostingSchema.index({ source: 1, boardToken: 1, listingStatus: 1 }); // the per-board close scan
jobPostingSchema.index({ listingStatus: 1, postedAt: -1 });             // default list order
jobPostingSchema.index({ firstSeenAt: -1 });                            // "new since last sync"
jobPostingSchema.index({ applyStatus: 1 });
jobPostingSchema.index({ company: 1 });
jobPostingSchema.index({ queries: 1 });

jobPostingSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('JobPosting', jobPostingSchema);
