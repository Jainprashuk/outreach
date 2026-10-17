const express = require('express');
const multer = require('multer');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { PREFS, PREF_KEYS, isPref } = require('../lib/lifecycle/types');
const credentials = require('../lib/credentials');
const aiKeys = require('../lib/ai/keys');
const { KIND } = require('../lib/classify/providers/kinds');
// The bare adapters, not the logged chain: checking a key is not an AI call worth a log row.
const RAW_PROVIDERS = {
  gemini: require('../lib/classify/providers/gemini'),
  groq: require('../lib/classify/providers/groq'),
  cerebras: require('../lib/classify/providers/cerebras'),
};

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
    const allowed = ['senderName', 'senderCompany', 'gmailEmail', 'customVariables', 'replyProfile'];
    const update = {};
    for (const key of allowed) {
      if (key in req.body) update[key] = req.body[key];
    }

    if ('replyProfile' in update) {
      update.replyProfile = String(update.replyProfile || '').slice(0, 2000);
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

// ── Shared Library ───────────────────────────────────────────────────────────
// Whether THIS account's contacts, leads and Discover people are part of the
// shared Library (routes/library.js). Shared unless turned off. Separate from
// /api/settings so that payload stays exactly as it was.
router.get('/library-sharing', async (req, res) => {
  try {
    const u = await User.findById(req.userId, { libraryOptOut: 1 }).lean();
    res.json({ sharing: !(u && u.libraryOptOut === true) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/library-sharing', async (req, res) => {
  try {
    const { sharing } = req.body || {};
    if (typeof sharing !== 'boolean') return res.status(400).json({ error: 'Expected { sharing: true|false }' });
    await User.updateOne({ _id: req.userId }, { $set: { libraryOptOut: !sharing } });
    res.json({ sharing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Your own AI keys ─────────────────────────────────────────────────────────
// Gemini, Groq and Cerebras keys this account's AI runs on (lib/ai/keys.js).
// Separate from /api/settings for the same reason as /library-sharing.

/** One tiny real call, so a mistyped key is caught on Save rather than at 2 AM. */
async function checkKey(provider, key) {
  const model = provider === 'gemini' ? (process.env.GEMINI_USER_MODEL || undefined) : undefined;
  const res = await RAW_PROVIDERS[provider].complete(
    { system: 'Answer with the single word OK.', prompt: 'Say OK.', maxTokens: 16, temperature: 0 },
    { apiKey: key, model, timeoutMs: 15_000 },
  );
  // A cut-off or odd answer still proves the key was accepted.
  if (res.kind === KIND.OK || res.kind === KIND.BAD_OUTPUT) return { ok: true, state: 'ok' };
  if (res.kind === KIND.RATE_LIMITED) return { ok: true, state: 'quota' };
  if (res.kind === KIND.AUTH) return { ok: false, status: 400, error: `${aiKeys.LABEL[provider]} rejected this key. Check you copied all of it.` };
  return { ok: false, status: 502, error: `Couldn't reach ${aiKeys.LABEL[provider]} to check the key. Try again in a minute.` };
}

router.get('/ai-keys', async (req, res) => {
  try {
    res.json(await aiKeys.aiAccess(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/ai-keys { provider, key } — checks the key, then stores it encrypted.
router.put('/ai-keys', async (req, res) => {
  try {
    const provider = String((req.body || {}).provider || '');
    const key = String((req.body || {}).key || '').trim();
    if (!aiKeys.PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
    if (!key) return res.status(400).json({ error: 'Paste your key first' });
    if (key.length > 300 || /\s/.test(key)) return res.status(400).json({ error: "That doesn't look like an API key" });
    if (!credentials.isConfigured()) {
      return res.status(503).json({ error: 'CREDENTIAL_KEY is not set, so a key cannot be stored safely.' });
    }
    // Groq is required; the others are backups to it, never a substitute.
    if (provider !== 'groq') {
      const s = await Settings.findOne({ userId: req.userId }, { 'aiKeys.groqEnc': 1 }).lean();
      if (!(s && s.aiKeys && s.aiKeys.groqEnc)) {
        return res.status(400).json({ error: 'Add your Groq key first — it does the work. Gemini and Cerebras are backups to it.' });
      }
    }
    const check = await checkKey(provider, key);
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    await Settings.getForUser(req.userId);
    await Settings.updateOne({ userId: req.userId }, {
      $set: {
        [`aiKeys.${provider}Enc`]: credentials.encrypt(key),
        [`aiKeyStatus.${provider}`]: { state: check.state, checkedAt: new Date(), error: null },
      },
    });
    aiKeys.forget(req.userId);
    res.json(await aiKeys.aiAccess(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/ai-keys/:provider', async (req, res) => {
  try {
    const provider = req.params.provider;
    if (!aiKeys.PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider' });
    await Settings.updateOne({ userId: req.userId }, {
      $set: { [`aiKeys.${provider}Enc`]: '' },
      $unset: { [`aiKeyStatus.${provider}`]: '' },
    });
    aiKeys.forget(req.userId);
    res.json(await aiKeys.aiAccess(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
