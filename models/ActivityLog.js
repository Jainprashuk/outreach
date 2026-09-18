const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  category: { type: String, required: true, index: true },
  action: { type: String, required: true },
  message: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: { createdAt: true, updatedAt: false } });

activityLogSchema.index({ createdAt: -1 });
module.exports = mongoose.model('ActivityLog', activityLogSchema);
