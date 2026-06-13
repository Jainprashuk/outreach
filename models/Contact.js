const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  company: { type: String, default: '' },
  role: { type: String, default: '' },
  template: { type: String, default: 'intro-v2' },
  status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  editedSubject: { type: String, default: null },
  editedBody: { type: String, default: null },
}, { timestamps: true });

contactSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Contact', contactSchema);
