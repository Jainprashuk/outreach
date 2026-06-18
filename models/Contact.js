const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  company: { type: String, default: '' },
  role: { type: String, default: '' },
  template: { type: String, default: 'intro-v2' },
  status: { type: String, enum: ['queued', 'sent', 'failed', 'bounced', 'replied'], default: 'queued' },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  editedSubject: { type: String, default: null },
  editedBody: { type: String, default: null },
  bounceReason: { type: String, default: null },
  messageId: { type: String, default: null },
  sentSubject: { type: String, default: null },
  repliedAt: { type: Date, default: null },
  replySnippet: { type: String, default: null },
  replyRead: { type: Boolean, default: false },
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
