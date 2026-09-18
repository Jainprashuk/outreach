const express = require('express');
const ScrapeRun = require('../models/ScrapeRun');
const ScrapeSchedule = require('../models/ScrapeSchedule');
const ScrapeWorker = require('../models/ScrapeWorker');
const { importLeads, isUsableSourceLead } = require('../lib/leadImport');
const { dueOccurrence, nextOccurrence, parseTime } = require('../lib/scrapeSchedule');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };
const ACTIVE = ['queued', 'running'];

// MAX_SEARCHES in scroll_harvest.py. The cap is deliberate — see TRACK-SCROLL.md.
const MAX_QUERIES = 20;
// A worker polls every 20s; 90s of silence means the Mac slept or the process died.
const ONLINE_MS = 90_000;
// A claimed run whose worker vanished mid-harvest. Longer than the longest
// plausible run (20 searches x 8 scrolls plus page loads is well under an hour).
const STALE_RUN_MS = 90 * 60_000;

const serialize = (doc) => {
  if (!doc) return null;
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

// `limit` defaults to the per-run cap. The worker's config.json catalogue is
// passed a larger limit: it is the list you PICK from, not a run's query set,
// so capping it at 20 would silently hide queries from the portal.
const cleanQueries = (input, limit = MAX_QUERIES) => {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const q of input) {
    const v = String(q == null ? '' : q).trim().replace(/\s+/g, ' ');
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.slice(0, limit);
};

// A run left 'running' by a worker that was killed mid-harvest would block the
// queue forever, since /claim only ever starts one at a time.
const failStaleRuns = (userId) =>
  ScrapeRun.updateMany(
    { ...(userId ? { userId } : {}), status: 'running', claimedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) }, ...BASE_FILTER },
    { $set: { status: 'failed', error: 'Worker stopped responding mid-run', finishedAt: new Date() } }
  );

const blockedUntilOf = (worker) => {
  const until = worker && worker.blockedUntil ? new Date(worker.blockedUntil) : null;
  return until && until > new Date() ? until : null;
};

// ── Owner endpoints ────────────────────────────────────────────────────────

// IMPORTANT: /status and /schedule must be defined before /:id, or Express
// matches them as an id.

