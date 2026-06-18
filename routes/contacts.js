const express = require('express');
const Contact = require('../models/Contact');

const router = express.Router();

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const buildFilter = (tab) => {
  if (tab === 'sent')      return { ...BASE_FILTER, status: 'sent' };
  if (tab === 'bounced')   return { ...BASE_FILTER, status: 'bounced' };
  if (tab === 'replied')   return { ...BASE_FILTER, status: 'replied' };
  if (tab === 'remaining') return { ...BASE_FILTER, status: 'queued' };
  if (tab === 'pending')   return { ...BASE_FILTER, approvalStatus: 'pending' };
  return { ...BASE_FILTER };
};

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    const { tab, page, limit } = req.query;
    const filter = buildFilter(tab);
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
        total:     { $sum: 1 },
        sent:      { $sum: { $cond: [{ $eq: ['$status', 'sent'] },      1, 0] } },
        bounced:   { $sum: { $cond: [{ $eq: ['$status', 'bounced'] },   1, 0] } },
        replied:   { $sum: { $cond: [{ $eq: ['$status', 'replied'] },   1, 0] } },
        pending:   { $sum: { $cond: [{ $eq: ['$approvalStatus', 'pending'] }, 1, 0] } },
        remaining: { $sum: { $cond: [{ $eq: ['$status', 'queued'] },    1, 0] } },
      }},
    ]);
    const zero = { total: 0, sent: 0, bounced: 0, replied: 0, pending: 0, remaining: 0 };
    res.json(agg ? { total: agg.total, sent: agg.sent, bounced: agg.bounced, replied: agg.replied, pending: agg.pending, remaining: agg.remaining } : zero);
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
    const created = await Contact.insertMany(rows.map(r => ({
      name: r.name,
      email: r.email,
      company: r.company || '',
      role: r.role || '',
      template: r.template || 'intro-v2',
    })));
    res.status(201).json(created);
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
