const express = require('express');
const multer = require('multer');
const Interview = require('../models/Interview');
const { INTERVIEW_STATUSES } = require('../models/Interview');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };

// Buffers are only ever needed by the download endpoint. Every other read
// projects them away so a list of interviews stays a few KB instead of tens of MB.
const NO_BINARIES = { 'cv.data': 0, 'jd.data': 0 };

const normText  = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const normEmail = (e) => String(e || '').trim().toLowerCase();

// CVs are documents. JDs arrive however HR felt like sending them — a PDF, a
// Word file, a pasted-and-saved text file, or a screenshot of a job board.
const CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const JD_TYPES = new Set([...CV_TYPES, 'text/plain', 'image/png', 'image/jpeg', 'image/webp']);

const uploadFor = (kind) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = kind === 'cv' ? CV_TYPES : JD_TYPES;
    if (!allowed.has(file.mimetype)) {
      return cb(new Error(kind === 'cv'
        ? 'CV must be a PDF or Word document.'
        : 'Job description must be a PDF, Word document, text file or image.'));
    }
    cb(null, true);
  },
});

// Fields the client may set. `status` is handled separately so every change goes
// through the history push; the rest are plain overwrites.
const EDITABLE = [
  'name', 'email', 'phone', 'company', 'role',
  'interviewAt', 'round', 'mode', 'meetingLink',
  'expectedCtc', 'offeredCtc', 'noticePeriod', 'location', 'workMode',
  'notes', 'rejectionReason',
];

const pickPatch = (src) => {
  const patch = {};
  for (const key of EDITABLE) {
    if (src[key] === undefined) continue;
    if (key === 'interviewAt') {
      // '' clears the date; anything unparseable is rejected rather than stored
      // as Invalid Date, which would silently break the day-of reminder.
      if (!src[key]) { patch[key] = null; continue; }
      const d = new Date(src[key]);
      if (Number.isNaN(d.getTime())) throw new Error('interviewAt is not a valid date');
      patch[key] = d;
      continue;
    }
    if (key === 'email') { patch[key] = normEmail(src[key]); continue; }
    patch[key] = normText(src[key]);
  }
  return patch;
};

