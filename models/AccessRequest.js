const mongoose = require('mongoose');

/**
 * Somebody asking to be let in.
 *
 * Sign-in is whitelist-only, so without this an unregistered person has nowhere
 * to go: the login page tells them they have no account and that is the end of
 * the conversation. This gives them a way to ask, and the admin a queue to work
 * through.
 *
 * One row per address, reused rather than duplicated — asking twice updates the
 * existing request instead of filling the queue with the same person.
 */
const accessRequestSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, default: '' },
  // Free text from the requester: who they are, why they want in. Shown to the
  // admin, never rendered as HTML anywhere.
  note: { type: String, default: '' },

  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Why it was turned down. For the admin's own records — it is NOT sent to the
  // requester, who is only told the outcome.
  decisionNote: { type: String, default: '' },

  requestIp: { type: String, default: '' },
  // How many times this address has asked. A nudge for the admin, and a way to
  // spot someone hammering the form.
  requestCount: { type: Number, default: 1 },
  lastRequestedAt: { type: Date, default: Date.now },
}, { timestamps: true });

accessRequestSchema.index({ email: 1 }, { unique: true });
accessRequestSchema.index({ status: 1, createdAt: -1 });
accessRequestSchema.index({ requestIp: 1, createdAt: -1 });

accessRequestSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('AccessRequest', accessRequestSchema);
