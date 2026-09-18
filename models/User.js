const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    return ret;
  }
});

module.exports = mongoose.model('User', userSchema);
