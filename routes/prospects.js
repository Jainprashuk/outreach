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
const worth = require('../lib/discovery/companyWorth');
const { rolesForJob } = require('../lib/discovery/jobRoles');
const SuggestionDismissal = require('../models/SuggestionDismissal');
const FormatTest = require('../models/FormatTest');
const SendJob = require('../models/SendJob');
const Settings = require('../models/Settings');
const mailer = require('../lib/mailer');
const { holdBehindQuota } = require('../lib/sendQuota');
const { loadRenderContext, renderTemplate } = require('../lib/renderTemplate');
const { requireOnboarded } = require('../lib/onboardingGuard');
const { testStatus } = require('../lib/formatTest');
const NaukriJob = require('../models/NaukriJob');

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
    enrichOff: (doc && doc.enrichOff) || [],
  };
}

const ENRICH_SOURCES = ['news', 'hn', 'careers', 'github', 'fit'];

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
    if (req.body && Array.isArray(req.body.enrichOff)) set.enrichOff = [...new Set(req.body.enrichOff.map(String))].filter(x => ENRICH_SOURCES.includes(x));
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

// POST /api/prospects/search — { domain, companyName?, roles?, force?, naukriJobId? }
//
// naukriJobId: the search is for a Naukri job you applied to. The job's title is kept
// on the search so people moved from it carry {{jobTitle}} into outreach. If the same
// company was already searched in the last 30 days, that search is linked to the job
// and returned instead of spending credits on a second one (force: true re-runs).
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

    let job = null;
    if (body.naukriJobId !== undefined && body.naukriJobId !== null && body.naukriJobId !== '') {
      if (!isId(body.naukriJobId)) return res.status(400).json({ error: 'Bad naukriJobId' });
      job = await NaukriJob.findOne({ _id: body.naukriJobId, userId: req.userId, deleted: { $ne: true } }, { title: 1 }).lean();
      if (!job) return res.status(404).json({ error: 'That Naukri job wasn’t found' });
    }
    const jobFields = job ? { naukriJobId: String(job._id), jobTitle: String(job.title || '').slice(0, 160) } : {};

    const last = await ProspectSearch.findOne({ userId: req.userId, domain }).sort({ createdAt: -1 }).lean();
    if (isActive(last)) {
      return res.status(409).json({ error: 'A search for this company is already running', search: serialize(present(last)) });
    }
    if (job && !body.force && last && last.status === 'done' && Date.now() - new Date(last.createdAt).getTime() < 30 * 24 * 3600 * 1000) {
      if (!last.naukriJobId) await ProspectSearch.updateOne({ _id: last._id, userId: req.userId }, { $set: jobFields });
      const linked = await ProspectSearch.findOne({ _id: last._id }).lean();
      return res.json({ search: serialize(present(linked)), reused: true });
    }

    const search = await ProspectSearch.create({
      userId: req.userId,
      domain,
      companyName: String(body.companyName || '').trim().slice(0, 120),
      // From a Naukri job with no roles given: the job's recruiters and hiring manager.
      roles: cleanRoles(body.roles).length || !job ? cleanRoles(body.roles) : cleanRoles(rolesForJob(job.title)),
      force: !!body.force,
      steps: ProspectSearch.STEP_KEYS.map(key => ({ key })),
      ...jobFields,
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

// GET /api/prospects/suggested?limit=10 — "Worth searching": the few companies from
// Hiring now worth a people search, each with its score and the reasons for it. See
// lib/discovery/companyWorth.js. Reads only; outside signals come from their cache.
//
// A search costs one credit per role, so the list is cut to what your remaining free
// credits can pay for — suggesting ten companies you can only afford to search three
// of would just be noise.
router.get('/suggested', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || worth.RULES.maxShown, 1), worth.RULES.maxShown);
    const [scored, cfg, used, keys] = await Promise.all([
      worth.scoredCompanies(req.userId),
      DiscoveryConfig.findOne({ userId: req.userId }, { defaultRoles: 1 }).lean(),
      usage.getUsage(req.userId),
      configView(req.userId).then(v => v.keys),
    ]);
    const defaultRoles = (cfg && cfg.defaultRoles) || [];
    const paid = ['tavily', 'serpapi'].filter(p => keys[p]);
    const creditsLeft = paid.length
      ? paid.reduce((n, p) => n + Math.max(0, DiscoveryConfig.MONTHLY_CAPS[p] - (used[p] || 0)), 0)
      : null;

    let budget = creditsLeft;
    const suggestions = [];
    let cutForCredits = 0;
    for (const r of worth.pickSuggestions(scored, { limit })) {
      const roles = r.roles || defaultRoles;
      const cost = roles.length || 2; // no roles = two broad queries (lib/discovery/search.js)
      if (budget != null && cost > budget) { cutForCredits++; continue; }
      if (budget != null) budget -= cost;
      suggestions.push({ ...r, roles, cost });
    }
    const done = scored.filter(r => r.excluded === 'searched').slice(0, 20)
      .map(r => ({ key: r.key, company: r.company, domain: r.domain, score: r.score, searchedAt: r.searchedAt }));
    res.json({ suggestions, done, creditsLeft, cutForCredits, minScore: worth.RULES.minScore });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/suggested/refresh — look the shortlist up in the free outside
// sources now instead of waiting for the daily run. Answers still fresh in the cache
// are reused, so pressing it twice costs nothing.
router.post('/suggested/refresh', async (req, res) => {
  try {
    await inngest.send({ name: 'companies/enrich.start', data: { userId: String(req.userId) } });
    res.status(202).json({ ok: true });
  } catch (e) {
    res.status(503).json({ error: `Couldn't start the refresh: ${e.message}` });
  }
});

// POST /api/prospects/suggested/dismiss — { key, days? }: "Not worth it". Hides the
// suggestion for `days` (default 60). The company stays in Hiring now.
router.post('/suggested/dismiss', async (req, res) => {
  try {
    const key = String((req.body && req.body.key) || '').trim();
    if (!/^[dn]:[a-z0-9.-]{1,120}$/.test(key)) return res.status(400).json({ error: 'Bad key' });
    const days = Math.min(Math.max(parseInt(req.body.days, 10) || 60, 1), 365);
    const until = new Date(Date.now() + days * 24 * 3600 * 1000);
    await SuggestionDismissal.updateOne({ userId: req.userId, key }, { $set: { until }, $setOnInsert: { userId: req.userId, key } }, { upsert: true });
    res.json({ ok: true, key, until });
  } catch (err) { err500(res, err); }
});

// DELETE /api/prospects/suggested/dismiss/:key — undo "Not worth it".
router.delete('/suggested/dismiss/:key', async (req, res) => {
  try {
    await SuggestionDismissal.deleteOne({ userId: req.userId, key: String(req.params.key) });
    res.json({ ok: true });
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
      webAskedAt: (cp && cp.webAskedAt) || null,
      gravatarCheckedAt: (cp && cp.gravatarCheckedAt) || null,
      directory: (cp && cp.directory) || [],
      manual: cp && cp.manualPattern
        ? { pattern: cp.manualPattern, from: cp.manualFrom, example: cp.manualExample || null, at: cp.manualAt || null }
        : null,
      genericEmails: (cp && cp.genericEmails) || [],
      samples: bySource,
      contactsAtDomain: contacts.length,
      decision: {
        pattern: decision.pattern,
        confidence: decision.confidence,
        source: decision.source,
        runnerUp: decision.runnerUp,
        patterns: decision.patterns,
        auto: decision.auto || null,
        conflict: decision.conflict || null,
        conflictWith: decision.conflictWith || null,
        nameOnly: !!decision.nameOnly,
        catchAllRisk: !!decision.catchAllRisk,
      },
      defaultGuess: prior[0],
      ...(await formatTests(req.userId, domain)),
    });
  } catch (err) { err500(res, err); }
});

