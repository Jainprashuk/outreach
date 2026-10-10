const mongoose = require('mongoose');

// A cache of what free outside sources say about one company — funding or layoff
// news, a Hacker News "Who is hiring" post, open roles on its careers page, recent
// GitHub activity — plus, per user, how well the company fits what they're after.
// Written only by the background enrichment (lib/discovery/enrich), read by the
// "Worth searching" list, which never waits on an outside call.
//
// Public facts are shared by everyone (userId null): they're the same for every user
// and sharing them saves the free allowances. The fit row is per user (userId set).
// Nothing here is a copy of the app's own data.
const SOURCES = ['news', 'hn', 'careers', 'github', 'fit'];

const companySignalSchema = new mongoose.Schema({
  key:    { type: String, required: true },   // domain when known, else n:<normalised name>
  source: { type: String, enum: SOURCES, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // ok: checked and points apply · none: checked, nothing found · skipped: not
  // checkable (no domain, ambiguous name) · error: the source failed. Only `ok` rows
  // carry points, so a failure can only ever add 0.
  status:  { type: String, enum: ['ok', 'none', 'skipped', 'error'], required: true },
  points:  { type: Number, default: 0 },
  reasons: [{ _id: false, text: String, url: String }],
  note:    { type: String, default: '' },     // why skipped / what failed
  checkedAt: { type: Date, required: true },
}, { timestamps: true });

// Every field in it is always present (userId is null for shared rows, never missing),
// so a plain unique index is safe, with no sparse/null trap.
companySignalSchema.index({ key: 1, source: 1, userId: 1 }, { unique: true });

const CompanySignal = mongoose.model('CompanySignal', companySignalSchema);
CompanySignal.SOURCES = SOURCES;
module.exports = CompanySignal;
