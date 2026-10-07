const Contact = require('../models/Contact');

// Same predicate as lib/campaignRunner.js. A spreadsheet whose columns were
// mapped wrong puts "react js" or "iit bombay" in the email field; those rows
// used to become contacts and then fail at send time with "No recipients
// defined", inside a campaign, unattended.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (email) => EMAIL_RE.test(String(email || '').trim());

// Extracted from routes/contacts.js POST / so that /api/leads/move-to-outreach
// shares one implementation of the dedupe rules. HTTP-level validation (non-empty
// array, name + email required per row) stays in the route.
//
// Returns existingEmails too, which the leads route needs to report
// created-vs-already-existing counts, and invalidEmails — rows dropped because
// their email is not an address. Rows may carry extra keys; only
// {name, email, company, role, template, source, sourceLeadId} are persisted, plus
// {prospectId, emailConfidence, emailPattern} when a row carries a prospectId.
async function importContacts(rows, userId) {
  const invalidEmails = [];
  // Deduplicate within the incoming batch (keep first occurrence, case-insensitive)
  const seen = new Set();
  const unique = rows.filter(r => {
    const key = String(r.email || '').trim().toLowerCase();
    if (!key) return false;
    if (!isValidEmail(key)) { invalidEmails.push(String(r.email).trim()); return false; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Find which emails already exist in the DB (non-deleted)
  const incomingEmails = unique.map(r => r.email.trim().toLowerCase());
  const existing = incomingEmails.length
    ? await Contact.find(
        { userId, email: { $in: incomingEmails }, deleted: { $ne: true } },
        { email: 1 }
      ).collation({ locale: 'en', strength: 2 }).lean()
    : [];
  const existingEmails = new Set(existing.map(c => c.email.trim().toLowerCase()));

  const toInsert = unique.filter(r => !existingEmails.has(r.email.trim().toLowerCase()));

  let created = [];
  if (toInsert.length > 0) {
    created = await Contact.insertMany(toInsert.map(r => ({
      userId,
      name: r.name,
      email: r.email.trim().toLowerCase(),
      company: r.company || '',
      role: r.role || '',
      template: r.template || '',
      // Only the leads route passes these; every other caller is direct outreach.
      source: r.source === 'lead' ? 'lead' : 'outreach',
      sourceLeadId: r.source === 'lead' ? (r.sourceLeadId || null) : null,
      // Only the Discover route passes these. Absent otherwise, so every other
      // caller inserts exactly the same document as before.
      ...(r.prospectId ? {
        prospectId: r.prospectId,
        ...(r.emailConfidence ? { emailConfidence: r.emailConfidence } : {}),
        ...(r.emailPattern ? { emailPattern: r.emailPattern } : {}),
      } : {}),
    })));
  }

  return { created, existingEmails, invalidEmails, uniqueCount: unique.length };
}

module.exports = { importContacts, isValidEmail, EMAIL_RE };
