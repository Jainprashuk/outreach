const mongoose = require('mongoose');

/**
 * Something that went wrong for somebody — a crashed request, a rejected one, a
 * failed send, a scrape that died, a page that broke in the browser. Read only
 * by the admin's Issues tab (routes/admin.js); written only by lib/issues.js.
 *
 * Repeats are folded into one row: the same failure for the same account bumps
 * `count` and `lastSeenAt` on the OPEN row with its fingerprint, instead of
 * adding another. Resolving a row and then seeing the failure again opens a
 * fresh one, so a regression shows up as new rather than hiding in history.
 *
 * Unlike the rest of the admin surface this holds RAW error text — recipient
 * addresses, SMTP replies, stack traces — by the owner's explicit choice
 * (2026-10-08), because counts alone cannot diagnose a failure.
 */
const issueSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  // server: a request that crashed (5xx) · validation: a request that was refused (4xx)
  // job: background work (sends, campaigns, scrapes, mailbox scans, system email)
  // client: the user's browser (a crash, or a request that never reached us)
  source: { type: String, enum: ['server', 'validation', 'job', 'client'], required: true, index: true },
  area: { type: String, required: true },      // 'contacts', 'email', 'scrape', 'browser' …
  kind: { type: String, required: true },      // 'http_500', 'send_failed', 'js_error' …
  message: { type: String, required: true },
  detail: { type: String, default: '' },       // stack trace / full upstream response
  meta: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  fingerprint: { type: String, required: true },
  count: { type: Number, default: 1 },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  resolvedAt: { type: Date, default: null },
});

issueSchema.index({ fingerprint: 1, status: 1 });
issueSchema.index({ status: 1, lastSeenAt: -1 });
// Anything not seen for 90 days ages out, open or not: it has stopped happening.
issueSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

issueSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Issue', issueSchema);
