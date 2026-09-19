const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  name: { type: String, required: true },
  email: { type: String, required: true },
  company: { type: String, default: '' },
  role: { type: String, default: '' },
  template: { type: String, default: '' },
  status: { type: String, enum: ['queued', 'in-campaign', 'sent', 'follow-up-sent', 'failed', 'bounced', 'replied', 'follow-up-replied', 'closed', 'no-openings', 'in-review', 'blocked'], default: 'queued' },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  editedSubject: { type: String, default: null },
  editedBody: { type: String, default: null },
  bounceReason: { type: String, default: null },
  failReason:   { type: String, default: null },
  messageId: { type: String, default: null },
  sentSubject: { type: String, default: null },
  repliedAt: { type: Date, default: null },
  replySnippet: { type: String, default: null },
  replyRead: { type: Boolean, default: false },
  replyCategory: { type: String, enum: ['reviewing', 'stay-in-touch', 'no', 'resume-requested', 'needs-attention', 'other'], default: null },
  replyCategoryReasoning: { type: String, default: null },
  replyCategorizedAt: { type: Date, default: null },
  // What produced replyCategory: a deterministic rule, or one of the LLM providers. Null on
  // rows classified before this was tracked, which simply means unknown. It exists so a
  // change to the rules can invalidate exactly the verdicts those rules produced
  // (updateMany({classifiedBy:'rules'}, {$set:{replyClassifierOk:false}})) without
  // re-spending a request on every contact that a model already answered.
  classifiedBy: { type: String, enum: ['rules', 'gemini', 'groq', 'cerebras', null], default: null },
  // True only when classification of the CURRENT latest reply actually succeeded — distinct
  // from replyCategory's value, since a rate-limited/failed call must never look identical to
  // a genuine "needs-attention" verdict. A rules verdict counts as success: it is a real,
  // deterministic answer, so re-running it later would only reproduce itself. Reset to false
  // whenever a new reply comes in, so a fresh message always needs its own classification.
  replyClassifierOk: { type: Boolean, default: false },
  lastSentAt: { type: Date, default: null },
  followUpSentAt: { type: Date, default: null },
  // Full mailbox-style conversation history — every outbound send (via this app
  // or your own Sent folder) and every inbound reply, in full (unlike
  // replySnippet, which is truncated for list-preview use only).
  thread: [{
    direction:  { type: String, enum: ['outbound', 'inbound'] },
    subject:    { type: String, default: '' },
    text:       { type: String, default: '' },
    html:       { type: String, default: '' },
    messageId:  { type: String, default: null },
    inReplyTo:  { type: String, default: null },
    at:         { type: Date, default: Date.now },
  }],
  statusHistory: [{
    status:    { type: String },
    changedAt: { type: Date, default: Date.now },
    note:      { type: String, default: '' },
  }],
  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// Indexes for common query patterns
contactSchema.index({ createdAt: -1 });
contactSchema.index({ status: 1, createdAt: -1 });
contactSchema.index({ approvalStatus: 1 });
contactSchema.index({ email: 1 });
contactSchema.index({ messageId: 1 });

contactSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Contact', contactSchema);
