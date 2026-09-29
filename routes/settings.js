const express = require('express');
const multer = require('multer');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { PREFS, PREF_KEYS, isPref } = require('../lib/lifecycle/types');

const router = express.Router();

const RESERVED_VARIABLES = ['name', 'company', 'role', 'sender', 'senderCompany'];
const VARIABLE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const RESUME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!RESUME_TYPES.has(file.mimetype)) {
      return cb(new Error('Resume must be a PDF or Word document.'));
    }
    cb(null, true);
  },
});

// GET /api/settings — excludes resume binary from DB fetch
router.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne({ userId: req.userId }, { 'resume.data': 0 });
    if (!settings) settings = await Settings.getForUser(req.userId);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — atomic update, no binary loaded
router.put('/', async (req, res) => {
  try {
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

    const settings = await Settings.findOneAndUpdate(
      { userId: req.userId },
      { $set: { ...update, userId: req.userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true, projection: { 'resume.data': 0 } }
    );
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/resume — upload
router.post('/resume', (req, res) => {
  upload.single('resume')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const settings = await Settings.getForUser(req.userId);
      settings.resume = {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        data: req.file.buffer,
        size: req.file.size,
        uploadedAt: new Date(),
      };
      await settings.save();
      res.status(201).json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// GET /api/settings/resume — stream binary
router.get('/resume', async (req, res) => {
  try {
    const settings = await Settings.getForUser(req.userId);
    if (!settings.resume) return res.status(404).json({ error: 'No resume uploaded' });
    res.set('Content-Type', settings.resume.contentType);
    res.set('Content-Disposition', `attachment; filename="${settings.resume.filename.replace(/"/g, '')}"`);
    res.send(settings.resume.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/resume
router.delete('/resume', async (req, res) => {
  try {
    await Settings.findOneAndUpdate({ userId: req.userId }, { $unset: { resume: '' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/gmail
// The honest counterpart to storing the App Password: it IS stored (encrypted),
// so the reassurance that matters is being able to remove it. Clears the
// credential but keeps the address, which is also the IMAP username and is not
// a secret.
router.delete('/gmail', async (req, res) => {
  try {
    await Settings.findOneAndUpdate({ userId: req.userId }, { $set: { gmailAppPasswordEnc: '' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email preferences ────────────────────────────────────────────────────────
// Lives on User, not Settings (see models/User.js). `blockedByAdmin` is returned
// so the page can show "Turned off by admin" — the user can see it but not
// change it, and the admin cannot change the user's own choice either.
const emailPrefsView = async (userId) => {
  const u = await User.findById(userId, { emailOptOut: 1, emailBlockedByAdmin: 1 }).lean();
  const optOut = new Set((u && u.emailOptOut) || []);
  const blocked = new Set((u && u.emailBlockedByAdmin) || []);
  return {
    prefs: PREF_KEYS.map(k => ({
      key: k,
      label: PREFS[k].label,
      on: !optOut.has(k),
      // Off for this user by an admin if EVERY type the preference covers is.
      blockedByAdmin: PREFS[k].covers.every(t => blocked.has(t)),
    })),
  };
};

router.get('/email-prefs', async (req, res) => {
  try {
    res.json(await emailPrefsView(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/email-prefs', async (req, res) => {
  try {
    const { key, on } = req.body || {};
    if (!isPref(key) || typeof on !== 'boolean') return res.status(400).json({ error: 'Unknown preference' });
    await User.updateOne({ _id: req.userId }, on ? { $pull: { emailOptOut: key } } : { $addToSet: { emailOptOut: key } });
    res.json(await emailPrefsView(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
