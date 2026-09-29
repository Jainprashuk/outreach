const mongoose = require('mongoose');

// One row per lifecycle email SLOT, not per attempt: (userId, type, key) is
// unique, and the row is inserted BEFORE anything is sent. Whoever wins the
// insert sends; a retry, a second cron fire or an overlapping instance loses the
// race and does nothing. That is what "never duplicated" rests on.
//
// A skipped slot is kept too. It is how "turning a switch back on does not catch
// up" works: a setup reminder that fell due while reminders were off has a
// 'skipped' row, so it is never sent late.
//
// `key` shapes:
//   welcome          'welcome'
//   setup-reminder   'setup-reminder'
//   inactive         'inactive:<ISO of the activity that began the quiet spell>'
//   weekly-report    'week:<YYYY-MM-DD of the Monday>'
//   manual-report    'manual:<epoch ms>' — every click is its own slot
const lifecycleEmailSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:   { type: String, required: true },
  key:    { type: String, required: true },
  status: { type: String, enum: ['claimed', 'sent', 'skipped', 'failed'], default: 'claimed' },
  // Why a slot was skipped: 'type-off', 'user-blocked', 'opted-out', 'quiet', …
  reason: { type: String, default: null },
  // Where it actually went. Differs from the user's address in test mode.
  to:     { type: String, default: '' },
  testMode:   { type: Boolean, default: false },
  providerId: { type: String, default: null },
  error:      { type: String, default: null },
  attempts:   { type: Number, default: 0 },
  sentAt:     { type: Date, default: null },
}, { timestamps: true });

lifecycleEmailSchema.index({ userId: 1, type: 1, key: 1 }, { unique: true });
lifecycleEmailSchema.index({ createdAt: -1 });

module.exports = mongoose.model('LifecycleEmail', lifecycleEmailSchema);
