/**
 * The shared Library — every account's contact data, pooled (see lib/library.js
 * for the rules). Mounted behind requireLibraryAccess, which re-checks on every
 * request that an admin has turned the Library on for this account.
 *
 * Read-only towards everyone else: the only write here is the import, and it
 * writes Contacts into the CALLER's account through importContacts(), the same
 * path a CSV upload takes.
 */
const express = require('express');
const library = require('../lib/library');
const { importContacts, isValidEmail } = require('../lib/contactImport');
const { loadBlocklistSets, isBlocked } = require('../lib/blocklist');
const { logEvent } = require('../lib/activityLog');

const router = express.Router();
const MAX_IMPORT = 500;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const linkedinIn = (u) => (/linkedin\.com\/in\//i.test(u || '') ? u : '');

router.get('/:tab', async (req, res) => {
  try {
    res.json(await library.list(req.params.tab, req.userId, req.query));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/library/import { tab, keys[], template }
 * Copies the chosen rows into the caller's contacts as pending (Step 2 approval
 * as usual). Skipped: no address, hard-bounced anywhere, on the caller's own
 * blocklist, or a Discover guess marked low confidence.
 */
router.post('/import', async (req, res) => {
  try {
    const { tab, keys, template = '' } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: 'Pick at least one row' });
    if (keys.length > MAX_IMPORT) return res.status(400).json({ error: `At most ${MAX_IMPORT} rows at a time` });
    const wanted = [...new Set(keys.filter(k => typeof k === 'string' && k).map(String))];

    const { rows } = await library.resolve(tab, req.userId, wanted);
    const blocklist = await loadBlocklistSets(req.userId);

    const counts = { noEmail: 0, bounced: 0, blocked: 0, lowConfidence: 0, notFound: wanted.length - rows.length };
    const toImport = [];
    for (const r of rows) {
      if (!r.email || !isValidEmail(r.email)) { counts.noEmail++; continue; }
      if (r.bounced) { counts.bounced++; continue; }
      if (isBlocked(r.email, blocklist)) { counts.blocked++; continue; }
      if (tab === 'discover' && r.emailConfidence === 'low') { counts.lowConfidence++; continue; }
      toImport.push({
        name: norm(r.name) || r.email.split('@')[0],
        email: r.email,
        company: norm(r.company),
        role: norm(tab === 'discover' ? r.title : r.role),
        template: String(template || ''),
        linkedin: tab === 'leads' ? linkedinIn(r.authorUrl) : r.linkedin,
        ...(tab === 'people' && r.jobTitle ? { jobTitle: r.jobTitle } : {}),
        fromLibrary: true,
      });
    }

    const { created, existingEmails, filled } = toImport.length
      ? await importContacts(toImport, req.userId, { fillBlanks: true })
      : { created: [], existingEmails: new Set(), filled: 0 };

    logEvent({
      userId: req.userId, category: 'contacts', action: 'library-import',
      message: `Added ${created.length} contact(s) from the Library (${tab})`,
      meta: { tab, requested: wanted.length, created: created.length, existing: existingEmails.size, ...counts },
    }).catch(() => {});

    res.json({ created: created.length, existing: existingEmails.size, filled, ...counts });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
