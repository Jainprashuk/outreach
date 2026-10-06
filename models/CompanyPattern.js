const mongoose = require('mongoose');

// What outside sources said about one company's email format, per user. Your OWN
// outreach history is deliberately not stored here: it is read fresh from Contacts
// on every resolve (lib/patternFinder.js), so it can never drift from what actually
// happened and nothing has to update it when a reply or bounce arrives.
const companyPatternSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  domain:      { type: String, required: true },
  companyName: { type: String, default: '' },

  // Real addresses seen at this company, by source. Stored as the (name, email)
  // pairs themselves rather than counts, so a change to the inference rules re-reads
  // them correctly instead of trusting a number computed by the old rules.
  samples: [{
    _id: false,
    source: { type: String, enum: ['github', 'website'] },
    name:   { type: String, default: '' },
    email:  { type: String },
  }],
  genericEmails: { type: [String], default: [] }, // careers@, hr@ ... found on the website

  githubOrg:         { type: String, default: null }, // resolved or set by hand
  githubOrgManual:   { type: Boolean, default: false },
  githubCheckedAt:   { type: Date, default: null },
  websiteCheckedAt:  { type: Date, default: null },

  hunterPattern:  { type: String, default: null },
  hunterAskedAt:  { type: Date, default: null },  // asked once per domain, ever

  hasMx:       { type: Boolean, default: null },
  mxCheckedAt: { type: Date, default: null },
}, { timestamps: true });

// Both fields are always set, so a plain unique index is safe (no sparse/null trap).
companyPatternSchema.index({ userId: 1, domain: 1 }, { unique: true });

module.exports = mongoose.model('CompanyPattern', companyPatternSchema);
