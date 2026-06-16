const express = require('express');
const Template = require('../models/Template');

const router = express.Router();

const slugify = (str) => (str || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

// GET /api/templates
router.get('/', async (req, res) => {
  try {
    const templates = await Template.find().sort({ createdAt: 1 }).lean();
    res.json(templates.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates
router.post('/', async (req, res) => {
  try {
    const { name, subject, body } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: 'name, subject and body are required' });
    }
    const base = slugify(name);
    if (!base) return res.status(400).json({ error: 'Could not derive a key from the template name' });

    let key = base, n = 1;
    while (await Template.exists({ key })) {
      key = `${base}-${++n}`;
    }
    const tpl = await Template.create({ key, name, subject, body });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/templates/:key
router.patch('/:key', async (req, res) => {
  try {
    const allowed = ['name', 'subject', 'body'];
    const update = {};
    for (const field of allowed) {
      if (field in req.body) update[field] = req.body[field];
    }
    const tpl = await Template.findOneAndUpdate({ key: req.params.key }, update, { new: true, lean: true });
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json(serialize(tpl));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/templates/:key
router.delete('/:key', async (req, res) => {
  try {
    const tpl = await Template.findOneAndDelete({ key: req.params.key }, { lean: true });
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
