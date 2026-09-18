const express = require('express');
const Blocklist = require('../models/Blocklist');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// GET /api/blocklist
router.get('/', async (req, res) => {
  try {
    const entries = await Blocklist.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocklist  { type: 'email'|'domain', value, reason? }
router.post('/', async (req, res) => {
  try {
    let { type, value, reason } = req.body;
    value = (value || '').trim().toLowerCase();
    if (!value) return res.status(400).json({ error: 'value is required' });

    // Let the caller paste either a bare domain or a full email and infer the type
    // when it's not given explicitly.
    if (!type) type = EMAIL_RE.test(value) ? 'email' : 'domain';
    if (type === 'domain') value = value.replace(/^@/, '');

    if (type === 'email' && !EMAIL_RE.test(value)) {
      return res.status(400).json({ error: 'Not a valid email address' });
    }
    if (type === 'domain' && !DOMAIN_RE.test(value)) {
      return res.status(400).json({ error: 'Not a valid domain' });
    }

    const entry = await Blocklist.create({ userId: req.userId, type, value, reason: (reason || '').trim() });
    res.json(entry);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Already on the blocklist' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/blocklist/:id
router.delete('/:id', async (req, res) => {
  try {
    const entry = await Blocklist.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!entry) return res.status(404).json({ error: 'Blocklist entry not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
