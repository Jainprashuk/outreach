const mongoose = require('mongoose');

/**
 * Something that happened for a user, shown in the bell at the top right. Unlike
 * the Issues tab (admin diagnostics, raw errors) and the Logs page (an audit
 * trail of every mutation), each row here is written to be READ by its owner:
 * a short title, one line of detail, and where to go next.
 *
 * Written only through lib/notify.js, which never throws — a notification must
 * not be able to break the send or scan that raised it.
 *
 * `dedupeKey` is left UNSET (not null) when there is none. The unique index on it
 * is partial on "is a string": a sparse index would still index an explicit null
 * and cap the collection at one keyless row per user (see the sparse-null trap).
 */
const notificationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, required: true },
  severity:  { type: String, enum: ['success', 'info', 'warning', 'error'], default: 'info' },
  title:     { type: String, required: true },
  body:      { type: String, default: '' },
  // In-app route (e.g. /app/mailbox is served at /app, so this is the router path: /mailbox).
  link:      { type: String, default: '' },
  dedupeKey: { type: String },
  meta:      { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  readAt:    { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
// Kept 30 days — it is a feed, not a record.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('Notification', notificationSchema);
