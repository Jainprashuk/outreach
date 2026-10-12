const mongoose = require('mongoose');

// One "Test format" send from Discover: a single real outreach email to one person in
// one format, to find out whether the company's format is right before everyone else
// gets it. What happened to it (sent, bounced, replied) is NOT stored here — it is read
// from the Contact every time (lib/formatTest.js testStatus), so it can never disagree
// with the mailbox scan. Only your own decision (confirmed) is written.
const formatTestSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  domain:      { type: String, required: true },
  prospectId:  { type: String, required: true },
  contactId:   { type: String, required: true },
  jobId:       { type: String, default: null },
  name:        { type: String, default: '' },
  email:       { type: String, required: true },
  pattern:     { type: String, default: null }, // null when the address fits no format
  templateKey: { type: String, default: '' },
  confirmedAt: { type: Date, default: null },
}, { timestamps: true });

formatTestSchema.index({ userId: 1, domain: 1, createdAt: -1 });

module.exports = mongoose.model('FormatTest', formatTestSchema);
