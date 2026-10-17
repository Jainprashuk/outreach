const express = require('express');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const { importContacts, isValidEmail } = require('../lib/contactImport');
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
const OUTCOME_FIELDS = {
  email: 1, status: 1, approvalStatus: 1, template: 1, lastSentAt: 1,
  followUpSentAt: 1, repliedAt: 1, replySnippet: 1, bounceReason: 1, failReason: 1,
};

// The contacts behind leads' addresses, in the order the outcome map is built (a later
// contact with the same address wins). `projection` lets the cache sync ask for ids only.
async function outcomeContacts(userId, projection) {
  const emails = await Lead.distinct('email', { userId, email: { $ne: null }, ...BASE_FILTER });
  if (emails.length === 0) return [];
  return Contact.find({ userId, email: { $in: emails }, deleted: { $ne: true } }, projection)
    .collation({ locale: 'en', strength: 2 }).lean();
}

// One contact's entry in the outcome map, and its key.
const outcomeKey = (c) => c.email.trim().toLowerCase();
const outcomeOfContact = (c) => ({
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
});

async function leadOutcomes(userId) {
  const outcomes = {};
  for (const c of await outcomeContacts(userId, OUTCOME_FIELDS)) outcomes[outcomeKey(c)] = outcomeOfContact(c);
  return outcomes;
}

// ── Browser cache sync (client/src/lib/leadCache.ts) ─────────────────────────
// The Leads page, Leads analytics and Export read every lead and every outcome; on the
// throttled Atlas free tier that download takes ~36 s. The browser keeps a copy, and
// each visit asks only for the current order with a hash of every document, then
// fetches the documents whose hash it doesn't hold. Order and documents are exactly
// what GET /api/leads and GET /api/leads/outcomes return (scripts/parity/lead-cache.js).
const SYNC_CHUNK = 500;
const LEAD_ORDER = { fitScore: -1, createdAt: -1 };
const hashOf = (doc) => ({ $toString: { $toHashedIndexKey: doc } });
const asIds = (ids) => (Array.isArray(ids) ? ids : []).slice(0, SYNC_CHUNK)
  .filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(String(id)));

