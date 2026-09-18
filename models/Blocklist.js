const mongoose = require('mongoose');

const blocklistSchema = new mongoose.Schema({
  type: { type: String, enum: ['email', 'domain'], required: true },
  value: { type: String, required: true }, // lowercased email address or bare domain (e.g. "acme.com")
  reason: { type: String, default: '' },
}, { timestamps: true });

blocklistSchema.index({ type: 1, value: 1 }, { unique: true });

blocklistSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Blocklist', blocklistSchema);
