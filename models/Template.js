const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
}, { timestamps: true });

templateSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Template', templateSchema);
