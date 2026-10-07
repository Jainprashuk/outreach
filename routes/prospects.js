// Discover tab: find people at a company, guess their work email, and move the
// ones you pick into outreach. Nothing here sends anything — a moved prospect becomes
// an ordinary pending Contact, so Step 2 approval still decides what goes out.

const express = require('express');
const mongoose = require('mongoose');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const CompanyPattern = require('../models/CompanyPattern');
const DiscoveryConfig = require('../models/DiscoveryConfig');
const Contact = require('../models/Contact');
const { inngest } = require('../inngest');
const credentials = require('../lib/credentials');
const { importContacts } = require('../lib/contactImport');
const { loadBlocklistSets, isBlocked } = require('../lib/blocklist');
const ep = require('../lib/emailPatterns');
const usage = require('../lib/discovery/usage');
const finder = require('../lib/patternFinder');
const { applyEmails, present, isActive } = require('../lib/prospectSearch');
const { lookupCompany } = require('../lib/discovery/companyLookup');
const { discoverAnalytics } = require('../lib/prospectAnalytics');
const { hiringCompanies } = require('../lib/discovery/hiringCompanies');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };
const OPEN = ['new', 'ready', 'error'];
const MAX_IDS = 500;

const isId = (id) => mongoose.isValidObjectId(id);
const err500 = (res, err) => res.status(500).json({ error: err.message });

const serialize = (doc) => {
  const obj = { ...doc, id: String(doc._id) };
  delete obj._id;
  delete obj.__v;
  return obj;
};

function idList(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map(String))].filter(isId);
  return ids.length && ids.length <= MAX_IDS ? ids : null;
}

function cleanRoles(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const seen = new Set();
  return list.map(r => String(r || '').replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(r => r && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()))
    .slice(0, 5);
}


// ── Keys for the free discovery services ───────────────────────────────────

async function configView(userId) {
  const doc = await DiscoveryConfig.findOne({ userId });
  const keys = doc ? doc.toJSON() : Object.fromEntries(DiscoveryConfig.PROVIDERS.map(p => [p, false]));
  const caps = Object.fromEntries(Object.entries(DiscoveryConfig.MONTHLY_CAPS).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));
  return {
    keys: Object.fromEntries(DiscoveryConfig.PROVIDERS.map(p => [p, !!keys[p]])),
    usage: await usage.getUsage(userId),
    caps,
    canStoreKeys: credentials.isConfigured(),
    defaultRoles: (doc && doc.defaultRoles) || [],
  };
}

router.get('/config', async (req, res) => {
  try { res.json(await configView(req.userId)); } catch (err) { err500(res, err); }
});

