const express = require('express');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const { importContacts } = require('../lib/contactImport');
const { importLeads, readSourceLeads, normText } = require('../lib/leadImport');

const router = express.Router();

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  // .lean() skips schema defaults, so rows written before a field existed come
  // back with the key missing entirely. Normalise here rather than making every
  // caller defend against undefined.
  if (!Array.isArray(obj.queries)) obj.queries = [];
  if (!obj.applyStatus) obj.applyStatus = 'not-applied';
  if (obj.appliedAt === undefined) obj.appliedAt = null;
  if (obj.applyUrl === undefined) obj.applyUrl = null;
  if (typeof obj.applyNote !== 'string') obj.applyNote = '';
  if (!Array.isArray(obj.applyHistory)) obj.applyHistory = [];
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const HARD_REJECT = -999;

// GET /api/leads/outcomes — what actually happened to leads after they were
// promoted. Keyed on EMAIL, not contactId: contactId is only stamped when a new
// contact is created, so leads whose address already existed as a contact carry
// null and an id-based join would miss most of them.
router.get('/outcomes', async (req, res) => {
  try {
    const emails = await Lead.distinct('email', { email: { $ne: null }, ...BASE_FILTER });
    if (emails.length === 0) return res.json({ outcomes: {}, count: 0 });

    const contacts = await Contact.find(
      { email: { $in: emails }, deleted: { $ne: true } },
      {
        email: 1, status: 1, approvalStatus: 1, template: 1, lastSentAt: 1,
        followUpSentAt: 1, repliedAt: 1, replySnippet: 1, bounceReason: 1, failReason: 1,
      }
    ).collation({ locale: 'en', strength: 2 }).lean();

    const outcomes = {};
    for (const c of contacts) {
      outcomes[c.email.trim().toLowerCase()] = {
        contactId: String(c._id),
        status: c.status,
        approvalStatus: c.approvalStatus,
        template: c.template || '',
        lastSentAt: c.lastSentAt || null,
        followUpSentAt: c.followUpSentAt || null,
        repliedAt: c.repliedAt || null,
        replySnippet: c.replySnippet || null,
        bounceReason: c.bounceReason || null,
        failReason: c.failReason || null,
      };
    }
    res.json({ outcomes, count: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/import — accepts the whole harvester file (union of
// last_run_leads + all_leads) or a bare array of leads.
router.post('/import', async (req, res) => {
  try {
    const body = req.body;
    const { source, ignoredRows } = readSourceLeads(body);
    if (source.length === 0) {
      return res.status(400).json({
        error: 'No leads found — expected last_run_leads / all_leads arrays, or a bare array of leads',
      });
    }

    const updatedAt = body && body.updated_at;
    const batchUpdatedAt = Number.isFinite(updatedAt) ? new Date(updatedAt * 1000) : null;

    const result = await importLeads(source, { ignoredRows, batchUpdatedAt });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/move-to-outreach — create contacts from the selected leads and
// flip their status. One endpoint rather than two client calls so a failure can't
// leave contacts created with the leads still reading "new".
router.post('/move-to-outreach', async (req, res) => {
  try {
    const { template = '', leads } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty leads array' });
    }

    const edits = new Map(leads.filter(l => l && l.id).map(l => [String(l.id), l]));
    if (edits.size === 0) return res.status(400).json({ error: 'Expected leads with ids' });

    const docs = await Lead.find({ _id: { $in: [...edits.keys()] }, ...BASE_FILTER }).lean();
    if (docs.length === 0) return res.status(404).json({ error: 'No matching leads found' });

    // Email-less leads can never become contacts (Contact.email is required). The
    // UI disables their checkbox; this is the server-side backstop.
    const promotable = docs.filter(d => d.email);
    const skippedNoEmail = docs.length - promotable.length;
    if (promotable.length === 0) {
      return res.status(400).json({ error: 'None of the selected leads have an email address' });
    }

    const rows = promotable.map(d => {
      const e = edits.get(String(d._id)) || {};
      return {
        _leadId: String(d._id),
        // Contact.name is required and author_name can be edited to empty in the
        // modal, so fall back twice — a ValidationError inside insertMany would
        // abort the whole batch.
        name:    normText(e.name) || normText(d.authorName) || d.email.split('@')[0],
        email:   d.email,
        company: normText(e.company != null ? e.company : d.company),
        role:    normText(e.role != null ? e.role : d.role),
        template,
      };
    });

    const { created } = await importContacts(rows);

    const contactIdByEmail = new Map(created.map(c => [c.email, String(c._id)]));
    const now = new Date();
    let statusUpdateFailed = false;
    try {
      await Lead.bulkWrite(rows.map(r => ({
        updateOne: {
          filter: { _id: r._leadId },
          update: { $set: {
            status: 'added-to-outreach',
            promotedAt: now,
            contactId: contactIdByEmail.get(r.email) || null,
            // Persist the edits so the leads table reflects what actually went out
            authorName: r.name,
            company: r.company,
            role: r.role,
          } },
        },
      })), { ordered: false });
    } catch (_) {
      statusUpdateFailed = true; // contacts exist — surface it rather than lying
    }

    res.json({
      ok: true,
      created,
      alreadyExisted: rows.length - created.length,
      skippedNoEmail,
      movedIds: rows.map(r => r._leadId),
      ...(statusUpdateFailed ? { statusUpdateFailed: true } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/bulk-delete — soft delete many in one round trip
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty ids array' });
    }
    const r = await Lead.updateMany(
      { _id: { $in: ids } },
      { $set: { deleted: true, deletedAt: new Date() } }
    );
    res.json({ ok: true, deleted: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads — best-fit first, so hard rejects sink to the bottom
router.get('/', async (req, res) => {
  try {
    const { status, hideRejects, ids, page, limit } = req.query;
    const filter = { ...BASE_FILTER };
    if (status && status !== 'all') filter.status = status;
    if (hideRejects === '1') filter.fitScore = { $ne: HARD_REJECT };
    if (ids) filter._id = { $in: ids.split(',').filter(Boolean) };

    const q = Lead.find(filter).sort({ fitScore: -1, createdAt: -1 }).lean();

    if (page && limit) {
      const p = Math.max(1, parseInt(page, 10));
      const l = Math.min(500, Math.max(1, parseInt(limit, 10)));
      const [total, rows] = await Promise.all([
        Lead.countDocuments(filter),
        q.skip((p - 1) * l).limit(l),
      ]);
      return res.json({ leads: rows.map(serialize), total, page: p, limit: l, pages: Math.ceil(total / l) });
    }

    const rows = await q;
    res.json(rows.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ALLOWED_PATCH = ['status', 'authorName', 'company', 'role', 'applyStatus', 'applyUrl', 'applyNote'];

const pickPatch = (src) => {
  const patch = {};
  for (const key of ALLOWED_PATCH) {
    if (src[key] !== undefined) patch[key] = src[key];
  }
  return patch;
};

// Build the mongo op for a lead patch, recording apply-journey transitions so the
// full history is inspectable later. `prev` is the stored doc (may be undefined
// in the bulk path, in which case appliedAt is set defensively via $min-ish logic).
const buildOp = (patch, note, prev) => {
  const op = { $set: { ...patch } };
  if (patch.applyStatus) {
    op.$push = {
      applyHistory: { status: patch.applyStatus, changedAt: new Date(), note: note || 'Manual update' },
    };
    // Stamp the date the first time it reaches 'applied'; clear it if reset.
    if (patch.applyStatus === 'not-applied') op.$set.appliedAt = null;
    else if (!prev || !prev.appliedAt) op.$set.appliedAt = new Date();
  }
  return op;
};

// PATCH /api/leads — bulk update (array of {id, ...fields})
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of updates' });
    }
    const ids = updates.filter(u => u && u.id).map(u => String(u.id));
    const prevById = new Map(
      (await Lead.find({ _id: { $in: ids } }, { appliedAt: 1 }).lean())
        .map(d => [String(d._id), d])
    );
    const ops = updates
      .filter(u => u && u.id)
      .map(u => {
        const patch = pickPatch(u);
        if (Object.keys(patch).length === 0) return null;
        return { updateOne: { filter: { _id: u.id }, update: buildOp(patch, u.note, prevById.get(String(u.id))) } };
      })
      .filter(Boolean);

    if (ops.length === 0) return res.json({ ok: true, count: 0 });
    const result = await Lead.bulkWrite(ops);
    res.json({ ok: true, count: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id
router.patch('/:id', async (req, res) => {
  try {
    const patch = pickPatch(req.body || {});
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    const prev = await Lead.findById(req.params.id, { appliedAt: 1 }).lean();
    if (!prev) return res.status(404).json({ error: 'Lead not found' });
    const lead = await Lead.findByIdAndUpdate(
      req.params.id, buildOp(patch, req.body.note, prev), { new: true }
    );
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: { deleted: true, deletedAt: new Date() } },
      { new: true }
    );
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
