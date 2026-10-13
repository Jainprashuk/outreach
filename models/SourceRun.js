const mongoose = require('mongoose');

// One run of an automatic Leads source (hiring posts / HN): what it searched, what
// it found, what it cost. Feeds the "last run" line on the Leads page, and a
// `running` row stops the same source starting twice for one user.
const sourceRunSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source:  { type: String, enum: ['web', 'hn'], required: true },
  trigger: { type: String, enum: ['cron', 'manual'], default: 'cron' },
  status:  { type: String, enum: ['running', 'done', 'failed'], default: 'running' },
  startedAt:  { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },

  label:   { type: String, default: '' },   // e.g. the HN thread title
  queries: { type: [String], default: [] }, // web: the searches made
  credits: { type: Number, default: 0 },    // web: Tavily/SerpApi credits spent

  read:       { type: Number, default: 0 }, // posts / results looked at
  withEmail:  { type: Number, default: 0 }, // of those, with at least one email
  matched:    { type: Number, default: 0 }, // not rejected by your target
  created:    { type: Number, default: 0 }, // new rows on the Leads board
  duplicates: { type: Number, default: 0 }, // already on the board
  rejected:   { type: Number, default: 0 }, // seeker / not hiring / wrong place

  error: { type: String, default: null },
}, { timestamps: true });

sourceRunSchema.index({ userId: 1, source: 1, startedAt: -1 });

// A run that died mid-way (a Vercel timeout, a deploy) must not block the source
// forever: `running` older than this counts as dead.
sourceRunSchema.statics.STALE_MS = 30 * 60 * 1000;

module.exports = mongoose.model('SourceRun', sourceRunSchema);
