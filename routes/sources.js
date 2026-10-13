// /api/sources — the Leads sources beyond the LinkedIn harvester: Paste text, HN
// "Who is hiring?" and the hiring-post finder (lib/sources/). Every source ends in
// the ordinary Leads import, so nothing here writes a Lead itself: paste returns a
// preview the page saves through POST /api/leads/import, and the automatic sources
// run in Inngest (lib/sources/inngest.js).

const express = require('express');
const { inngest } = require('../inngest');
const Lead = require('../models/Lead');
const SourceConfig = require('../models/SourceConfig');
const SourceRun = require('../models/SourceRun');
const DiscoveryConfig = require('../models/DiscoveryConfig');
const usage = require('../lib/discovery/usage');
const { previewPaste, MAX_TEXT } = require('../lib/sources/paste');
const { activeRun } = require('../lib/sources/run');

const router = express.Router();
const err500 = (res, err) => res.status(500).json({ error: err.message });

const RUNS_SHOWN = 7;

/** A list of short strings from an array or a comma-separated string. */
function cleanList(raw, { max = 10, len = 60 } = {}) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const seen = new Set();
  return list.map(r => String(r || '').replace(/\s+/g, ' ').trim().slice(0, len))
    .filter(r => r && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()))
    .slice(0, max);
}

async function configView(userId) {
  const [cfg, keys, used] = await Promise.all([
    SourceConfig.getForUser(userId),
    usage.loadKeys(userId),
    usage.getUsage(userId),
  ]);
  return {
    config: cfg.toJSON(),
    hasSearchKey: !!(keys.tavily || keys.serpapi),
    tavily: { used: (used && used.tavily) || 0, cap: DiscoveryConfig.MONTHLY_CAPS.tavily },
    maxPerDay: SourceConfig.MAX_PER_DAY,
  };
}

// GET /api/sources/config
router.get('/config', async (req, res) => {
  try { res.json(await configView(req.userId)); } catch (err) { err500(res, err); }
});

// PUT /api/sources/config — any of { roles, locations, maxYears, webOn, webPerDay, hnOn }
router.put('/config', async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    if (b.roles !== undefined) set.roles = cleanList(b.roles, { max: 8 });
    if (b.locations !== undefined) set.locations = cleanList(b.locations, { max: 10 }).map(l => l.toLowerCase());
    if (b.maxYears !== undefined) {
      const n = b.maxYears === null || b.maxYears === '' ? null : Number(b.maxYears);
      if (n !== null && !(Number.isFinite(n) && n >= 0 && n <= 40)) return res.status(400).json({ error: 'Max years must be 0–40' });
      set.maxYears = n;
    }
    if (b.webPerDay !== undefined) {
      const n = Math.round(Number(b.webPerDay));
      if (!(n >= 1 && n <= SourceConfig.MAX_PER_DAY)) return res.status(400).json({ error: `Searches per day must be 1–${SourceConfig.MAX_PER_DAY}` });
      set.webPerDay = n;
    }
    if (b.webOn !== undefined) set.webOn = !!b.webOn;
    if (b.hnOn !== undefined) set.hnOn = !!b.hnOn;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to save' });
    await SourceConfig.getForUser(req.userId); // created with the Discover roles first
    await SourceConfig.updateOne({ userId: req.userId }, { $set: set });
    res.json(await configView(req.userId));
  } catch (err) { err500(res, err); }
});

// GET /api/sources/runs — the last runs of each automatic source, newest first.
router.get('/runs', async (req, res) => {
  try {
    const out = {};
    for (const source of ['web', 'hn']) {
      out[source] = (await SourceRun.find({ userId: req.userId, source })
        .sort({ startedAt: -1 }).limit(RUNS_SHOWN).lean())
        .map(({ _id, __v, userId, ...r }) => ({ id: String(_id), ...r }));
    }
    res.json(out);
  } catch (err) { err500(res, err); }
});

// POST /api/sources/run — { source: 'web' | 'hn' }. Starts a run now, in Inngest.
router.post('/run', async (req, res) => {
  try {
    const source = req.body && req.body.source;
    if (!['web', 'hn'].includes(source)) return res.status(400).json({ error: 'Unknown source' });
    if (await activeRun(req.userId, source)) return res.status(409).json({ error: 'Already running' });
    if (source === 'web') {
      const view = await configView(req.userId);
      if (!view.hasSearchKey) return res.status(400).json({ error: 'Add a free Tavily key in Settings first' });
      if (!view.config.roles.length) return res.status(400).json({ error: 'Add the roles you want first' });
    }
    try {
      await inngest.send({ name: `sources/${source}.start`, data: { userId: String(req.userId), trigger: 'manual' } });
    } catch (e) {
      return res.status(503).json({ error: `Couldn't start it: ${e.message}` });
    }
    res.status(202).json({ ok: true });
  } catch (err) { err500(res, err); }
});

// POST /api/sources/paste/preview — { text }. Finds every email in the text and reads
// the message around it. Saves nothing; rows already on your board are marked.
router.post('/paste/preview', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '');
    if (!text.trim()) return res.status(400).json({ error: 'Paste some text first' });
    const cfg = await SourceConfig.getForUser(req.userId);
    const target = { roles: cfg.roles, locations: cfg.locations, maxYears: cfg.maxYears };
    const out = await previewPaste(text, { userId: req.userId, target });

    const keys = [...new Set(out.leads.flatMap(l => l.emails.map(e => `e:${e}`)))];
    const stored = new Set((await Lead.find(
      { userId: req.userId, dedupeKey: { $in: keys }, deleted: { $ne: true } }, { dedupeKey: 1 },
    ).lean()).map(d => d.dedupeKey));
    const leads = out.leads.map(l => ({ ...l, existing: l.emails.filter(e => stored.has(`e:${e}`)) }));

    res.json({ ...out, leads, maxText: MAX_TEXT });
  } catch (err) { err500(res, err); }
});

module.exports = router;
