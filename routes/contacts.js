const express = require('express');
const Contact = require('../models/Contact');
const SendJob = require('../models/SendJob');

const router = express.Router();

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const buildFilter = (tab) => {
  if (tab === 'sent')         return { ...BASE_FILTER, status: 'sent' };
  if (tab === 'bounced')      return { ...BASE_FILTER, status: 'bounced' };
  if (tab === 'replied')      return { ...BASE_FILTER, status: 'replied' };
  if (tab === 'remaining')    return { ...BASE_FILTER, status: 'queued' };
  if (tab === 'pending')      return { ...BASE_FILTER, approvalStatus: 'pending' };
  if (tab === 'followup-due') return {
    ...BASE_FILTER,
    status: { $in: ['sent', 'replied'] },
    followUpSentAt: null,
    lastSentAt: { $lt: new Date(Date.now() - THREE_DAYS_MS) },
  };
  if (tab === 'closed')      return { ...BASE_FILTER, status: 'closed' };
  if (tab === 'no-openings') return { ...BASE_FILTER, status: 'no-openings' };
  return { ...BASE_FILTER };
};

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    const { tab, page, limit, ids } = req.query;
    const filter = buildFilter(tab);
    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      filter._id = { $in: idList };
    }
    const q = Contact.find(filter).sort({ createdAt: -1 }).lean();

    if (page && limit) {
      const p = Math.max(1, parseInt(page, 10));
      const l = Math.min(500, Math.max(1, parseInt(limit, 10)));
      const [total, contacts] = await Promise.all([
        Contact.countDocuments(filter),
        q.skip((p - 1) * l).limit(l),
      ]);
      return res.json({ contacts: contacts.map(serialize), total, page: p, limit: l, pages: Math.ceil(total / l) });
    }

    const contacts = await q;
    res.json(contacts.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/stats — single aggregation instead of 4 countDocuments
router.get('/stats', async (req, res) => {
  try {
    const [agg] = await Contact.aggregate([
      { $match: BASE_FILTER },
      { $group: {
        _id: null,
        total:        { $sum: 1 },
        sent:         { $sum: { $cond: [{ $eq: ['$status', 'sent'] },      1, 0] } },
        bounced:      { $sum: { $cond: [{ $eq: ['$status', 'bounced'] },   1, 0] } },
        replied:      { $sum: { $cond: [{ $eq: ['$status', 'replied'] },   1, 0] } },
        failed:       { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
        pending:      { $sum: { $cond: [{ $eq: ['$approvalStatus', 'pending'] }, 1, 0] } },
        remaining:    { $sum: { $cond: [{ $eq: ['$status', 'queued'] },    1, 0] } },
        followUpDue:  { $sum: { $cond: [{ $and: [
          { $in: ['$status', ['sent', 'replied']] },
          { $eq: [{ $ifNull: ['$followUpSentAt', null] }, null] },
          { $lt: ['$lastSentAt', new Date(Date.now() - THREE_DAYS_MS)] },
        ]}, 1, 0] }},
        closed:      { $sum: { $cond: [{ $eq: ['$status', 'closed'] },      1, 0] } },
        noOpenings:  { $sum: { $cond: [{ $eq: ['$status', 'no-openings'] }, 1, 0] } },
      }},
    ]);
    const zero = { total: 0, sent: 0, bounced: 0, replied: 0, failed: 0, pending: 0, remaining: 0, followUpDue: 0, closed: 0, noOpenings: 0 };
    res.json(agg ? { total: agg.total, sent: agg.sent, bounced: agg.bounced, replied: agg.replied, failed: agg.failed, pending: agg.pending, remaining: agg.remaining, followUpDue: agg.followUpDue, closed: agg.closed, noOpenings: agg.noOpenings } : zero);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/retry-failed — reset all failed contacts to queued
router.post('/retry-failed', async (req, res) => {
  try {
    const failedContacts = await Contact.find({ ...BASE_FILTER, status: 'failed' }).lean();
    if (failedContacts.length === 0) return res.json({ ok: true, retried: 0 });
    await Contact.updateMany(
      { _id: { $in: failedContacts.map(c => c._id) } },
      { $set: { status: 'queued', approvalStatus: 'approved' } }
    );
    res.json({ ok: true, retried: failedContacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/reset-for-send — reset selected contacts back to queued+pending so they can flow through step2→step3
router.post('/reset-for-send', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty ids array' });
    }
    await Contact.updateMany(
      { _id: { $in: ids }, deleted: { $ne: true } },
      { $set: { status: 'queued', approvalStatus: 'pending', editedSubject: null, editedBody: null } }
    );
    const contacts = await Contact.find({ _id: { $in: ids }, deleted: { $ne: true } }).lean();
    res.json({ ok: true, contacts: contacts.map(serialize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts — bulk create
router.post('/', async (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty array of contacts' });
    }
    if (rows.some(r => !r.name || !r.email)) {
      return res.status(400).json({ error: 'Each contact requires name and email' });
    }

    // Deduplicate within the incoming batch (keep first occurrence, case-insensitive)
    const seen = new Set();
    const unique = rows.filter(r => {
      const key = r.email.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Find which emails already exist in the DB (non-deleted)
    const incomingEmails = unique.map(r => r.email.trim().toLowerCase());
    const existing = await Contact.find(
      { email: { $in: incomingEmails }, deleted: { $ne: true } },
      { email: 1 }
    ).lean();
    const existingEmails = new Set(existing.map(c => c.email.trim().toLowerCase()));

    const toInsert = unique.filter(r => !existingEmails.has(r.email.trim().toLowerCase()));
    const skippedCount = rows.length - toInsert.length;

    let created = [];
    if (toInsert.length > 0) {
      created = await Contact.insertMany(toInsert.map(r => ({
        name: r.name,
        email: r.email.trim(),
        company: r.company || '',
        role: r.role || '',
        template: r.template || 'intro-v2',
      })));
    }

    res.status(201).json({ created, skipped: skippedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts — bulk update (array of {id, ...fields})
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of updates' });
    }
    const allowed = new Set(['approvalStatus', 'status', 'editedSubject', 'editedBody', 'template', 'messageId', 'sentSubject', 'repliedAt', 'replySnippet', 'replyRead']);
    const ops = updates.map(({ id, ...rest }) => {
      const patch = {};
      for (const key of Object.keys(rest)) {
        if (allowed.has(key)) patch[key] = rest[key];
      }
      return { updateOne: { filter: { _id: id }, update: { $set: patch } } };
    });
    await Contact.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, count: ops.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/fail-reason — look up error from SendJob items (for contacts failed before failReason was added to Contact)
router.get('/:id/fail-reason', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id, 'status failReason').lean();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.failReason) return res.json({ reason: contact.failReason });
    const job = await SendJob.findOne(
      { items: { $elemMatch: { contactId: req.params.id, status: 'failed' } } },
      { 'items.$': 1 }
    ).lean();
    const reason = job?.items?.[0]?.error || null;
    if (reason) {
      await Contact.findByIdAndUpdate(req.params.id, { failReason: reason });
    }
    res.json({ reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id — soft-delete (sets deleted: true, hides from all queries)
router.delete('/:id', async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      { deleted: true, deletedAt: new Date() },
      { new: true, lean: true }
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['approvalStatus', 'status', 'editedSubject', 'editedBody', 'template', 'messageId', 'sentSubject', 'repliedAt', 'replySnippet', 'replyRead'];
    const update = {};
    for (const key of allowed) {
      if (key in req.body) update[key] = req.body[key];
    }
    const contact = await Contact.findByIdAndUpdate(req.params.id, update, { new: true, lean: true });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(serialize(contact));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