// GET /api/leads/sync → { user, order: [[id, hash]] } in GET /api/leads' order.
router.get('/sync', async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.userId));
    const filter = { userId, ...BASE_FILTER };
    const [order, hashes] = await Promise.all([
      Lead.find(filter, { _id: 1 }).sort(LEAD_ORDER).lean(),
      Lead.collection.aggregate([{ $match: filter }, { $project: { h: hashOf('$$ROOT') } }]).toArray(),
    ]);
    const h = new Map(hashes.map(r => [String(r._id), r.h]));
    res.json({ user: String(userId), order: order.map(d => [String(d._id), h.get(String(d._id))]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/sync { ids } → [{ id, h, v }] — v is the lead exactly as GET /api/leads sends it.
router.post('/sync', async (req, res) => {
  try {
    req.skipAudit = true; // a read sent as POST for its id list — nothing changes
    const userId = new mongoose.Types.ObjectId(String(req.userId));
    const rows = await Lead.collection.aggregate([
      { $match: { _id: { $in: asIds(req.body?.ids) }, userId, ...BASE_FILTER } },
      { $project: { _id: 0, doc: '$$ROOT', h: hashOf('$$ROOT') } },
    ]).toArray();
    res.json(rows.map(r => ({ id: String(r.doc._id), h: r.h, v: serialize(r.doc) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/outcomes/sync → { user, order: [[contactId, hash]] } in the outcome map's order.
router.get('/outcomes/sync', async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.userId));
    const order = await outcomeContacts(userId, { _id: 1 });
    const hashes = order.length ? await Contact.collection.aggregate([
      { $match: { _id: { $in: order.map(c => c._id) }, userId } },
      { $project: { h: hashOf(Object.fromEntries(Object.keys(OUTCOME_FIELDS).map(k => [k, `$${k}`]))) } },
    ]).toArray() : [];
    const h = new Map(hashes.map(r => [String(r._id), r.h]));
    res.json({ user: String(userId), order: order.map(c => [String(c._id), h.get(String(c._id))]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/outcomes/sync { ids } → [{ id, h, v: { key, outcome } }].
router.post('/outcomes/sync', async (req, res) => {
  try {
    req.skipAudit = true; // a read sent as POST for its id list — nothing changes
    const userId = new mongoose.Types.ObjectId(String(req.userId));
    const fields = Object.fromEntries(Object.keys(OUTCOME_FIELDS).map(k => [k, `$${k}`]));
    const rows = await Contact.collection.aggregate([
      { $match: { _id: { $in: asIds(req.body?.ids) }, userId, deleted: { $ne: true } } },
      { $project: { doc: { _id: '$_id', ...fields }, h: hashOf(fields) } },
    ]).toArray();
    res.json(rows.map(r => ({ id: String(r._id), h: r.h, v: { key: outcomeKey(r.doc), outcome: outcomeOfContact(r.doc) } })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/outcomes', async (req, res) => {
  try {
    const outcomes = await leadOutcomes(req.userId);
    res.json({ outcomes, count: Object.keys(outcomes).length });
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

    const result = await importLeads(source, { ignoredRows, batchUpdatedAt, userId: req.userId });
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

    const docs = await Lead.find({ _id: { $in: [...edits.keys()] }, userId: req.userId, ...BASE_FILTER }).lean();
    if (docs.length === 0) return res.status(404).json({ error: 'No matching leads found' });

    // Email-less leads can never become contacts (Contact.email is required). The
    // UI disables their checkbox; this is the server-side backstop.
    // An unusable address counts as none: importContacts would drop it, and the
    // lead would then be marked promoted with no contact behind it.
    const promotable = docs.filter(d => d.email && isValidEmail(d.email));
    const skippedNoEmail = docs.length - promotable.length;
    if (promotable.length === 0) {
      return res.status(400).json({ error: 'None of the selected leads have a valid email address' });
    }

    const rows = promotable.map(d => {
      const e = edits.get(String(d._id)) || {};
      return {
        _leadId: String(d._id),
        // Stamped onto the Contact so the Contacts board can filter by origin.
        source: 'lead',
        sourceLeadId: String(d._id),
        // Contact.name is required and author_name can be edited to empty in the
        // modal, so fall back twice — a ValidationError inside insertMany would
        // abort the whole batch.
        name:    normText(e.name) || normText(d.authorName) || d.email.split('@')[0],
        email:   d.email,
        company: normText(e.company != null ? e.company : d.company),
        role:    normText(e.role != null ? e.role : d.role),
        template,
        // The poster's profile, when the post was by a person (not a company page).
        ...(/linkedin\.com\/in\//i.test(d.authorUrl || '') ? { linkedin: d.authorUrl } : {}),
      };
    });

    // fillBlanks: an address that's already a contact gets this lead's company/role
    // only where the contact has none — never overwritten.
    const { created, filled } = await importContacts(rows, req.userId, { fillBlanks: true });

    const contactIdByEmail = new Map(created.map(c => [c.email, String(c._id)]));
    const now = new Date();
    let statusUpdateFailed = false;
    try {
      await Lead.bulkWrite(rows.map(r => ({
        updateOne: {
          filter: { _id: r._leadId, userId: req.userId },
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

    // Every contact these leads now stand for — new ones and ones that already
    // existed — so a caller can carry straight on (the Action Center starts a
    // send with them). Callers that only read the counts are unaffected.
    const existedEmails = rows.map(r => r.email.trim().toLowerCase()).filter(e => !contactIdByEmail.has(e));
    const existed = existedEmails.length
      ? await Contact.find({ userId: req.userId, email: { $in: existedEmails }, deleted: { $ne: true } }, { _id: 1 })
        .collation({ locale: 'en', strength: 2 }).lean()
      : [];

    res.json({
      ok: true,
      created,
      contactIds: [...new Set([...created.map(c => String(c._id)), ...existed.map(c => String(c._id))])],
      alreadyExisted: rows.length - created.length,
      filled,
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
      { _id: { $in: ids }, userId: req.userId },
      { $set: { deleted: true, deletedAt: new Date() } }
    );
    res.json({ ok: true, deleted: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads — best-fit first, so hard rejects sink to the bottom
// Proven sufficient by scripts/parity/lead-boards-view.js.
const LEAD_BOARD_FIELDS = { links: 1, applyUrl: 1, postUrl: 1 };

router.get('/', async (req, res) => {
  try {
    const { status, hideRejects, ids, page, limit, view } = req.query;
    const filter = { userId: req.userId, ...BASE_FILTER };
    if (status && status !== 'all') filter.status = status;
    if (hideRejects === '1') filter.fitScore = { $ne: HARD_REJECT };
    if (ids) filter._id = { $in: ids.split(',').filter(Boolean) };

    // ?view=boards — only the three link fields the Jobs page reads to suggest boards
    // (lib/postings.ts suggestedBoardsFromLeads). Same filter and order as the full list.
    const projection = view === 'boards' ? LEAD_BOARD_FIELDS : {};
    const q = Lead.find(filter, projection).sort({ fitScore: -1, createdAt: -1 }).lean();

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
      (await Lead.find({ _id: { $in: ids }, userId: req.userId }, { appliedAt: 1 }).lean())
        .map(d => [String(d._id), d])
    );
    const ops = updates
      .filter(u => u && u.id)
      .map(u => {
        const patch = pickPatch(u);
        if (Object.keys(patch).length === 0) return null;
        return { updateOne: { filter: { _id: u.id, userId: req.userId }, update: buildOp(patch, u.note, prevById.get(String(u.id))) } };
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
    const prev = await Lead.findOne({ _id: req.params.id, userId: req.userId }, { appliedAt: 1 }).lean();
    if (!prev) return res.status(404).json({ error: 'Lead not found' });
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId }, buildOp(patch, req.body.note, prev), { new: true }
    );
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
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
module.exports.serialize = serialize;
module.exports.leadOutcomes = leadOutcomes;
module.exports.outcomeContacts = outcomeContacts;
module.exports.outcomeKey = outcomeKey;
module.exports.outcomeOfContact = outcomeOfContact;
module.exports.OUTCOME_FIELDS = OUTCOME_FIELDS;
