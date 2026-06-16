const mongoose = require('mongoose');

const variableSchema = new mongoose.Schema({
  key: { type: String, required: true },
  value: { type: String, default: '' },
}, { _id: false });

const resumeSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  data: { type: Buffer, required: true },
  size: { type: Number, required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

// Singleton document — there is only ever one settings record.
const settingsSchema = new mongoose.Schema({
  senderName: { type: String, default: 'Your Name' },
  senderCompany: { type: String, default: 'Your Company' },
  gmailEmail: { type: String, default: '' },
  customVariables: { type: [variableSchema], default: [] },
  resume: { type: resumeSchema, default: null },
  lastMailboxCheckAt: { type: Date, default: null },
}, { timestamps: true });

settingsSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.resume) {
      ret.resume = {
        filename: ret.resume.filename,
        contentType: ret.resume.contentType,
        size: ret.resume.size,
        uploadedAt: ret.resume.uploadedAt,
      };
    }
    return ret;
  }
});

settingsSchema.statics.getSingleton = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
