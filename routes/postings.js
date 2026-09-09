const express = require('express');
const JobPosting = require('../models/JobPosting');
const JobBoard = require('../models/JobBoard');
const Settings = require('../models/Settings');
const boards = require('../lib/boards');
const { syncAllBoards, MASS_CLOSE_WARN } = require('../lib/postingSync');

const router = express.Router();

// .lean() skips schema defaults, so rows written before a field existed come back
// with the key missing entirely. Normalise here rather than making every caller
// defend against undefined.
const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  if (!Array.isArray(obj.locations)) obj.locations = [];
  if (!Array.isArray(obj.applyHistory)) obj.applyHistory = [];
  if (!obj.applyStatus) obj.applyStatus = 'not-applied';
  if (!obj.listingStatus) obj.listingStatus = 'open';
  if (obj.appliedAt === undefined) obj.appliedAt = null;
  if (obj.appliedVia === undefined) obj.appliedVia = null;
  if (typeof obj.applyNote !== 'string') obj.applyNote = '';
  if (typeof obj.seenCount !== 'number') obj.seenCount = 0;
  if (typeof obj.closeCount !== 'number') obj.closeCount = 0;
  return obj;
};

const serializeBoard = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  if (!obj.lastSyncStatus) obj.lastSyncStatus = 'never';
  if (typeof obj.consecutiveFailures !== 'number') obj.consecutiveFailures = 0;
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

// Escape before putting user text in a RegExp — otherwise a search for "c++"
// is a syntax error rather than a search.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Postings ────────────────────────────────────────────────────────────────
// Specific routes are declared before /:id, or '/meta' would be read as an id.