// PUT /api/prospects/config — { tavily?, serpapi?, hunter?, github?, defaultRoles? };
// a non-empty string stores (replaces) that key, and defaultRoles replaces your saved
// roles ([] clears them). Removing a key is DELETE /config/:provider.
router.put('/config', async (req, res) => {
  try {
    const set = {};
    if (req.body && req.body.defaultRoles !== undefined) set.defaultRoles = cleanRoles(req.body.defaultRoles);
    const givesKey = DiscoveryConfig.PROVIDERS.some(p => typeof (req.body || {})[p] === 'string' && req.body[p].trim());
    if (givesKey && !credentials.isConfigured()) {
      return res.status(503).json({ error: 'CREDENTIAL_KEY is not set, so a key cannot be stored safely.' });
    }
    for (const p of DiscoveryConfig.PROVIDERS) {
      const v = req.body && req.body[p];
      if (typeof v !== 'string' || !v.trim()) continue;
      if (v.trim().length > 300) return res.status(400).json({ error: `${p} key is too long` });
      set[`${p}Enc`] = credentials.encrypt(v.trim());
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to save' });
    await DiscoveryConfig.updateOne({ userId: req.userId }, { $set: set, $setOnInsert: { userId: req.userId } }, { upsert: true });
    res.json(await configView(req.userId));
  } catch (err) { err500(res, err); }
});

router.delete('/config/:provider', async (req, res) => {
  try {
    const p = req.params.provider;
    if (!DiscoveryConfig.PROVIDERS.includes(p)) return res.status(404).json({ error: 'Unknown provider' });
    await DiscoveryConfig.updateOne({ userId: req.userId }, { $set: { [`${p}Enc`]: '' } });
    res.json(await configView(req.userId));
  } catch (err) { err500(res, err); }
});

// ── Searches ───────────────────────────────────────────────────────────────

// POST /api/prospects/search — { domain, companyName?, roles?, force? }
router.post('/search', async (req, res) => {
  try {
    const body = req.body || {};
    const domain = ep.normalizeDomain(body.domain);
    if (!domain) return res.status(400).json({ error: 'Enter the company’s website domain, e.g. acme.in' });
    if (ep.isFreeMail(domain)) {
      return res.status(400).json({ error: `${domain} is a personal-email provider — enter the company’s own domain` });
    }
    const block = await loadBlocklistSets(req.userId);
    if (block.domains.has(domain)) return res.status(400).json({ error: `${domain} is on your blocklist` });

    const last = await ProspectSearch.findOne({ userId: req.userId, domain }).sort({ createdAt: -1 }).lean();
    if (isActive(last)) {
      return res.status(409).json({ error: 'A search for this company is already running', search: serialize(present(last)) });
    }

    const search = await ProspectSearch.create({
      userId: req.userId,
      domain,
      companyName: String(body.companyName || '').trim().slice(0, 120),
      roles: cleanRoles(body.roles),
      force: !!body.force,
      steps: ProspectSearch.STEP_KEYS.map(key => ({ key })),
    });

    try {
      await inngest.send({ name: 'prospects/search.start', data: { searchId: String(search._id), userId: String(req.userId) } });
    } catch (e) {
      await ProspectSearch.updateOne({ _id: search._id }, { $set: { status: 'error', error: 'Background worker unavailable', finishedAt: new Date() } });
      return res.status(503).json({ error: `Couldn't start the search: ${e.message}` });
    }
    res.status(201).json({ search: serialize(search.toObject()) });
  } catch (err) { err500(res, err); }
});

router.get('/search/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const s = await ProspectSearch.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ search: serialize(present(s)) });
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/searches — your search history, newest first. A history row is
// the search itself (company, roles, when, what it found); removing it, or discarding
// the people it found, never touches the other.
router.get('/searches', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await ProspectSearch.find({ userId: req.userId, hidden: { $ne: true } })
      .sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ searches: rows.map(r => serialize(present(r))) });
  } catch (err) { err500(res, err); }
});

// DELETE /api/prospects/searches/:id — remove one search from history (people stay).
router.delete('/searches/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await ProspectSearch.updateOne({ _id: req.params.id, userId: req.userId }, { $set: { hidden: true } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { err500(res, err); }
});

// DELETE /api/prospects/searches — clear the whole history (people stay).
router.delete('/searches', async (req, res) => {
  try {
    const r = await ProspectSearch.updateMany({ userId: req.userId, hidden: { $ne: true }, status: { $in: ['done', 'error'] } }, { $set: { hidden: true } });
    res.json({ ok: true, cleared: r.modifiedCount });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/search/:id/cancel — stop a running search. The background
// function checks the status before every step, so it stops at the next one; people
// already found stay.
router.post('/search/:id/cancel', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await ProspectSearch.updateOne(
      { _id: req.params.id, userId: req.userId, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'error', error: 'Cancelled', finishedAt: new Date(), 'steps.$[s].status': 'skipped' } },
      { arrayFilters: [{ 's.status': { $in: ['pending', 'running'] } }] },
    );
    const s = await ProspectSearch.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, cancelled: r.modifiedCount === 1, search: serialize(present(s)) });
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/companies — every company you've searched, newest first.
router.get('/companies', async (req, res) => {
  try {
    const [searches, counts] = await Promise.all([
      ProspectSearch.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(req.userId)) } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$domain', companyName: { $first: '$companyName' }, lastSearchAt: { $first: '$createdAt' }, lastSearchId: { $first: '$_id' } } },
        { $sort: { lastSearchAt: -1 } },
        { $limit: 200 },
      ]),
      Prospect.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(req.userId)), deleted: { $ne: true } } },
        { $group: {
          _id: '$domain',
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $in: ['$status', OPEN] }, 1, 0] } },
          moved: { $sum: { $cond: [{ $eq: ['$status', 'moved'] }, 1, 0] } },
        } },
      ]),
    ]);
    const byDomain = new Map(counts.map(c => [c._id, c]));
    res.json({
      companies: searches.map(s => ({
        domain: s._id,
        companyName: s.companyName,
        lastSearchAt: s.lastSearchAt,
        lastSearchId: String(s.lastSearchId),
        total: byDomain.get(s._id)?.total || 0,
        open: byDomain.get(s._id)?.open || 0,
        moved: byDomain.get(s._id)?.moved || 0,
      })),
    });
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/analytics — Analytics → Discover: searches, people found, and
// how the guessed addresses performed once emailed, per confidence label.
router.get('/analytics', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    res.json(await discoverAnalytics(req.userId, { days }));
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/hiring?days=30 — companies you already know are hiring, from
// LinkedIn hiring posts and Naukri jobs. days=0 means all time.
router.get('/hiring', async (req, res) => {
  try {
    const raw = parseInt(req.query.days, 10);
    const days = raw === 0 ? null : Math.min(Math.max(raw || 30, 1), 365);
    const source = ['linkedin', 'naukri'].includes(req.query.source) ? req.query.source : '';
    res.json(await hiringCompanies(new mongoose.Types.ObjectId(String(req.userId)), {
      days,
      q: String(req.query.q || '').slice(0, 80),
      source,
      hideSearched: req.query.hideSearched === '1',
      page: parseInt(req.query.page, 10) || 1,
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 10), 100),
    }));
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/lookup?q=Zerodha — a company's name (or website) → candidate
// email domains, strongest first. See lib/discovery/companyLookup.js.
router.get('/lookup', async (req, res) => {
  try { res.json(await lookupCompany(req.userId, req.query.q)); } catch (err) { err500(res, err); }
});

// GET /api/prospects/domains/suggest?q=ac — domains you've already emailed.
router.get('/domains/suggest', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ domains: [] });
    const emails = await Contact.distinct('email', { userId: req.userId, deleted: { $ne: true } });
    const counts = new Map();
    for (const e of emails) {
      const d = ep.domainOfEmail(e);
      if (!d || ep.isFreeMail(d) || !d.startsWith(q)) continue;
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    res.json({ domains: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, contacts]) => ({ domain, contacts })) });
  } catch (err) { err500(res, err); }
});

