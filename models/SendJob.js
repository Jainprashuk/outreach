const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  contactId: { type: String, required: true },
  to:        { type: String, required: true },
  name:      { type: String, required: true },
  subject:   { type: String, required: true },
  body:      { type: String, required: true },
  status:    { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  messageId: { type: String, default: null },
  error:     { type: String, default: null },
  processedAt: { type: Date, default: null },
}, { _id: false });

const sendJobSchema = new mongoose.Schema({
  items:             { type: [itemSchema], default: [] },
  status:            { type: String, enum: ['pending', 'processing', 'paused', 'done', 'cancelled'], default: 'pending' },
  attachResume:      { type: Boolean, default: false },
  processedCount:    { type: Number, default: 0 },
  senderEmail:       { type: String, default: '' },
  senderName:        { type: String, default: '' },
  senderAppPassword: { type: String, default: '' },
  sendMode:          { type: String, enum: ['sequential', 'bulk'], default: 'sequential' },
  chunkSize:         { type: Number, default: 20 },
}, { timestamps: true });

sendJobSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('SendJob', sendJobSchema);