// GET /api/postings/meta — the header numbers, without shipping every row.
router.get('/meta', async (_req, res) => {
  try {
    const settings = await Settings.findOne({}, { lastPostingSyncAt: 1, postingSyncLockAt: 1 }).lean();
    const lastSyncAt = (settings && settings.lastPostingSyncAt) || null;
    const lockAt = (settings && settings.postingSyncLockAt) || null;

    const [open, closed, tracked, newSinceLastSync] = await Promise.all([
      JobPosting.countDocuments({ ...BASE_FILTER, listingStatus: 'open' }),
      JobPosting.countDocuments({ ...BASE_FILTER, listingStatus: 'closed' }),
      JobPosting.countDocuments({ ...BASE_FILTER, applyStatus: { $ne: 'not-applied' } }),
      lastSyncAt
        ? JobPosting.countDocuments({ ...BASE_FILTER, firstSeenAt: { $gte: lastSyncAt } })
        : Promise.resolve(0),
    ]);

    res.json({
      lastSyncAt,
      previousSyncAt: null, // only a run report knows this; kept for shape parity
      cronConfigured: !!process.env.CRON_SECRET,
      syncRunning: !!lockAt,
      counts: { open, closed, tracked, newSinceLastSync },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Boards ──────────────────────────────────────────────────────────────────

router.get('/boards', async (_req, res) => {
  try {
    const rows = await JobBoard.find(BASE_FILTER).sort({ createdAt: 1 }).lean();
    res.json({ boards: rows.map(serializeBoard) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/postings/boards/preview — validate a token BEFORE adding it, through
// the same adapter the sync uses, writing nothing. A typo costs a 404 message
// rather than a board that silently never returns anything.
router.post('/boards/preview', async (req, res) => {
  try {
    const { source, token } = req.body || {};
    if (!boards.isSource(source)) {
      return res.status(400).json({ error: `source must be one of: ${boards.SOURCES.join(', ')}` });
    }
    const clean = boards.normaliseToken(token);
    if (!boards.isValidToken(clean)) {
      return res.status(400).json({ error: 'That does not look like a board token' });
    }

    const result = await boards.fetchBoard(source, clean, {});
    const sample = result.postings.slice(0, 5).map(p => ({ title: p.title, location: p.location }));
    // Greenhouse is the only source that names the company; for the others the
    // slug is the best suggestion we can honestly make.
    const suggestedLabel =
      (result.postings[0] && result.postings[0].company) || boards.titleCaseSlug(clean);

    res.json({
      kind: result.kind,
      httpStatus: result.httpStatus,
      token: clean,
      count: result.raw.count || 0,
      filtered: result.raw.filtered || 0,
      sample,
      suggestedLabel,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/boards', async (req, res) => {
  try {
    const { source, token, label } = req.body || {};
    if (!boards.isSource(source)) {
      return res.status(400).json({ error: `source must be one of: ${boards.SOURCES.join(', ')}` });
    }
    const clean = boards.normaliseToken(token);
    if (!boards.isValidToken(clean)) {
      return res.status(400).json({ error: 'That does not look like a board token' });
    }

    // Adding the same board twice would double every one of its postings, so
    // this is checked in the application layer (there is no unique index — a
    // soft-deleted board has to be re-addable).
    const existing = await JobBoard.findOne({ source, token: clean }).lean();
    if (existing && existing.deleted !== true) {
      return res.status(409).json({ error: 'That board is already tracked', board: serializeBoard(existing) });
    }
    if (existing) {
      // Revive rather than insert a second row, so its postings and their
      // tracking history reconnect to it.
      const revived = await JobBoard.findByIdAndUpdate(
        existing._id,
        {
          $set: {
            deleted: false, deletedAt: null, enabled: true,
            label: boards.normText(label) || existing.label || boards.titleCaseSlug(clean),
          },
        },
        { new: true }
      );
      return res.status(201).json({ board: revived, revived: true });
    }

    const board = await JobBoard.create({
      source, token: clean,
      label: boards.normText(label) || boards.titleCaseSlug(clean),
    });
    res.status(201).json({ board });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/boards/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body && req.body.label !== undefined) patch.label = boards.normText(req.body.label);
    if (req.body && req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    const board = await JobBoard.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!board) return res.status(404).json({ error: 'Board not found' });
    res.json({ board });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/postings/boards/:id?postings=keep|delete
// Defaults to keeping the postings: they may carry your application history,
// which is yours and unrelated to whether you still watch the board.
router.delete('/boards/:id', async (req, res) => {
  try {
    const board = await JobBoard.findById(req.params.id);
    if (!board || board.deleted === true) return res.status(404).json({ error: 'Board not found' });

    let postingsDeleted = 0;
    if (req.query.postings === 'delete') {
      const out = await JobPosting.updateMany(
        { source: board.source, boardToken: board.token, deleted: { $ne: true } },
        { $set: { deleted: true, deletedAt: new Date() } }
      );
      postingsDeleted = out.modifiedCount || 0;
    }

    board.deleted = true;
    board.deletedAt = new Date();
    board.enabled = false;
    await board.save();

    res.json({ ok: true, board, postingsDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync ────────────────────────────────────────────────────────────────────
// POST /api/postings/sync
// Always 200 when the run was attempted. Per-board failures live in the report,
// not in the HTTP status — one bad token must not hide four good boards. The
// "already running" case is also a 200 with ok:false, because it is a normal
// outcome and the client's apiFetch discards status codes anyway.
router.post('/sync', async (req, res) => {
  try {
    const { boardIds, dryRun } = req.body || {};
    const report = await syncAllBoards({
      boardIds: Array.isArray(boardIds) ? boardIds.map(String) : null,
      dryRun: !!dryRun,
    });
    res.json({ ...report, massCloseWarnThreshold: MASS_CLOSE_WARN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Posting list + tracking ─────────────────────────────────────────────────

// GET /api/postings — defaults to open postings only, because one board can be
// 600+ rows and the page filters client-side.
router.get('/', async (req, res) => {
  try {
    const { listingStatus, applyStatus, source, boardToken, q, ids, page, limit } = req.query;
    const filter = { ...BASE_FILTER };

    if (listingStatus && listingStatus !== 'all') filter.listingStatus = listingStatus;
    else if (!listingStatus) filter.listingStatus = 'open';

    if (applyStatus && applyStatus !== 'all') {
      filter.applyStatus = applyStatus === 'tracked' ? { $ne: 'not-applied' } : applyStatus;
    }
    if (source && source !== 'all') filter.source = source;
    if (boardToken) filter.boardToken = boardToken;
    if (ids) filter._id = { $in: String(ids).split(',').filter(Boolean) };
    if (q) {
      const rx = new RegExp(escapeRegExp(String(q).trim()), 'i');
      filter.$or = [{ title: rx }, { company: rx }, { department: rx }, { location: rx }];
    }

    const query = JobPosting.find(filter).sort({ postedAt: -1, firstSeenAt: -1 }).lean();

    if (page && limit) {
      const p = Math.max(1, parseInt(page, 10));
      const l = Math.min(500, Math.max(1, parseInt(limit, 10)));
      const [total, rows] = await Promise.all([
        JobPosting.countDocuments(filter),
        query.skip((p - 1) * l).limit(l),
      ]);
      return res.json({
        postings: rows.map(serialize), total, page: p, limit: l, pages: Math.ceil(total / l),
      });
    }

    const rows = await query;
    res.json(rows.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Source-owned fields (title, company, url, listingStatus, postedAt) are
// deliberately absent: they are the board's truth, and the next sync would
// silently revert an edit to them, which is worse than refusing it.
const ALLOWED_PATCH = ['applyStatus', 'applyNote', 'appliedVia'];

const pickPatch = (src) => {
  const patch = {};
  for (const key of ALLOWED_PATCH) {
    if (src[key] !== undefined) patch[key] = src[key];
  }
  return patch;
};

const buildOp = (patch, note, prev) => {
  const op = { $set: { ...patch } };
  if (patch.applyStatus) {
    op.$push = {
      applyHistory: { status: patch.applyStatus, changedAt: new Date(), note: note || 'Manual update' },
    };
    if (patch.applyStatus === 'not-applied') op.$set.appliedAt = null;
    // 'saved' means you kept it, not that you applied — so it neither stamps
    // appliedAt nor clears it. Clearing would be destructive when moving back
    // from 'applied' to 'saved'.
    else if (patch.applyStatus !== 'saved' && (!prev || !prev.appliedAt)) {
      op.$set.appliedAt = new Date();
    }
  }
  return op;
};

// PATCH /api/postings — bulk (array of {id, ...fields})
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of updates' });
    }
    const ids = updates.filter(u => u && u.id).map(u => String(u.id));
    const prevById = new Map(
      (await JobPosting.find({ _id: { $in: ids } }, { appliedAt: 1 }).lean())
        .map(d => [String(d._id), d])
    );
    const ops = updates
      .filter(u => u && u.id)
      .map(u => {
        const patch = pickPatch(u);
        if (Object.keys(patch).length === 0) return null;
        return {
          updateOne: {
            filter: { _id: u.id },
            update: buildOp(patch, u.note, prevById.get(String(u.id))),
          },
        };
      })
      .filter(Boolean);

    if (ops.length === 0) return res.json({ ok: true, count: 0 });
    const result = await JobPosting.bulkWrite(ops);
    res.json({ ok: true, count: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty ids array' });
    }
    const out = await JobPosting.updateMany(
      { _id: { $in: ids } },
      { $set: { deleted: true, deletedAt: new Date() } }
    );
    res.json({ ok: true, deleted: out.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const patch = pickPatch(req.body || {});
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    const prev = await JobPosting.findById(req.params.id, { appliedAt: 1 }).lean();
    if (!prev) return res.status(404).json({ error: 'Posting not found' });
    const posting = await JobPosting.findByIdAndUpdate(
      req.params.id, buildOp(patch, req.body.note, prev), { new: true }
    );
    res.json(posting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const posting = await JobPosting.findByIdAndUpdate(
      req.params.id,
      { $set: { deleted: true, deletedAt: new Date() } },
      { new: true }
    );
    if (!posting) return res.status(404).json({ error: 'Posting not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
