const mongoose = require('mongoose');

// One LinkedIn harvest. Created queued by the portal (manual) or materialised
// from the schedule when a worker polls, then claimed and executed by the
// worker on Prashuk's Mac — the harvest cannot run on Vercel, see worker/README.
const scrapeRunSchema = new mongoose.Schema({
  status:  { type: String, enum: ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'], default: 'queued' },
  trigger: { type: String, enum: ['manual', 'scheduled'], default: 'manual' },
  // Capped at MAX_SEARCHES (20) in scroll_harvest.py. The cap is deliberate.
  queries: { type: [String], default: [] },

  claimedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  workerHost: { type: String, default: '' },

  // What `jl harvest` reported. rendered === 0 means the page never painted
  // (a dark wake, or LinkedIn changed their DOM) — treated as a failure, not
  // as "no new leads".
  stats: {
    rendered: { type: Number, default: 0 },
    hiring:   { type: Number, default: 0 },
    new:      { type: Number, default: 0 },
    seen:     { type: Number, default: 0 },
    searches: { type: Number, default: 0 },
  },

  // Accumulated across the worker's chunked /ingest calls.
  importResult: {
    created:        { type: Number, default: 0 },
    skipped:        { type: Number, default: 0 },
    updated:        { type: Number, default: 0 },
    skippedInBatch: { type: Number, default: 0 },
  },

  error:    { type: String, default: null },
  // 2 means LinkedIn showed a checkpoint/captcha. That is a hard stop.
  exitCode: { type: Number, default: null },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// /claim does findOneAndUpdate({status:'queued'}, …, {sort:{createdAt:1}}) on
// every worker poll, so keep it indexed.
scrapeRunSchema.index({ status: 1, createdAt: 1 });
scrapeRunSchema.index({ createdAt: -1 });

scrapeRunSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('ScrapeRun', scrapeRunSchema);
