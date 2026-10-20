const express = require('express');
const ScrapeRun = require('../models/ScrapeRun');
const NaukriRun = require('../models/NaukriRun');
const { labelOf, platformOfDoc } = require('../lib/platforms');

const router = express.Router();

// Worker runs for the floating progress panel (client/src/components/
// SendJobWidget.tsx): the LinkedIn harvest and every job platform's runs,
// beside the email send jobs it already shows. Read-only and indexed — the
// panel calls it only while a run is showing, or when /api/pulse's `runs`
// stamp moves.
//
// "Active" is queued or running. A queued run older than QUEUED_MAX_MS is
// left out: the worker is off (the Mac asleep), and a card that sits there
// for a day only teaches you to ignore the panel. Runs that finished within
// RECENT_MS are included once, so the card can show how it ended.
const ACTIVE = ['queued', 'running'];
const QUEUED_MAX_MS = 6 * 3600_000;
const RECENT_MS = 2 * 60_000;
const BASE = { deleted: { $ne: true } };

const KIND_LABEL = { harvest: 'Harvest', apply: 'Apply', refresh: 'Refresh profile', track: 'Check replies', probe: 'Probe' };

function scrapeCard(r) {
  const p = r.progress || {};
  return {
    id: String(r._id), source: 'linkedin', label: 'LinkedIn', kind: 'harvest', kindLabel: 'Harvest',
    status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt,
    detail: p.currentQuery || '',
    done: p.searchesDone || 0, total: p.searchesTotal || (r.queries || []).length || 0, unit: 'searches',
    counts: r.status === 'running' || !r.finishedAt
      ? { found: p.rendered || 0, hiring: p.hiring || 0, new: p.new || 0 }
      : { found: (r.stats && r.stats.rendered) || 0, hiring: (r.stats && r.stats.hiring) || 0, new: (r.stats && r.stats.new) || 0 },
    error: r.error || null,
    link: '/leads',
  };
}

function platformCard(r) {
  const p = r.progress || {};
  const s = r.stats || {};
  const platform = platformOfDoc(r);
  const live = r.status === 'running';
  return {
    id: String(r._id), source: platform, label: labelOf(platform), kind: r.kind,
    kindLabel: r.kind === 'apply' && r.dryRun ? 'Dry run apply' : (KIND_LABEL[r.kind] || r.kind),
    status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt,
    detail: p.label && p.label !== 'done' ? p.label : '',
    done: p.page || 0, total: p.pagesTotal || 0, unit: r.kind === 'apply' ? 'jobs' : 'pages',
    counts: live
      ? { found: p.found || 0, new: p.new || 0, applied: p.applied || 0, skipped: p.skipped || 0, failed: p.failed || 0 }
      : { found: s.found || 0, new: s.new || 0, applied: s.applied || 0, skipped: s.skipped || 0, failed: s.failed || 0,
        rehearsed: s.rehearsed || 0, tracked: s.tracked || 0 },
    error: r.error || null,
    link: platform === 'naukri' ? '/job-platforms?platform=naukri' : `/job-platforms?platform=${platform}`,
  };
}

// The query both this route and the pulse use, so they cannot disagree.
function activeFilter(userId, now = Date.now()) {
  return {
    userId, ...BASE,
    $or: [
      { status: 'running' },
      { status: 'queued', createdAt: { $gte: new Date(now - QUEUED_MAX_MS) } },
    ],
  };
}

// GET /api/runs/active — { runs: [...] }, newest first.
router.get('/active', async (req, res) => {
  try {
    const now = Date.now();
    const recent = { userId: req.userId, ...BASE, status: { $nin: ACTIVE }, finishedAt: { $gte: new Date(now - RECENT_MS) } };
    const [sa, sr, na, nr] = await Promise.all([
      ScrapeRun.find(activeFilter(req.userId, now)).sort({ createdAt: -1 }).limit(5).lean(),
      ScrapeRun.find(recent).sort({ finishedAt: -1 }).limit(3).lean(),
      NaukriRun.find(activeFilter(req.userId, now)).sort({ createdAt: -1 }).limit(10).lean(),
      NaukriRun.find(recent).sort({ finishedAt: -1 }).limit(5).lean(),
    ]);
    const runs = [...sa, ...sr].map(scrapeCard).concat([...na, ...nr].map(platformCard))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    res.set('Cache-Control', 'no-store');
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.activeFilter = activeFilter;