// PATCH /api/prospects/patterns/:domain
//   { githubOrg }                   sets the org by hand ('' clears)
//   { pattern }                     sets the company's email format yourself (null clears)
//   { exampleName, exampleEmail }   works the format out from a real address you found
// A format change re-labels every open prospect at once.
router.patch('/patterns/:domain', async (req, res) => {
  try {
    const domain = ep.normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Bad domain' });
    const body = req.body || {};
    if ('pattern' in body || 'exampleEmail' in body) {
      let set;
      if ('exampleEmail' in body) {
        const email = String(body.exampleEmail || '').trim().toLowerCase();
        const name = String(body.exampleName || '').trim().slice(0, 120);
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That doesn’t look like an email address' });
        if (ep.domainOfEmail(email) !== domain) return res.status(400).json({ error: `Use an address ending in @${domain}` });
        if (ep.isRoleAddress(email)) return res.status(400).json({ error: 'That’s a shared inbox, not a person — it doesn’t show the format' });
        if (!name) return res.status(400).json({ error: 'Type the person’s name too — the format is read from name + address' });
        const pattern = ep.inferPattern(name, email);
        if (!pattern) return res.status(400).json({ error: 'Can’t tell the format from that name and address — check the spelling, or pick the format from the list' });
        set = { manualPattern: pattern, manualFrom: 'example', manualExample: `${name} <${email}>`, manualAt: new Date() };
      } else if (body.pattern === null || body.pattern === '') {
        set = { manualPattern: null, manualFrom: null, manualExample: null, manualAt: null };
      } else {
        if (!ep.PATTERN_KEYS.includes(body.pattern)) return res.status(400).json({ error: 'Unknown format' });
        set = { manualPattern: body.pattern, manualFrom: 'list', manualExample: null, manualAt: new Date() };
      }
      await CompanyPattern.updateOne(
        { userId: req.userId, domain },
        { $set: set, $setOnInsert: { userId: req.userId, domain } },
        { upsert: true },
      );
      const r = await applyEmails(req.userId, domain);
      return res.json({ ok: true, pattern: set.manualPattern, from: set.manualFrom, people: r.people, withEmail: r.withEmail });
    }
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

// ── Test format: one real email to one person ──────────────────────────────

/** The latest test emails at a company, each with what happened to it. */
async function formatTests(userId, domain, limit = 10) {
  const [tests, settings] = await Promise.all([
    FormatTest.find({ userId, domain }).sort({ createdAt: -1 }).limit(limit).lean(),
    Settings.findOne({ userId }, { lastMailboxCheckAt: 1 }).lean(),
  ]);
  const lastMailboxCheckAt = (settings && settings.lastMailboxCheckAt) || null;
  if (!tests.length) return { tests: [], lastMailboxCheckAt };
  const ids = (list) => [...new Set(list.filter(isId))];
  const [contacts, jobs] = await Promise.all([
    Contact.find({ _id: { $in: ids(tests.map(t => t.contactId)) }, userId, deleted: { $ne: true } },
      { status: 1, bounceReason: 1, repliedAt: 1, lastSentAt: 1, failReason: 1, 'thread.direction': 1 }).lean(),
    SendJob.find({ _id: { $in: ids(tests.map(t => t.jobId).filter(Boolean)) }, userId }, { status: 1, items: 1 }).lean(),
  ]);
  const contactById = new Map(contacts.map(c => [String(c._id), c]));
  const jobById = new Map(jobs.map(j => [String(j._id), j]));
  const now = new Date();
  return {
    lastMailboxCheckAt,
    tests: tests.map(t => ({
      id: String(t._id), prospectId: t.prospectId, contactId: t.contactId, name: t.name, email: t.email,
      pattern: t.pattern, templateKey: t.templateKey, createdAt: t.createdAt, confirmedAt: t.confirmedAt,
      ...testStatus(t, contactById.get(t.contactId) || null, t.jobId ? jobById.get(t.jobId) || null : null, lastMailboxCheckAt, now),
    })),
  };
}

// POST /api/prospects/format-tests — { prospectId, pattern | email, template, attachResume? }
// Moves that one prospect to outreach with the address in that format and sends it a
// normal outreach email right away (same SendJob + Inngest path as Step 3, with every
// send-time guard). Whatever comes back is read off the contact (formatTests above).
router.post('/format-tests', requireOnboarded, async (req, res) => {
  try {
    const b = req.body || {};
    if (!isId(b.prospectId)) return res.status(400).json({ error: 'Pick a person' });
    const template = String(b.template || '').trim();
    if (!template) return res.status(400).json({ error: 'Pick a template' });

    const p = await Prospect.findOne({ _id: b.prospectId, userId: req.userId, ...BASE_FILTER }).lean();
    if (!p) return res.status(404).json({ error: 'Person not found' });
    const domain = p.domain;
    if (!OPEN.includes(p.status)) {
      // Someone whose earlier test hard-bounced can be tried again in another format —
      // the bounced contact stays in outreach as the record of that attempt.
      const view = p.status === 'moved' ? await formatTests(req.userId, domain, 50) : { tests: [] };
      const retry = view.tests.some(t => t.prospectId === String(p._id) && t.status === 'bounced');
      if (!retry) return res.status(409).json({ error: `${p.name} was already moved or discarded` });
    }
    const cp = await CompanyPattern.findOne({ userId: req.userId, domain }, { hasMx: 1 }).lean();
    if (cp && cp.hasMx === false) return res.status(400).json({ error: `${domain} can't receive email` });

    let email;
    let pattern;
    if (b.email) {
      email = String(b.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || ep.domainOfEmail(email) !== domain) {
        return res.status(400).json({ error: `Use an address ending in @${domain}` });
      }
      if (ep.isRoleAddress(email)) return res.status(400).json({ error: 'That’s a shared inbox — it can’t test a person’s format' });
      pattern = ep.inferPattern(p.name, email);
    } else {
      if (!ep.PATTERN_KEYS.includes(b.pattern)) return res.status(400).json({ error: 'Pick a format' });
      email = ep.generateEmail(p.name, b.pattern, domain);
      if (!email) return res.status(400).json({ error: `Can’t build ${b.pattern} from “${p.name}” — pick another person or format` });
      pattern = b.pattern;
    }

    const ctx = await loadRenderContext({ templateKey: template, userId: req.userId });
    if (!ctx.template) return res.status(400).json({ error: 'That template no longer exists' });
    const already = await Contact.findOne({ userId: req.userId, email, deleted: { $ne: true } }, { _id: 1 })
      .collation({ locale: 'en', strength: 2 }).lean();
    if (already) return res.status(409).json({ error: `${email} is already in your contacts — its result is there, so testing it again proves nothing new` });

    await Prospect.updateOne({ _id: p._id, userId: req.userId }, { $set: {
      email, emailPattern: pattern, emailSource: 'test', emailConfidence: null,
      status: 'ready', existingContactId: null, contactedAs: null, contactId: null, movedAt: null, note: '',
    } });
    const moved = await moveProspects(req.userId, [String(p._id)], template);
    const contactId = moved.contactIds.get(String(p._id));
    if (!contactId) {
      const why = moved.blocked ? 'that address is on your blocklist' : 'that address is already in your contacts';
      return res.status(409).json({ error: `Not sent — ${why}` });
    }

    // Approved, rendered and queued here rather than in Step 2/3: the test IS the review.
    const contact = await Contact.findOneAndUpdate(
      { _id: contactId, userId: req.userId },
      { $set: { approvalStatus: 'approved' } },
      { new: true },
    ).lean();
    const { subject, body } = renderTemplate(ctx.template, contact, ctx.sender);
    if (!subject || !body) {
      return res.status(400).json({ error: `The template rendered empty — ${p.name} was moved to outreach and can be sent from Step 2` });
    }
    const creds = await mailer.getSenderFor(req.userId);
    const job = await SendJob.create({
      userId: req.userId,
      items: [{ contactId, to: contact.email, name: contact.name, subject, body }],
      attachResume: !!b.attachResume,
      senderEmail: creds.email || '',
      senderName: ctx.sender.name || creds.name || '',
      senderAppPassword: creds.appPassword || '',
      sendMode: 'sequential',
    });
    let queueError = null;
    try {
      // Behind the Gmail limit like any other batch; the quota watcher starts it later.
      if (!await holdBehindQuota(job)) await inngest.send({ name: 'email/batch.start', data: { jobId: job.id.toString() } });
    } catch (err) {
      await SendJob.updateOne({ _id: job.id, userId: req.userId }, { status: 'cancelled' });
      queueError = `Could not queue the send: ${err.message}. ${p.name} is in outreach and can be sent from Step 2.`;
    }

    await FormatTest.create({
      userId: req.userId, domain, prospectId: String(p._id), contactId, jobId: job.id.toString(),
      name: p.name, email, pattern, templateKey: template,
    });
    const view = await formatTests(req.userId, domain);
    res.json({ ok: !queueError, error: queueError, ...view });
  } catch (err) { err500(res, err); }
});

// GET /api/prospects/:id/addresses — the address each format gives this person, for
// the Test format picker. Built by lib/emailPatterns.js so the browser never needs its
// own copy of the name rules.
router.get('/:id/addresses', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const p = await Prospect.findOne({ _id: req.params.id, userId: req.userId, ...BASE_FILTER }, { name: 1, domain: 1, knownEmail: 1 }).lean();
    if (!p) return res.status(404).json({ error: 'Person not found' });
    const addresses = {};
    for (const k of ep.PATTERN_KEYS) addresses[k] = ep.generateEmail(p.name, k, p.domain);
    res.json({ addresses, knownEmail: p.knownEmail && !ep.isRoleAddress(p.knownEmail) ? p.knownEmail : null });
  } catch (err) { err500(res, err); }
});

// POST /api/prospects/format-tests/:id/confirm — the test email didn't bounce (or got a
// reply): use its format for the whole company, as if set by hand.
router.post('/format-tests/:id/confirm', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const test = await FormatTest.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const view = await formatTests(req.userId, test.domain, 50);
    const t = view.tests.find(x => x.id === String(test._id));
    if (!t || !['no-bounce', 'replied'].includes(t.status)) {
      return res.status(409).json({ error: 'Wait until the email was sent and a mailbox check found no bounce' });
    }
    if (!test.pattern) return res.status(400).json({ error: 'That address fits none of the formats — set the format by hand instead' });
    const now = new Date();
    await CompanyPattern.updateOne(
      { userId: req.userId, domain: test.domain },
      { $set: { manualPattern: test.pattern, manualFrom: 'test', manualExample: `${test.name} <${test.email}>`, manualAt: now },
        $setOnInsert: { userId: req.userId, domain: test.domain } },
      { upsert: true },
    );
    await FormatTest.updateOne({ _id: test._id, userId: req.userId }, { $set: { confirmedAt: now } });
    const r = await applyEmails(req.userId, test.domain);
    res.json({ ok: true, pattern: test.pattern, confidence: r.decision.confidence, people: r.people, withEmail: r.withEmail });
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

/**
 * Move prospects into outreach as ordinary pending Contacts. Shared by POST /move and
 * the Test-format send (lib/formatTest.js).
 *
 * @returns {Promise<{moved: number, alreadyMoved: number, notReady: number, blocked: number,
 *                    duplicates: number, contactIds: Map<string, string>, existingContactIds: string[]}>}
 *          contactIds: prospect id → new contact id, for the ones moved
 *          existingContactIds: contacts that already had a moved row's address
 */
async function moveProspects(userId, ids, template) {
  const docs = await Prospect.find({ _id: { $in: ids }, userId, ...BASE_FILTER }).lean();
  const block = await loadBlocklistSets(userId);
  // The Naukri job behind each prospect's search, read now rather than copied onto
  // every prospect, so it is whatever the search says at move time.
  const searchIds = [...new Set(docs.map(d => d.searchId && String(d.searchId)).filter(Boolean))];
  const jobBySearch = new Map((searchIds.length
    ? await ProspectSearch.find({ _id: { $in: searchIds }, userId, naukriJobId: { $exists: true } }, { naukriJobId: 1, jobTitle: 1 }).lean()
    : []).map(s => [String(s._id), s]));

  const out = { moved: 0, alreadyMoved: 0, notReady: 0, blocked: 0, duplicates: 0 };
  const contactIds = new Map();
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
      linkedin: d.linkedin || null,
      ...(() => {
        const s = d.searchId && jobBySearch.get(String(d.searchId));
        return s ? { jobTitle: s.jobTitle || '', naukriJobId: s.naukriJobId } : {};
      })(),
    });
  }

  const { created } = rows.length ? await importContacts(rows, userId, { fillBlanks: true }) : { created: [] };
  const createdByEmail = new Map(created.map(c => [c.email, String(c._id)]));

  // Rows importContacts skipped already existed as contacts (created since the
  // last label refresh) — record which, rather than moving them.
  const skippedEmails = rows.filter(r => !createdByEmail.has(r.email.trim().toLowerCase())).map(r => r.email.trim().toLowerCase());
  const existing = skippedEmails.length
    ? await Contact.find({ userId, email: { $in: skippedEmails }, deleted: { $ne: true } }, { email: 1 })
      .collation({ locale: 'en', strength: 2 }).lean()
    : [];
  const existingByEmail = new Map(existing.map(c => [c.email.toLowerCase(), String(c._id)]));

  const now = new Date();
  const ops = rows.map(r => {
    const email = r.email.trim().toLowerCase();
    const contactId = createdByEmail.get(email);
    if (contactId) {
      out.moved++;
      contactIds.set(r._prospectId, contactId);
      return { updateOne: { filter: { _id: r._prospectId, userId }, update: { $set: { status: 'moved', movedAt: now, contactId } } } };
    }
    out.duplicates++;
    return { updateOne: { filter: { _id: r._prospectId, userId }, update: { $set: { existingContactId: existingByEmail.get(email) || null } } } };
  });
  if (ops.length) await Prospect.bulkWrite(ops, { ordered: false });

  return { ...out, contactIds, existingContactIds: [...existingByEmail.values()] };
}

// POST /api/prospects/move — { ids, template }. Creates pending contacts (Step 2
// still approves them). Skips, and reports, anything not safe to move.
router.post('/move', async (req, res) => {
  try {
    const ids = idList(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: `Expected 1–${MAX_IDS} prospect ids` });
    const template = String((req.body && req.body.template) || '');
    const { contactIds, existingContactIds, ...out } = await moveProspects(req.userId, ids, template);
    // New contacts plus the ones these people already were, for callers that
    // carry straight on into a send (the Action Center).
    res.json({ ok: true, ...out, contactIds: [...new Set([...contactIds.values(), ...existingContactIds])] });
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