// ── One company's format ───────────────────────────────────────────────────

router.get('/patterns/:domain', async (req, res) => {
  try {
    const domain = ep.normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Bad domain' });
    const { decision, prior, contacts, cp } = await finder.resolveDomain(req.userId, domain);
    const bySource = {};
    for (const s of (cp && cp.samples) || []) bySource[s.source] = (bySource[s.source] || 0) + 1;
    res.json({
      domain,
      companyName: (cp && cp.companyName) || '',
      hasMx: cp ? cp.hasMx : null,
      githubOrg: (cp && cp.githubOrg) || null,
      githubOrgManual: !!(cp && cp.githubOrgManual),
      githubCheckedAt: (cp && cp.githubCheckedAt) || null,
      websiteCheckedAt: (cp && cp.websiteCheckedAt) || null,
      hunterAskedAt: (cp && cp.hunterAskedAt) || null,
      genericEmails: (cp && cp.genericEmails) || [],
      samples: bySource,
      contactsAtDomain: contacts.length,
      decision: {
        pattern: decision.pattern,
        confidence: decision.confidence,
        source: decision.source,
        runnerUp: decision.runnerUp,
        patterns: decision.patterns,
      },
      defaultGuess: prior[0],
    });
  } catch (err) { err500(res, err); }
});

