const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  key: { type: String, required: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
}, { timestamps: true });

// Per-user, not global: two people may both have a template keyed "follow-up".
// The old global unique index on `key` is dropped by scripts/migrate-multi-tenant.js.
templateSchema.index({ userId: 1, key: 1 }, { unique: true });

templateSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Template', templateSchema);
