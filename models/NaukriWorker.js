const mongoose = require('mongoose');

// Per-user heartbeat for the Naukri worker process on the Mac. Written on every
// /api/naukri/claim; read by /api/naukri/overview so the tab can say "ready",
// "your Mac is asleep", or "log back into Naukri" *before* you trigger a run
// rather than after one fails.
//
// Its own collection rather than a naukriLoggedIn field on ScrapeWorker, for one
// reason that matters: blockedUntil. A Naukri captcha must not be able to stop
// LinkedIn harvesting, and vice versa. Sharing the doc would couple the two
// blocks and make one site's bad day the other's outage.
const naukriWorkerSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  lastSeenAt:      { type: Date, default: null },
  host:            { type: String, default: '' },
  chromeUp:        { type: Boolean, default: false },
  naukriLoggedIn:  { type: Boolean, default: false },
  // Parsed from the worker's `pmset -g sched`, so an offline-worker message can
  // name the time the Mac will next wake instead of saying "eventually".
  nextWakeAt:      { type: Date, default: null },
  // Set to now + 7d when a run exits 2 (Naukri captcha / rate limit). While this
  // is in the future neither the buttons nor the schedule may start a run.
  blockedUntil:    { type: Date, default: null },
  blockedReason:   { type: String, default: '' },
}, { timestamps: true });

naukriWorkerSchema.statics.getForUser = async function (userId) {
  let doc = await this.findOne({ userId });
  if (!doc) doc = await this.create({ userId });
  return doc;
};

naukriWorkerSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('NaukriWorker', naukriWorkerSchema);