// PATCH /api/prospects/patterns/:domain — { githubOrg } sets the org by hand ('' clears).
router.patch('/patterns/:domain', async (req, res) => {
  try {
    const domain = ep.normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Bad domain' });
    const raw = String((req.body && req.body.githubOrg) || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    if (raw && !/^[A-Za-z0-9-]{1,39}$/.test(raw)) return res.status(400).json({ error: 'That doesn’t look like a GitHub organisation name' });
    await CompanyPattern.updateOne(
      { userId: req.userId, domain },
      { $set: { githubOrg: raw || null, githubOrgManual: !!raw, githubCheckedAt: null }, $setOnInsert: { userId: req.userId, domain } },
      { upsert: true },
    );
    res.json({ ok: true, githubOrg: raw || null });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/patterns/:domain/recheck — re-label every open prospect from
// what's known now (your latest replies and bounces included). No outside calls.
router.post('/patterns/:domain/recheck', async (req, res) => {
  try {
    const domain = ep.normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Bad domain' });
    const r = await applyEmails(req.userId, domain);
    res.json({ ok: true, people: r.people, withEmail: r.withEmail, pattern: r.decision.pattern, confidence: r.decision.confidence });
  } catch (err) { err500(res, err); }
});

// ── Prospects ──────────────────────────────────────────────────────────────

const CONF_ORDER = { high: 0, generic: 1, medium: 2, low: 3 };

// GET /api/prospects?domain=&status=open|ready|moved|discarded|all&confidence=
router.get('/', async (req, res) => {
  try {
    const { domain: rawDomain, status = 'open', confidence, q } = req.query;
    const filter = { userId: req.userId, ...BASE_FILTER };
    const domain = rawDomain ? ep.normalizeDomain(rawDomain) : null;
    if (rawDomain && !domain) return res.status(400).json({ error: 'Bad domain' });
    if (domain) filter.domain = domain;
    if (status === 'open') filter.status = { $in: OPEN };
    else if (status !== 'all') filter.status = status;
    if (confidence) filter.emailConfidence = confidence === 'none' ? null : confidence;
    if (q && String(q).trim()) {
      const re = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60);
      filter.$or = [{ name: { $regex: re, $options: 'i' } }, { title: { $regex: re, $options: 'i' } }];
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const [total, docs] = await Promise.all([
      Prospect.countDocuments(filter),
      Prospect.find(filter).sort({ roleMatch: -1, createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    // Within the page: people matching the searched roles first, then strongest label.
    const rows = docs.map(serialize).sort((a, b) =>
      (Number(b.roleMatch) - Number(a.roleMatch))
      || ((CONF_ORDER[a.emailConfidence] ?? 9) - (CONF_ORDER[b.emailConfidence] ?? 9)));
    res.json({ prospects: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { err500(res, err); }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PATCH /api/prospects/:id — { name?, title?, email? }. An address you type is
// yours: it is marked manual, has no guessed label, and no later search replaces it.
// email: '' hands it back to the guesser.
router.patch('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const p = await Prospect.findOne({ _id: req.params.id, userId: req.userId, ...BASE_FILTER }).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.status === 'moved') return res.status(409).json({ error: 'Already moved to outreach — edit the contact instead' });

    const body = req.body || {};
    const set = {};
    if (typeof body.title === 'string') set.title = body.title.trim().slice(0, 160);
    if (typeof body.name === 'string') {
      const name = body.name.replace(/\s+/g, ' ').trim().slice(0, 120);
      const key = ep.nameKey(name);
      if (!name || !key) return res.status(400).json({ error: 'Enter a name' });
      Object.assign(set, { name, nameKey: key });
    }
    let regenerate = false;
    if (body.email !== undefined) {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) {
        Object.assign(set, { email: null, emailSource: null, emailConfidence: null, emailPattern: null });
        regenerate = true;
      } else {
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That isn’t a valid email address' });
        const existing = await Contact.findOne({ userId: req.userId, email, deleted: { $ne: true } }, { _id: 1 })
          .collation({ locale: 'en', strength: 2 }).lean();
        Object.assign(set, {
          email, emailSource: 'manual', emailConfidence: null,
          emailPattern: ep.inferPattern(set.name || p.name, email),
          existingContactId: existing ? String(existing._id) : null,
          contactedAs: null, note: '', status: 'ready',
        });
      }
    } else if (set.name && p.emailSource !== 'manual') {
      regenerate = true; // a corrected name deserves a fresh guess
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });

    await Prospect.updateOne({ _id: p._id, userId: req.userId }, { $set: set });
    if (regenerate) await applyEmails(req.userId, p.domain);
    const fresh = await Prospect.findOne({ _id: p._id, userId: req.userId }).lean();
    res.json({ prospect: serialize(fresh) });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/move — { ids, template }. Creates pending contacts (Step 2
// still approves them). Skips, and reports, anything not safe to move.
router.post('/move', async (req, res) => {
  try {
    const ids = idList(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: `Expected 1–${MAX_IDS} prospect ids` });
    const template = String((req.body && req.body.template) || '');

    const docs = await Prospect.find({ _id: { $in: ids }, userId: req.userId, ...BASE_FILTER }).lean();
    const block = await loadBlocklistSets(req.userId);

    const out = { moved: 0, alreadyMoved: 0, notReady: 0, blocked: 0, duplicates: 0 };
    const rows = [];
    for (const d of docs) {
      if (d.status === 'moved') { out.alreadyMoved++; continue; }
      if (d.status !== 'ready' || !d.email) { out.notReady++; continue; }
      if (isBlocked(d.email, block)) { out.blocked++; continue; }
      if (d.existingContactId) { out.duplicates++; continue; }
      rows.push({
        _prospectId: String(d._id),
        name: d.name,
        email: d.email,
        company: d.company || '',
        role: d.title || '',
        template,
        prospectId: String(d._id),
        emailConfidence: d.emailConfidence || null,
        emailPattern: d.emailPattern || null,
      });
    }

    const { created } = rows.length ? await importContacts(rows, req.userId) : { created: [] };
    const createdByEmail = new Map(created.map(c => [c.email, String(c._id)]));

    // Rows importContacts skipped already existed as contacts (created since the
    // last label refresh) — record which, rather than moving them.
    const skippedEmails = rows.filter(r => !createdByEmail.has(r.email.trim().toLowerCase())).map(r => r.email.trim().toLowerCase());
    const existing = skippedEmails.length
      ? await Contact.find({ userId: req.userId, email: { $in: skippedEmails }, deleted: { $ne: true } }, { email: 1 })
        .collation({ locale: 'en', strength: 2 }).lean()
      : [];
    const existingByEmail = new Map(existing.map(c => [c.email.toLowerCase(), String(c._id)]));

    const now = new Date();
    const ops = rows.map(r => {
      const email = r.email.trim().toLowerCase();
      const contactId = createdByEmail.get(email);
      if (contactId) {
        out.moved++;
        return { updateOne: { filter: { _id: r._prospectId, userId: req.userId }, update: { $set: { status: 'moved', movedAt: now, contactId } } } };
      }
      out.duplicates++;
      return { updateOne: { filter: { _id: r._prospectId, userId: req.userId }, update: { $set: { existingContactId: existingByEmail.get(email) || null } } } };
    });
    if (ops.length) await Prospect.bulkWrite(ops, { ordered: false });

    res.json({ ok: true, ...out });
  } catch (err) { err500(res, err); }
});

router.post('/discard', async (req, res) => {
  try {
    const ids = idList(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: `Expected 1–${MAX_IDS} prospect ids` });
    const r = await Prospect.updateMany(
      { _id: { $in: ids }, userId: req.userId, status: { $in: OPEN }, ...BASE_FILTER },
      { $set: { status: 'discarded' } },
    );
    res.json({ ok: true, discarded: r.modifiedCount });
  } catch (err) { err500(res, err); }
});

router.post('/restore', async (req, res) => {
  try {
    const ids = idList(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: `Expected 1–${MAX_IDS} prospect ids` });
    const r = await Prospect.updateMany(
      { _id: { $in: ids }, userId: req.userId, status: 'discarded', ...BASE_FILTER },
      { $set: { status: 'ready' } },
    );
    res.json({ ok: true, restored: r.modifiedCount });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/add-generic — { domain, email }: a shared mailbox (careers@)
// found on the company's website, added as a prospect of its own.
router.post('/add-generic', async (req, res) => {
  try {
    const domain = ep.normalizeDomain(req.body && req.body.domain);
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!domain || !email) return res.status(400).json({ error: 'Expected domain and email' });
    const cp = await CompanyPattern.findOne({ userId: req.userId, domain }, { genericEmails: 1, companyName: 1 }).lean();
    if (!cp || !(cp.genericEmails || []).includes(email)) return res.status(404).json({ error: 'That address wasn’t found on the company’s website' });

    const local = ep.localPartOf(email);
    const key = `generic|${local}`;
    const dupe = await Prospect.findOne({ userId: req.userId, domain, nameKey: key, ...BASE_FILTER }).lean();
    if (dupe) return res.json({ prospect: serialize(dupe), existed: true });

    const existing = await Contact.findOne({ userId: req.userId, email, deleted: { $ne: true } }, { _id: 1 })
      .collation({ locale: 'en', strength: 2 }).lean();
    const label = local.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const doc = await Prospect.create({
      userId: req.userId, domain, company: cp.companyName || '',
      name: `${label} (${cp.companyName || domain})`, title: 'Shared mailbox', nameKey: key,
      foundVia: ['website'], knownEmail: email, knownEmailVia: 'website',
      email, emailConfidence: 'generic', emailSource: 'website', status: 'ready',
      existingContactId: existing ? String(existing._id) : null,
    });
    res.status(201).json({ prospect: serialize(doc.toObject()) });
  } catch (err) { err500(res, err); }
});

module.exports = router;
