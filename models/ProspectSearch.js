const mongoose = require('mongoose');

// One "Find people" run for one company. The background function writes its
// progress here step by step, and the Discover tab polls it.
const STEP_KEYS = ['company', 'people-search', 'github', 'website', 'pattern', 'emails'];

const prospectSearchSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  domain:      { type: String, required: true },
  companyName: { type: String, default: '' },
  roles:       { type: [String], default: [] },
  // Re-read GitHub and the website even if they were checked within the month.
  force:       { type: Boolean, default: false },
  status:      { type: String, enum: ['queued', 'running', 'done', 'error'], default: 'queued' },
  steps: [{
    _id: false,
    key:    { type: String, enum: STEP_KEYS },
    status: { type: String, enum: ['pending', 'running', 'done', 'skipped', 'error'], default: 'pending' },
    found:  { type: Number, default: 0 },
    detail: { type: String, default: '' },
    // Facts about the step (what it found, or why it was skipped) for the page to
    // turn into plain sentences. Shape varies per step — see lib/prospectSearch.js.
    info:   { type: mongoose.Schema.Types.Mixed, default: {} },
    at:     { type: Date, default: null },
  }],
  // people, withEmail, added (new this search), and one count per label
  // (high, medium, low, generic, manual, none).
  counts: { type: mongoose.Schema.Types.Mixed, default: () => ({ people: 0, withEmail: 0 }) },
  // Removed from the search history list. The people it found are untouched.
  hidden: { type: Boolean, default: false },
  error:      { type: String, default: null },
  startedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { timestamps: true });

prospectSearchSchema.index({ userId: 1, createdAt: -1 });
prospectSearchSchema.index({ userId: 1, domain: 1, createdAt: -1 });

prospectSearchSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const ProspectSearch = mongoose.model('ProspectSearch', prospectSearchSchema);
ProspectSearch.STEP_KEYS = STEP_KEYS;
module.exports = ProspectSearch;
