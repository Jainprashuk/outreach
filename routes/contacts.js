const express = require('express');
const Contact = require('../models/Contact');

const router = express.Router();

// Serialize lean documents (replaces toJSON transform)
const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const buildFilter = (tab) => {
  if (tab === 'sent')      return { status: 'sent' };
  if (tab === 'bounced')   return { status: 'bounced' };
  if (tab === 'replied')   return { status: 'replied' };
  if (tab === 'remaining') return { status: 'queued' };
  if (tab === 'pending')   return { approvalStatus: 'pending' };
  return {};
};

// GET /api/contacts — list contacts (newest first)
// Optional query params:
//   ?tab=all|sent|bounced|replied|remaining|pending  (server-side filter)
//   ?page=1&limit=50                                  (pagination; omit for all)
router.get('/', async (req, res) => {
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
    return res.json({
      contacts: contacts.map(serialize),
      total,
      page: p,
      limit: l,
      pages: Math.ceil(total / l),
    });
  }

  const contacts = await q;
  res.json(contacts.map(serialize));
});

// GET /api/contacts/stats — all status counts in one aggregation (replaces 4 countDocuments)
router.get('/stats', async (req, res) => {
  const [agg] = await Contact.aggregate([
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
  res.json(agg ? { total: agg.total, sent: agg.sent, bounced: agg.bounced, replied: agg.replied, pending: agg.pending, remaining: agg.remaining }
               : { total: 0, sent: 0, bounced: 0, replied: 0, pending: 0, remaining: 0 });
});

// POST /api/contacts — bulk create
router.post('/', async (req, res) => {
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
});

// PATCH /api/contacts/:id — update approval/send status or edited content
router.patch('/:id', async (req, res) => {
  const allowed = ['approvalStatus', 'status', 'editedSubject', 'editedBody', 'template', 'messageId', 'sentSubject', 'repliedAt', 'replySnippet', 'replyRead'];
  const update = {};
  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key];
  }

  const contact = await Contact.findByIdAndUpdate(req.params.id, update, { new: true, lean: true });
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(serialize(contact));
});

module.exports = router;
