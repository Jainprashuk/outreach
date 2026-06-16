const express = require('express');
const Contact = require('../models/Contact');

const router = express.Router();

// GET /api/contacts — list all contacts (newest first)
router.get('/', async (req, res) => {
  const contacts = await Contact.find().sort({ createdAt: -1 });
  res.json(contacts);
});

// GET /api/contacts/stats — dashboard stats
router.get('/stats', async (req, res) => {
  const [total, sent, pending, remaining] = await Promise.all([
    Contact.countDocuments(),
    Contact.countDocuments({ status: 'sent' }),
    Contact.countDocuments({ approvalStatus: 'pending' }),
    Contact.countDocuments({ status: 'queued' }),
  ]);
  res.json({ total, sent, pending, remaining });
});

// POST /api/contacts — bulk create new contacts
// body: array of { name, email, company, role, template }
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

  const contact = await Contact.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

module.exports = router;