// GET /api/scrapes/status — one call drives the whole panel. The worker fields
// exist so the UI can say "your Mac is asleep, this will run at 9:25am" BEFORE
// you trigger a run, rather than leaving a queued row looking broken.
router.get('/status', async (req, res) => {
  try {
    await failStaleRuns(req.userId);
    const [worker, schedule, activeRun, lastRun] = await Promise.all([
      ScrapeWorker.getForUser(req.userId),
      ScrapeSchedule.getForUser(req.userId),
      ScrapeRun.findOne({ userId: req.userId, status: { $in: ACTIVE }, ...BASE_FILTER }).sort({ createdAt: 1 }).lean(),
      ScrapeRun.findOne({ userId: req.userId, status: { $nin: ACTIVE }, ...BASE_FILTER }).sort({ createdAt: -1 }).lean(),
    ]);

    const lastSeenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt) : null;
    res.json({
      activeRun: serialize(activeRun),
      lastRun: serialize(lastRun),
      worker: {
        everSeen: !!lastSeenAt,
        online: !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_MS,
        lastSeenAt,
        host: worker.host || '',
        chromeUp: !!worker.chromeUp,
        linkedinLoggedIn: !!worker.linkedinLoggedIn,
        nextWakeAt: worker.nextWakeAt || null,
      },
      schedule: schedule.toJSON(),
      nextOccurrence: nextOccurrence(schedule, new Date()),
      defaultQueries: worker.defaultQueries || [],
      blockedUntil: blockedUntilOf(worker),
      blockedReason: worker.blockedReason || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/schedule', async (req, res) => {
  try {
    const schedule = await ScrapeSchedule.getForUser(req.userId);
    res.json({ schedule: schedule.toJSON(), nextOccurrence: nextOccurrence(schedule, new Date()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/schedule', async (req, res) => {
  try {
    const { enabled, days, time, timezone, queries, catchUpHours } = req.body || {};
    const schedule = await ScrapeSchedule.getForUser(req.userId);

    if (time !== undefined) {
      if (!parseTime(time)) return res.status(400).json({ error: 'time must be HH:mm' });
      schedule.time = String(time).trim();
    }
    if (days !== undefined) {
      const clean = [...new Set((Array.isArray(days) ? days : []).map(Number))]
        .filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (clean.length === 0) return res.status(400).json({ error: 'Pick at least one day' });
      schedule.days = clean;
    }
    if (queries !== undefined) schedule.queries = cleanQueries(queries);
    if (timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: String(timezone) }); }
      catch (_) { return res.status(400).json({ error: `Unknown timezone: ${timezone}` }); }
      schedule.timezone = String(timezone);
    }
    if (catchUpHours !== undefined) {
      const n = Number(catchUpHours);
      if (!Number.isFinite(n) || n < 0 || n > 24) {
        return res.status(400).json({ error: 'catchUpHours must be between 0 and 24' });
      }
      schedule.catchUpHours = n;
    }
    if (enabled !== undefined) {
      if (enabled && schedule.queries.length === 0) {
        return res.status(400).json({ error: 'Pick at least one query before enabling the schedule' });
      }
      schedule.enabled = !!enabled;
      // Turning the schedule on must not immediately fire a past occurrence
      // from earlier today — that would spend the day's one safe run the
      // instant you saved the form.
      if (enabled) schedule.lastFiredAt = new Date();
    }

    await schedule.save();
    res.json({ schedule: schedule.toJSON(), nextOccurrence: nextOccurrence(schedule, new Date()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scrapes — run history
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const [runs, total] = await Promise.all([
      ScrapeRun.find({ userId: req.userId, ...BASE_FILTER }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ScrapeRun.countDocuments({ userId: req.userId, ...BASE_FILTER }),
    ]);
    res.json({ runs: runs.map(serialize), total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrapes — queue a manual run. Deliberately allowed while the worker
// is offline: the queue is what lets you trigger from a phone with the Mac shut.
router.post('/', async (req, res) => {
  try {
    const queries = cleanQueries((req.body || {}).queries);
    if (queries.length === 0) return res.status(400).json({ error: 'Pick at least one query' });

    const worker = await ScrapeWorker.getForUser(req.userId);
    const blockedUntil = blockedUntilOf(worker);
    if (blockedUntil) {
      return res.status(423).json({
        error: 'LinkedIn showed a checkpoint on the last run. Harvesting is paused until '
             + blockedUntil.toISOString() + ' — do not work around this.',
        blockedUntil,
      });
    }

    await failStaleRuns(req.userId);
    const active = await ScrapeRun.findOne({ userId: req.userId, status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
    if (active) {
      return res.status(409).json({ error: 'A scrape is already ' + active.status, run: serialize(active) });
    }

    const run = await ScrapeRun.create({ userId: req.userId, queries, trigger: 'manual' });
    res.status(201).json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    // Only a queued run can be cancelled — a running one is a live Chrome
    // session on the Mac that this process cannot reach.
    const run = await ScrapeRun.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId, status: 'queued', ...BASE_FILTER },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
      { new: true }
    );
    if (!run) return res.status(404).json({ error: 'No queued run with that id' });
    res.json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Worker endpoints (X-Worker-Secret, exact paths in server.js) ────────────

// POST /api/scrapes/claim — heartbeat, materialise a due scheduled run, then
// claim at most one queued run. All three in one round trip because the worker
// polls every 20s and each call is a serverless cold-start candidate.
router.post('/claim', async (req, res) => {
  try {
    const { host, chromeUp, linkedinLoggedIn, nextWakeAt, defaultQueries } = req.body || {};

    const worker = await ScrapeWorker.getForUser(req.userId);
    worker.lastSeenAt = new Date();
    if (host !== undefined) worker.host = String(host).slice(0, 200);
    if (chromeUp !== undefined) worker.chromeUp = !!chromeUp;
    if (linkedinLoggedIn !== undefined) worker.linkedinLoggedIn = !!linkedinLoggedIn;
    if (nextWakeAt !== undefined) {
      const d = nextWakeAt ? new Date(nextWakeAt) : null;
      worker.nextWakeAt = d && !isNaN(d.getTime()) ? d : null;
    }
    if (Array.isArray(defaultQueries)) worker.defaultQueries = cleanQueries(defaultQueries, 100);
    await worker.save();

    if (blockedUntilOf(worker)) {
      return res.json({ run: null, blockedUntil: worker.blockedUntil });
    }

    await failStaleRuns();

    // Materialise a scheduled run if one is due and nothing is already active.
    const schedule = await ScrapeSchedule.getForUser(req.userId);
    const due = dueOccurrence(schedule, new Date());
    if (due) {
      const active = await ScrapeRun.findOne({ status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
      if (!active) {
        await ScrapeRun.create({ queries: cleanQueries(schedule.queries), trigger: 'scheduled' });
      }
      // Stamp lastFiredAt to the OCCURRENCE, not to now, so a late catch-up
      // doesn't drag tomorrow's slot forward. Stamped even when a run was
      // already active, so a busy slot is spent rather than retried in a loop.
      schedule.lastFiredAt = due;
      await schedule.save();
    }

    const run = await ScrapeRun.findOneAndUpdate(
      { status: 'queued', ...BASE_FILTER },
      { $set: { status: 'running', claimedAt: new Date(), workerHost: String(host || '').slice(0, 200) } },
      { sort: { createdAt: 1 }, new: true }
    );

    res.json({ run: run ? run.toJSON() : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrapes/ingest — chunked lead delivery from the worker. Goes through
// the same lib/leadImport.js as the manual JSON upload, so dedupeKey gives
// re-scrapes idempotency for free.
router.post('/ingest', async (req, res) => {
  try {
    const { runId, leads } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads must be an array' });

    const run = await ScrapeRun.findOne({ _id: runId, ...BASE_FILTER });
    if (!run) return res.status(404).json({ error: 'No such run' });

    const source = leads.filter(isUsableSourceLead);
    const result = await importLeads(source, { ignoredRows: leads.length - source.length, userId: req.userId });

    // $inc rather than save() — chunks arrive sequentially but the run doc may
    // also be read by /status between them.
    await ScrapeRun.updateOne({ _id: runId }, {
      $inc: {
        'importResult.created':        result.created.length,
        'importResult.skipped':        result.skipped,
        'importResult.updated':        result.updated,
        'importResult.skippedInBatch': result.skippedInBatch,
      },
    });

    res.json({
      created: result.created.length,
      skipped: result.skipped,
      updated: result.updated,
      skippedInBatch: result.skippedInBatch,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrapes/progress — live per-search progress while a harvest runs.
// Deliberately a plain overwrite with no history: the worker is the only writer,
// events arrive in order, and a dropped update is corrected by the next one.
// The worker never blocks the harvest on this call for the same reason.
router.post('/progress', async (req, res) => {
  try {
    const { runId, progress } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!progress || typeof progress !== 'object') {
      return res.status(400).json({ error: 'progress object is required' });
    }

    const perQuery = Array.isArray(progress.perQuery)
      ? progress.perQuery.slice(0, MAX_QUERIES).map(q => ({
          query:    String(q && q.query || '').slice(0, 300),
          rendered: Number(q && q.rendered) || 0,
          hiring:   Number(q && q.hiring) || 0,
          new:      Number(q && q.new) || 0,
        }))
      : [];

    // Only while the run is actually running — a late event must not resurrect
    // the progress block of a run that already failed or was cancelled.
    const run = await ScrapeRun.findOneAndUpdate(
      { _id: runId, status: 'running', ...BASE_FILTER },
      { $set: { progress: {
          currentQuery:  String(progress.currentQuery || '').slice(0, 300),
          searchesDone:  Number(progress.searchesDone) || 0,
          searchesTotal: Number(progress.searchesTotal) || 0,
          rendered:      Number(progress.rendered) || 0,
          hiring:        Number(progress.hiring) || 0,
          new:           Number(progress.new) || 0,
          perQuery,
          updatedAt:     new Date(),
        } } },
      { new: true, projection: { progress: 1, status: 1 } }
    );
    if (!run) return res.status(404).json({ error: 'No running run with that id' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrapes/finish — terminal state for a run.
router.post('/finish', async (req, res) => {
  try {
    const { runId, status, stats, error, exitCode } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!['done', 'failed', 'blocked'].includes(status)) {
      return res.status(400).json({ error: 'status must be done, failed or blocked' });
    }

    const update = { status, finishedAt: new Date() };
    if (error !== undefined) update.error = error ? String(error).slice(0, 2000) : null;
    if (exitCode !== undefined) update.exitCode = Number.isFinite(exitCode) ? exitCode : null;
    if (stats && typeof stats === 'object') {
      update.stats = {
        rendered: Number(stats.rendered) || 0,
        hiring:   Number(stats.hiring) || 0,
        new:      Number(stats.new) || 0,
        seen:     Number(stats.seen) || 0,
        searches: Number(stats.searches) || 0,
      };
    }

    const run = await ScrapeRun.findOneAndUpdate({ _id: runId, ...BASE_FILTER }, { $set: update }, { new: true });
    if (!run) return res.status(404).json({ error: 'No such run' });

    // A checkpoint means LinkedIn challenged the session. TRACK-SCROLL.md is
    // explicit that the answer is to stop for a week, so the block lives here
    // rather than in the worker — a restarted worker must not be able to
    // shrug it off, and neither must the schedule.
    if (status === 'blocked') {
      const worker = await ScrapeWorker.getForUser(req.userId);
      worker.blockedUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      worker.blockedReason = 'LinkedIn showed a checkpoint during a harvest';
      await worker.save();
    }

    res.json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