// GET /api/interviews — everything, soonest interview first. Small collection by
// nature (these are people who actually called you back), so no pagination.
router.get('/', async (req, res) => {
  try {
    const rows = await Interview.find(BASE_FILTER, NO_BINARIES)
      .sort({ interviewAt: 1, lastActivityAt: -1 });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/interviews — flag a contact/lead as "they called me". Details are
// seeded from the source row but stored here; the source is never written to.
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const sourceType = ['contact', 'lead', 'manual'].includes(body.sourceType) ? body.sourceType : 'manual';
    const sourceId = sourceType === 'manual' ? null : (body.sourceId ? String(body.sourceId) : null);

    if (sourceType !== 'manual' && !sourceId) {
      return res.status(400).json({ error: `sourceId is required when sourceType is "${sourceType}"` });
    }

    // One live interview per source row. Re-flagging the same person should open
    // the record they already have, not fork a second history.
    if (sourceId) {
      const existing = await Interview.findOne({ sourceType, sourceId, ...BASE_FILTER }, NO_BINARIES);
      if (existing) {
        return res.status(409).json({ error: 'This person is already being tracked in Interviews', interview: existing });
      }
    }

    // Seed from the source so the form opens pre-filled. Anything the client
    // sent explicitly wins, because the move dialog lets you correct it first.
    let seed = {};
    if (sourceType === 'contact' && sourceId) {
      const c = await Contact.findById(sourceId).lean();
      if (!c) return res.status(404).json({ error: 'Contact not found' });
      seed = { name: c.name, email: c.email, company: c.company, role: c.role };
    } else if (sourceType === 'lead' && sourceId) {
      const l = await Lead.findById(sourceId).lean();
      if (!l) return res.status(404).json({ error: 'Lead not found' });
      seed = { name: l.authorName, email: l.email || '', company: l.company, role: l.role };
    }

    const patch = pickPatch(body);
    const name = normText(patch.name || seed.name);
    if (!name) return res.status(400).json({ error: 'A name is required' });

    const status = INTERVIEW_STATUSES.includes(body.status) ? body.status : 'initial-discussion';
    const now = new Date();

    const doc = await Interview.create({
      ...seed,
      ...patch,
      name,
      email: patch.email !== undefined ? patch.email : normEmail(seed.email),
      sourceType,
      sourceId,
      status,
      lastActivityAt: now,
      statusHistory: [{ status, changedAt: now, note: normText(body.note) || 'Moved to interviews' }],
    });

    // Re-read without the (empty) binaries so the response shape matches GET.
    const created = await Interview.findById(doc._id, NO_BINARIES);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/interviews/:id — edit fields and/or move the status on. A status
// change pushes history; every change bumps lastActivityAt, which is what the
// 3-day stale sweep watches.
router.patch('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const prev = await Interview.findOne({ _id: req.params.id, ...BASE_FILTER }, NO_BINARIES);
    if (!prev) return res.status(404).json({ error: 'Interview not found' });

    const patch = pickPatch(body);
    const statusChanged = body.status !== undefined && body.status !== prev.status;

    if (body.status !== undefined && !INTERVIEW_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Unknown status "${body.status}"` });
    }
    if (Object.keys(patch).length === 0 && !statusChanged) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    if (patch.name !== undefined && !patch.name) {
      return res.status(400).json({ error: 'A name is required' });
    }

    const now = new Date();
    const op = { $set: { ...patch, lastActivityAt: now } };

    if (statusChanged) {
      op.$set.status = body.status;
      // The reason is captured on the same request that sets 'rejected', so the
      // note on the history entry explains the move rather than repeating it.
      const reason = body.rejectionReason !== undefined
        ? normText(body.rejectionReason) : prev.rejectionReason;
      if (body.status === 'rejected') op.$set.rejectionReason = reason;
      op.$push = {
        statusHistory: {
          status: body.status,
          changedAt: now,
          note: normText(body.note) || (body.status === 'rejected' && reason ? reason : 'Manual update'),
        },
      };
    }

    const updated = await Interview.findByIdAndUpdate(req.params.id, op, {
      new: true, projection: NO_BINARIES,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/interviews/:id/followed-up — "I chased this one, stop nagging me."
// Bumps the clock without pretending the status moved.
router.post('/:id/followed-up', async (req, res) => {
  try {
    const now = new Date();
    const updated = await Interview.findOneAndUpdate(
      { _id: req.params.id, ...BASE_FILTER },
      {
        $set: { lastActivityAt: now },
        $push: { statusHistory: { status: 'followed-up', changedAt: now, note: normText((req.body || {}).note) || 'Followed up' } },
      },
      { new: true, projection: NO_BINARIES },
    );
    if (!updated) return res.status(404).json({ error: 'Interview not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const isKind = (k) => k === 'cv' || k === 'jd';

// POST /api/interviews/:id/file/:kind — upload (or replace) the CV or the JD.
router.post('/:id/file/:kind', (req, res) => {
  const { kind } = req.params;
  if (!isKind(kind)) return res.status(400).json({ error: 'File kind must be "cv" or "jd"' });

  uploadFor(kind).single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const now = new Date();
      const updated = await Interview.findOneAndUpdate(
        { _id: req.params.id, ...BASE_FILTER },
        {
          $set: {
            [kind]: {
              filename: req.file.originalname,
              contentType: req.file.mimetype,
              data: req.file.buffer,
              size: req.file.size,
              uploadedAt: now,
            },
            lastActivityAt: now,
          },
        },
        { new: true, projection: NO_BINARIES },
      );
      if (!updated) return res.status(404).json({ error: 'Interview not found' });
      res.status(201).json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// GET /api/interviews/:id/file/:kind — stream the stored binary back.
router.get('/:id/file/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!isKind(kind)) return res.status(400).json({ error: 'File kind must be "cv" or "jd"' });
  try {
    const doc = await Interview.findOne({ _id: req.params.id, ...BASE_FILTER });
    if (!doc) return res.status(404).json({ error: 'Interview not found' });
    const file = doc[kind];
    if (!file || !file.data) return res.status(404).json({ error: `No ${kind.toUpperCase()} uploaded` });
    res.set('Content-Type', file.contentType);
    res.set('Content-Disposition', `attachment; filename="${String(file.filename).replace(/"/g, '')}"`);
    res.send(file.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/interviews/:id/file/:kind
router.delete('/:id/file/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!isKind(kind)) return res.status(400).json({ error: 'File kind must be "cv" or "jd"' });
  try {
    const updated = await Interview.findOneAndUpdate(
      { _id: req.params.id, ...BASE_FILTER },
      { $set: { [kind]: null, lastActivityAt: new Date() } },
      { new: true, projection: NO_BINARIES },
    );
    if (!updated) return res.status(404).json({ error: 'Interview not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/interviews/:id — soft delete, matching Contact and Lead.
router.delete('/:id', async (req, res) => {
  try {
    const doc = await Interview.findByIdAndUpdate(
      req.params.id,
      { $set: { deleted: true, deletedAt: new Date() } },
      { new: true, projection: NO_BINARIES },
    );
    if (!doc) return res.status(404).json({ error: 'Interview not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
