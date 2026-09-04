const mongoose = require('mongoose');

// A Lead is ONE (author, email) pair staged for review, exploded from an external
// harvester JSON dump. A source lead with 20 emails becomes 20 Lead docs; one with
// no emails becomes a single doc with email: null. Leads are intentionally
// unrelated to Contact until promoted via POST /api/leads/move-to-outreach.
const leadSchema = new mongoose.Schema({
  authorName: { type: String, required: true },  // author_name (sometimes junk marketing text)
  authorUrl:  { type: String, default: null },
  email:      { type: String, default: null },   // ONE email, lowercased; null when the source had none
  company:    { type: String, default: '' },     // null in every source row so far; filled on promote
  role:       { type: String, default: '' },     // never in the source; filled on promote
  fitScore:   { type: Number, default: 0 },      // -999 = hard reject
  hiring:     { type: Boolean, default: false },
  links:      { type: [String], default: [] },
  postUrl:    { type: String, default: null },
  source:     { type: String, default: '' },
  // Every search query that surfaced this lead. An array because the same
  // address legitimately turns up under several searches, and collapsing that
  // to one would misattribute which search actually works.
  queries:    { type: [String], default: [] },

  // Identity used for dedupe, precomputed on insert so the import check is one
  // indexed $in instead of an $or across three fields. `e:<email>` when there is
  // an email, otherwise `a:<author_url>` and finally `n:<author_name>`.
  dedupeKey:  { type: String, required: true },

  status:     { type: String, enum: ['new', 'added-to-outreach'], default: 'new' },

  // A second, independent journey: some leads have no email but a real
  // application link, so the only way in is to apply directly. That progress is
  // manual — nothing can observe it the way IMAP observes replies.
  applyStatus: {
    type: String,
    enum: ['not-applied', 'applied', 'in-review', 'interviewing', 'offer', 'rejected', 'skipped'],
    default: 'not-applied',
  },
  appliedAt:   { type: Date, default: null },
  applyUrl:    { type: String, default: null },  // which of the links you used
  applyNote:   { type: String, default: '' },
  applyHistory: [{
    status:    { type: String },
    changedAt: { type: Date, default: Date.now },
    note:      { type: String, default: '' },
  }],
  contactId:  { type: String, default: null },   // Contact._id stamped on promote
  promotedAt: { type: Date, default: null },
  batchUpdatedAt: { type: Date, default: null }, // the file's own updated_at, for provenance

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// Default list order: best fit first, so hard rejects sink to the bottom.
leadSchema.index({ fitScore: -1, createdAt: -1 });
leadSchema.index({ status: 1, fitScore: -1 });
leadSchema.index({ dedupeKey: 1 });
leadSchema.index({ email: 1 });
leadSchema.index({ queries: 1 });
leadSchema.index({ applyStatus: 1 });

leadSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Lead', leadSchema);
