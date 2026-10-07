const mongoose = require('mongoose');

/**
 * One row per scheduled endpoint, bumped every time the scheduler actually
 * calls it. GitHub runs scheduled workflows when it has capacity, not on the
 * minute asked for (measured: the 5-minute mailbox cron fires ~6 times a day),
 * so "is it running and how often" can only be answered by recording it.
 * Read by the admin's Sending tab.
 */
const cronBeatSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },   // the request path
  lastAt: { type: Date, default: null },
  lastStatus: { type: Number, default: null },
  lastMs: { type: Number, default: null },
  lastSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  lastOkAt: { type: Date, default: null },
  // The most recent fire times, newest last — enough for "how many in 24h".
  recent: { type: [Date], default: [] },
});

module.exports = mongoose.model('CronBeat', cronBeatSchema);
