const express = require('express');
const multer = require('multer');
const Settings = require('../models/Settings');

const router = express.Router();

// Built-in template variables — custom variable keys can't collide with these.
const RESERVED_VARIABLES = ['name', 'company', 'role', 'sender', 'senderCompany'];
const VARIABLE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const RESUME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!RESUME_TYPES.has(file.mimetype)) {
      return cb(new Error('Resume must be a PDF or Word document.'));
    }
    cb(null, true);
  },
});

// GET /api/settings — fetch sender settings (singleton)
router.get('/', async (req, res) => {
  const settings = await Settings.getSingleton();
  res.json(settings);
});

// PUT /api/settings — update sender settings (singleton)
router.put('/', async (req, res) => {
  const allowed = ['senderName', 'senderCompany', 'gmailEmail', 'customVariables'];
  const update = {};
  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key];
  }

  if (update.customVariables) {
    if (!Array.isArray(update.customVariables)) {
      return res.status(400).json({ error: 'customVariables must be an array' });
    }
    const seen = new Map();
    for (const v of update.customVariables) {
      const key = (v.key || '').trim();
      if (!VARIABLE_KEY_RE.test(key)) {
        return res.status(400).json({ error: `Invalid variable name "${key}". Use letters, numbers and underscores, starting with a letter.` });
      }
      if (RESERVED_VARIABLES.includes(key)) {
        return res.status(400).json({ error: `"${key}" is a built-in variable and can't be reused.` });
      }
      seen.set(key, { key, value: v.value || '' });
    }
    update.customVariables = [...seen.values()];
  }

  const settings = await Settings.getSingleton();
  Object.assign(settings, update);
  await settings.save();
  res.json(settings);
});

// POST /api/settings/resume — upload (or replace) the resume
router.post('/resume', (req, res) => {
  upload.single('resume')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const settings = await Settings.getSingleton();
    settings.resume = {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      data: req.file.buffer,
      size: req.file.size,
      uploadedAt: new Date(),
    };
    await settings.save();
    res.status(201).json(settings);
  });
});

// GET /api/settings/resume — download the stored resume
router.get('/resume', async (req, res) => {
  const settings = await Settings.getSingleton();
  if (!settings.resume) return res.status(404).json({ error: 'No resume uploaded' });

  res.set('Content-Type', settings.resume.contentType);
  res.set('Content-Disposition', `attachment; filename="${settings.resume.filename.replace(/"/g, '')}"`);
  res.send(settings.resume.data);
});

// DELETE /api/settings/resume — remove the stored resume
router.delete('/resume', async (req, res) => {
  const settings = await Settings.getSingleton();
  settings.resume = null;
  await settings.save();
  res.json({ ok: true });
});

module.exports = router;
