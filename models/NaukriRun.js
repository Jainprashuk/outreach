const mongoose = require('mongoose');

// One unit of Naukri work. Created queued by the portal (manual) or materialised
// from the schedule when the worker polls, then claimed and executed by
// worker/naukri-worker.js on the Mac. Like a scrape, this cannot run on Vercel:
// it needs a real logged-in Chrome.
//
// Three kinds, deliberately one model rather than three:
//   refresh — re-save the profile so recruiter search ranks you
//   harvest — collect listings into NaukriJob as `pending`
//   apply   — act on jobs YOU approved, and only those
const naukriRunSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  kind:    { type: String, enum: ['refresh', 'harvest', 'apply', 'probe'], required: true },
  status:  { type: String, enum: ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'], default: 'queued' },
  trigger: { type: String, enum: ['manual', 'scheduled'], default: 'manual' },

  claimedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  workerHost: { type: String, default: '' },

  // Snapshot of safety.dryRun at claim time, so a config change mid-run cannot
  // turn a rehearsal into a real application.
  dryRun: { type: Boolean, default: false },

  // Live progress, overwritten throughout the run so the panel shows which page
  // or job is being worked rather than a spinner. `found === 0` on a harvest is
  // the dark-wake signal — see the worker's zero-render check.
  progress: {
    phase:      { type: String, default: '' },   // 'searching' | 'applying' | …
    label:      { type: String, default: '' },   // current search, or job title
    page:       { type: Number, default: 0 },
    pagesTotal: { type: Number, default: 0 },
    found:      { type: Number, default: 0 },
    new:        { type: Number, default: 0 },
    applied:    { type: Number, default: 0 },
    skipped:    { type: Number, default: 0 },
    failed:     { type: Number, default: 0 },
    updatedAt:  { type: Date, default: null },
  },

  // Written once at the end.
  stats: {
    found:    { type: Number, default: 0 },
    new:      { type: Number, default: 0 },
    updated:  { type: Number, default: 0 },
    applied:  { type: Number, default: 0 },
    skipped:  { type: Number, default: 0 },
    failed:   { type: Number, default: 0 },
    // Dry-run only, and deliberately its own field: folding rehearsals into
    // `applied` would make the history claim work that never happened.
    rehearsed: { type: Number, default: 0 },
    searches: { type: Number, default: 0 },
  },

  // Per-job outcomes for an apply run. This is the audit trail: what the worker
  // did, to which job, and why it stopped if it did.
  results: {
    type: [{
      _id:     false,
      jobId:   { type: mongoose.Schema.Types.ObjectId, ref: 'NaukriJob' },
      title:   String,
      company: String,
      outcome: { type: String, enum: ['applied', 'skipped', 'failed', 'dry-run'] },
      reason:  String,
      at:      { type: Date, default: Date.now },
    }],
    default: [],
  },

  error:    { type: String, default: null },
  // 2 means Naukri showed a captcha / rate-limit interstitial. Hard stop: the
  // server blocks the account for 7 days on /finish, and the worker exits.
  exitCode: { type: Number, default: null },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// /claim does findOneAndUpdate({userId, status:'queued'}, …, {sort:{createdAt:1}})
// on every worker poll, so keep it indexed.
naukriRunSchema.index({ userId: 1, status: 1, createdAt: 1 });
naukriRunSchema.index({ userId: 1, createdAt: -1 });

naukriRunSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('NaukriRun', naukriRunSchema);
