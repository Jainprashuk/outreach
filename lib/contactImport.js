const Contact = require('../models/Contact');

// Extracted from routes/contacts.js POST / so that /api/leads/move-to-outreach
// shares one implementation of the dedupe rules. HTTP-level validation (non-empty
// array, name + email required per row) stays in the route.
//
// Returns existingEmails too, which the leads route needs to report
// created-vs-already-existing counts. Rows may carry extra keys; only
// {name, email, company, role, template} are persisted.
async function importContacts(rows) {
  // Deduplicate within the incoming batch (keep first occurrence, case-insensitive)
  const seen = new Set();
  const unique = rows.filter(r => {
    const key = String(r.email || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Find which emails already exist in the DB (non-deleted)
  const incomingEmails = unique.map(r => r.email.trim().toLowerCase());
  const existing = incomingEmails.length
    ? await Contact.find(
        { email: { $in: incomingEmails }, deleted: { $ne: true } },
        { email: 1 }
      ).collation({ locale: 'en', strength: 2 }).lean()
    : [];
  const existingEmails = new Set(existing.map(c => c.email.trim().toLowerCase()));

  const toInsert = unique.filter(r => !existingEmails.has(r.email.trim().toLowerCase()));

  let created = [];
  if (toInsert.length > 0) {
    created = await Contact.insertMany(toInsert.map(r => ({
      name: r.name,
      email: r.email.trim().toLowerCase(),
      company: r.company || '',
      role: r.role || '',
      template: r.template || '',
    })));
  }

  return { created, existingEmails, uniqueCount: unique.length };
}

module.exports = { importContacts };
