const mongoose = require('mongoose');

// Unmapped columns kept as an ARRAY of {k,v}, not a Map/object. Excel headers are
// arbitrary user text — "Rate ($)", "Dept.Name", "$notes" — and dots and leading
// $ in BSON field names are a minefield. An array sidesteps it entirely and costs
// nothing, since these are only ever read for display.
const extraSchema = new mongoose.Schema({
  k: { type: String, required: true },
  v: { type: String, default: '' },
}, { _id: false });

const campaignRowSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },

  // Position in the sheet. THE release order — "N per day, top down" is literally
  // sort({rowIndex:1}). Also the idempotency key for a retried upload chunk.
  rowIndex:  { type: Number, required: true },
  sourceRow: { type: Number, default: 0 },   // 1-based row in the original file

  name:    { type: String, default: '' },
  email:   { type: String, default: '' },    // lowercased, trimmed
  company: { type: String, default: '' },
  role:    { type: String, default: '' },
  extras:  { type: [extraSchema], default: [] },

  status: {
    // pending  -> not yet considered
    // queued   -> claimed by an in-flight release (transient, seconds)
    // released -> a Contact exists and it is on a SendJob
    // skipped  -> invalid email / duplicate / dropped by the runner
    // removed  -> the user pulled it out of the upcoming batch
    type: String,
    enum: ['pending', 'queued', 'released', 'skipped', 'removed'],
    default: 'pending',
  },
  // 'blank_email'|'invalid_email'|'duplicate_in_file'|'duplicate_contact'
  // |'removed_by_user'|'queue_failed'|'render_empty'
  skipReason: { type: String, default: null },

  contactId:  { type: String, default: null },   // String, matching SendJob.items.contactId
  jobId:      { type: String, default: null },
  releaseId:  { type: String, default: null },   // groups one day's claim; crash recovery
  claimedAt:  { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  releasedOn: { type: String, default: null },   // 'YYYY-MM-DD' IST
}, { timestamps: true });

// THE index. Serves the release scan, the preview, and the detail table.
campaignRowSchema.index({ campaignId: 1, status: 1, rowIndex: 1 });
// Makes a retried upload chunk a no-op instead of a duplicate, with
// insertMany({ordered:false}) + E11000 swallowed.
campaignRowSchema.index({ campaignId: 1, rowIndex: 1 }, { unique: true });
campaignRowSchema.index({ campaignId: 1, email: 1 });
campaignRowSchema.index({ releaseId: 1 }, { sparse: true });

campaignRowSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('CampaignRow', campaignRowSchema);
