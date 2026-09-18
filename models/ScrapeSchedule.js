const mongoose = require('mongoose');

// Singleton. When a worker polls, the server checks whether an occurrence is
// due and materialises a ScrapeRun for it — see lib/scrapeSchedule.js. There is
// deliberately no sub-daily frequency: the harvest caps in scroll_harvest.py
// assume roughly one attended run a day, and over-running is what gets a
// LinkedIn account restricted.
const scrapeScheduleSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  enabled:  { type: Boolean, default: false },
  // 0 = Sunday .. 6 = Saturday
  days:     { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
  time:     { type: String, default: '09:30' },   // 'HH:mm', wall clock in `timezone`
  timezone: { type: String, default: 'Asia/Kolkata' },
  queries:  { type: [String], default: [] },
  // A Mac opened on Thursday must not fire Monday's missed run.
  catchUpHours: { type: Number, default: 6 },
  // Set to the occurrence itself, never to now, so a late catch-up doesn't
  // drag the next occurrence forward.
  lastFiredAt:  { type: Date, default: null },
}, { timestamps: true });

scrapeScheduleSchema.statics.getSingleton = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

scrapeScheduleSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('ScrapeSchedule', scrapeScheduleSchema);
