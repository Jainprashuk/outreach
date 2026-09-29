const mongoose = require('mongoose');

// App-wide switches that an admin flips at runtime, one document per `key`.
//
// Only one key exists today ('lifecycle'). THE ABSENCE OF THE DOCUMENT MEANS
// "EVERYTHING OFF": a database that has never had the admin panel opened — prod
// on the day this ships — sends no lifecycle email at all. Nothing may treat a
// missing row as a default-on, which is why lib/lifecycle/config.js reads it
// with .lean() and fills the blanks with explicit falses rather than relying on
// schema defaults.
const changeSchema = new mongoose.Schema({
  field:   { type: String, required: true },
  value:   { type: mongoose.Schema.Types.Mixed },
  by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byEmail: { type: String, default: '' },
  at:      { type: Date, default: Date.now },
}, { _id: false });

const appConfigSchema = new mongoose.Schema({
  key: { type: String, required: true },
  lifecycle: {
    enabled:  { type: Boolean, default: false },
    // First time the master switch went on. The inactivity clock starts here,
    // because nobody's last visit was recorded before this feature existed.
    firstEnabledAt: { type: Date, default: null },
    // "Send only to me": while on, only testRecipient's own emails are sent;
    // everyone else's are recorded as skipped. Starts ON, so the first thing the
    // master switch does is mail the admin rather than anybody else.
    testMode: { type: Boolean, default: true },
    testRecipient: { type: String, default: '' },
    // Per email type. Opt-in: only an explicit `true` is on; missing = off.
    types: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  changes: { type: [changeSchema], default: [] },
}, { timestamps: true });

appConfigSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('AppConfig', appConfigSchema);
