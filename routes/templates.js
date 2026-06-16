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

// GET /api/templates — list all templates
router.get('/', async (req, res) => {
  const templates = await Template.find().sort({ createdAt: 1 }).lean();
  res.json(templates.map(serialize));
});

// POST /api/templates — create a new template
router.post('/', async (req, res) => {
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
});

// PATCH /api/templates/:key — update name/subject/body
router.patch('/:key', async (req, res) => {
  const allowed = ['name', 'subject', 'body'];
  const update = {};
  for (const field of allowed) {
    if (field in req.body) update[field] = req.body[field];
  }

  const tpl = await Template.findOneAndUpdate({ key: req.params.key }, update, { new: true, lean: true });
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(serialize(tpl));
});

// DELETE /api/templates/:key — delete a template
router.delete('/:key', async (req, res) => {
  const tpl = await Template.findOneAndDelete({ key: req.params.key }, { lean: true });
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

module.exports = router;
