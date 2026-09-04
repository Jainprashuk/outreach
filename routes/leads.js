const express = require('express');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const { importContacts } = require('../lib/contactImport');

const router = express.Router();

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const HARD_REJECT = -999;

const normEmail = (e) => String(e || '').trim().toLowerCase();
const normText  = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const normUrl   = (u) => normText(u).toLowerCase().replace(/\/+$/, '');

// Emails are the primary identity. Email-less rows fall back to author_url and
// then author_name, so re-uploading the same dump doesn't pile up copies of the
// same person (the harvester repeats email-less authors with different links).
const dedupeKeyFor = (r) =>
  r.email     ? `e:${r.email}` :
  r.authorUrl ? `a:${normUrl(r.authorUrl)}` :
                `n:${normText(r.authorName).toLowerCase()}`;

// One source lead -> one row per distinct email, or a single row with email: null.
const explodeLead = (l) => {
  const emails = Array.isArray(l.emails)
    ? [...new Set(l.emails.map(normEmail).filter(Boolean))]
    : [];
  const base = {
    authorName: normText(l.author_name) || '(unknown)',
    authorUrl:  l.author_url ? normText(l.author_url) : null,
    company:    l.company ? normText(l.company) : '',
    role:       '',
    fitScore:   Number.isFinite(l.fit_score) ? l.fit_score : 0,
    hiring:     !!l.hiring,
    links:      Array.isArray(l.links) ? l.links.filter(x => typeof x === 'string') : [],
    postUrl:    l.post_url || null,
    source:     typeof l.source === 'string' ? l.source : '',
    // Older dumps have no `query`; those rows simply carry an empty list.
    queries:    typeof l.query === 'string' && l.query.trim() ? [normText(l.query)] : [],
  };
  return emails.length === 0
    ? [{ ...base, email: null }]
    : emails.map(email => ({ ...base, email }));
};

const isUsableSourceLead = (l) =>
  !!l && typeof l === 'object' &&
  (!!normText(l.author_name) || (Array.isArray(l.emails) && l.emails.length > 0));

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

    const raw = Array.isArray(body)
      ? body
      : [
          ...(Array.isArray(body && body.last_run_leads) ? body.last_run_leads : []),
          ...(Array.isArray(body && body.all_leads) ? body.all_leads : []),
        ];

    const source = raw.filter(isUsableSourceLead);
    const ignoredRows = raw.length - source.length;
    if (source.length === 0) {
      return res.status(400).json({
        error: 'No leads found — expected last_run_leads / all_leads arrays, or a bare array of leads',
      });
    }

    const updatedAt = body && body.updated_at;
    const batchUpdatedAt = Number.isFinite(updatedAt) ? new Date(updatedAt * 1000) : null;

    // 1. explode by email
    const exploded = source.flatMap(explodeLead)
      .map(r => ({ ...r, dedupeKey: dedupeKeyFor(r), batchUpdatedAt }));

    // 2. dedupe within the batch BEFORE touching the DB. Sort by fitScore desc
    //    first so "first occurrence wins" deterministically keeps the best-fit
    //    copy — last_run_leads is a subset of all_leads, so every row arrives at
    //    least twice, and the same email can appear under two author names.
    //    Array#sort is stable, so ties keep the file's own best-fit-first order.
    const byKey = new Map();
    for (const r of [...exploded].sort((a, b) => b.fitScore - a.fitScore)) {
      const kept = byKey.get(r.dedupeKey);
      if (!kept) { byKey.set(r.dedupeKey, r); continue; }
      // Keep the best-fit copy, but credit every query that surfaced this lead.
      for (const q of r.queries) if (!kept.queries.includes(q)) kept.queries.push(q);
    }
    const unique = [...byKey.values()];

    // 3. dedupe against what's already stored (non-deleted only, matching
    //    contacts). No .collation() needed — dedupeKey is already normalised.
    const stored = await Lead.find(
      { dedupeKey: { $in: unique.map(r => r.dedupeKey) }, ...BASE_FILTER },
      { dedupeKey: 1, queries: 1 }
    ).lean();
    const storedByKey = new Map(stored.map(d => [d.dedupeKey, d]));
    const toInsert = unique.filter(r => !storedByKey.has(r.dedupeKey));

    // 4. Backfill: a lead already in the store still learns any query it didn't
    //    have (older imports predate the field). Only `queries` is touched —
    //    company/role/authorName may have been edited on promote and must not be
    //    clobbered by a re-import.
    const backfill = [];
    for (const r of unique) {
      const existing = storedByKey.get(r.dedupeKey);
      if (!existing || r.queries.length === 0) continue;
      const merged = [...new Set([...(existing.queries || []), ...r.queries])];
      if (merged.length !== (existing.queries || []).length) {
        backfill.push({ updateOne: { filter: { _id: existing._id }, update: { $set: { queries: merged } } } });
      }
    }
    if (backfill.length) await Lead.bulkWrite(backfill, { ordered: false });

    const created = toInsert.length ? await Lead.insertMany(toInsert, { ordered: false }) : [];

    res.status(201).json({
      created,
      skipped: unique.length - toInsert.length,        // already in the lead store
      updated: backfill.length,                        // existing rows that gained queries
      skippedInBatch: exploded.length - unique.length, // duplicate rows inside the file
      ignoredRows,
      totalSourceLeads: source.length,
      explodedRows: exploded.length,
    });
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

const ALLOWED_PATCH = ['status', 'authorName', 'company', 'role'];

const pickPatch = (src) => {
  const patch = {};
  for (const key of ALLOWED_PATCH) {
    if (src[key] !== undefined) patch[key] = src[key];
  }
  return patch;
};

// PATCH /api/leads — bulk update (array of {id, ...fields})
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of updates' });
    }
    const ops = updates
      .filter(u => u && u.id)
      .map(u => ({ updateOne: { filter: { _id: u.id }, update: { $set: pickPatch(u) } } }))
      .filter(op => Object.keys(op.updateOne.update.$set).length > 0);

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
    const lead = await Lead.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
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
