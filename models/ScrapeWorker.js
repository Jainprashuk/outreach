const mongoose = require('mongoose');

// Singleton heartbeat for the worker process on the Mac. Written on every
// /api/scrapes/claim; read by /api/scrapes/status so the portal can say
// "ready", "your Mac is asleep", or "log back into LinkedIn" *before* you
// trigger a run rather than after one fails.
//
// Its own collection rather than fields on Settings, for the same reason
// JobBoard is: per-poll writes would race the resume Buffer in that singleton.
const scrapeWorkerSchema = new mongoose.Schema({
  lastSeenAt:       { type: Date, default: null },
  host:             { type: String, default: '' },
  chromeUp:         { type: Boolean, default: false },
  linkedinLoggedIn: { type: Boolean, default: false },
  // Parsed from the worker's `pmset -g sched`, so an offline-worker message can
  // name the time the Mac will next wake instead of saying "eventually".
  nextWakeAt:       { type: Date, default: null },
  // The worker's config.json query list, so the portal can offer it without
  // reaching into the scraper repo.
  defaultQueries:   { type: [String], default: [] },
  // Set to now + 7d when a run exits 2 (LinkedIn checkpoint). While this is in
  // the future neither the button nor the schedule may start a run.
  blockedUntil:     { type: Date, default: null },
  blockedReason:    { type: String, default: '' },
}, { timestamps: true });

scrapeWorkerSchema.statics.getSingleton = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

scrapeWorkerSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('ScrapeWorker', scrapeWorkerSchema);
