const mongoose = require('mongoose');

// A Prospect is one person found at a target company by the Discover tab, with
// the work email the app guessed for them. A staging record only: nothing here is
// ever emailed. A prospect reaches outreach only when you tick it and click "Move to
// outreach", which creates an ordinary Contact (pending, so Step 2 still gates it).
//
// Deliberately NOT the Lead model — Lead is the LinkedIn-harvested posts board, with
// its own statuses, dedupe and parity checks.
const prospectSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  searchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProspectSearch', default: null }, // latest search that found them
  domain:   { type: String, required: true },   // lowercased email domain, e.g. acme.in
  company:  { type: String, default: '' },

  name:     { type: String, required: true },
  title:    { type: String, default: '' },
  linkedin: { type: String, default: null },
  // first|last — one person's identity within a domain, so a second search (or a
  // second source in the same search) updates the row instead of duplicating it.
  nameKey:  { type: String, required: true },
  foundVia: { type: [String], default: [] },    // 'search' | 'github' | 'website'
  roleMatch: { type: Boolean, default: false }, // title matched a searched role

  // The person's OWN address, when a source showed it (a commit, a website page).
  // Kept apart from `email` so a re-run can tell a seen address from a guess.
  knownEmail:  { type: String, default: null },
  knownEmailVia: { type: String, default: null },

  email:           { type: String, default: null },
  emailPattern:    { type: String, default: null },
  emailConfidence: { type: String, enum: ['high', 'medium', 'low', 'generic', null], default: null },
  emailSource:     { type: String, enum: ['own', 'leads', 'github', 'website', 'hunter', 'default', 'manual', null], default: null },
  note:            { type: String, default: '' }, // why there's no email, or a warning

  status: { type: String, enum: ['new', 'ready', 'moved', 'discarded', 'error'], default: 'new' },
  existingContactId: { type: String, default: null }, // this email is already a contact
  contactedAs:       { type: String, default: null }, // same person, already a contact under another address
  contactId: { type: String, default: null },
  movedAt:   { type: Date, default: null },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

prospectSchema.index({ userId: 1, domain: 1, status: 1 });
prospectSchema.index({ userId: 1, domain: 1, nameKey: 1 });
prospectSchema.index({ userId: 1, movedAt: -1 });

prospectSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Prospect', prospectSchema);
