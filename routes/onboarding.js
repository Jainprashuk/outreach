/**
 * First-run setup.
 *
 * A new account starts with nothing: no Gmail credential, no templates, and a
 * sender name that literally reads "Your Name". This walks someone through the
 * three things that have to be true before their first email can go out, and
 * records where they got to so quitting halfway is safe.
 *
 * Gmail connection itself is NOT here — it reuses POST /api/config, which
 * already verifies the credential over SMTP before storing it. A second path to
 * the same thing would be a second place for that check to be forgotten.
 */
const express = require('express');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Template = require('../models/Template');
const credentials = require('../lib/credentials');
const { seedStarterTemplates, STARTER_TEMPLATES } = require('../lib/starterTemplates');
const {
  ONBOARDING_VERSION, STEPS, REQUIRED_STEPS, checkReadiness, isOnboarded,
} = require('../lib/onboarding');

const router = express.Router();

/**
 * Where this account stands.
 *
 * Booleans only. The Gmail credential is reported as "is one set", never
 * returned — the ciphertext has no business leaving the server, and the
 * plaintext cannot be reconstructed here anyway.
 */
router.get('/status', async (req, res) => {
  try {
    const [user, settings, templates] = await Promise.all([
      User.findById(req.userId, { onboarding: 1, email: 1, name: 1 }).lean(),
      Settings.findOne(
        { userId: req.userId },
        { senderName: 1, senderCompany: 1, gmailEmail: 1, gmailAppPasswordEnc: 1, 'resume.filename': 1 },
      ).lean(),
      Template.countDocuments({ userId: req.userId }),
    ]);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const ready = checkReadiness(settings);
    res.json({
      complete: isOnboarded(user),
      step: (user.onboarding && user.onboarding.step) || 0,
      skipped: (user.onboarding && user.onboarding.skipped) || [],
      steps: STEPS,
      required: REQUIRED_STEPS,
      checks: {
        gmail: ready.gmail,
        identity: ready.identity,
        templates: templates > 0,
        resume: !!(settings && settings.resume && settings.resume.filename),
      },
      gmailEmail: (settings && settings.gmailEmail) || '',
      senderName: (settings && settings.senderName) || '',
      senderCompany: (settings && settings.senderCompany) || '',
      templateCount: templates,
      // Without a CREDENTIAL_KEY the Gmail step cannot be completed at all, and
      // onboarding is therefore impossible. The client shows this as a blocking
      // panel rather than a toast, because it is an operator problem that the
      // user cannot work around.
      credentialKeyConfigured: credentials.isConfigured(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Remember where they got to, so closing the tab does not start over. */
router.put('/step', async (req, res) => {
  try {
    const step = Number(req.body && req.body.step);
    if (!Number.isInteger(step) || step < 0 || step > STEPS.length) {
      return res.status(400).json({ error: 'step must be an index into the wizard' });
    }
    await User.updateOne({ _id: req.userId }, {
      $set: { 'onboarding.step': step },
      // First time anybody moves, record that they started.
      $min: { 'onboarding.startedAt': new Date() },
    });
    res.json({ ok: true, step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** What the starter templates say, so the wizard can show them before adding. */
router.get('/starter-templates', (_req, res) => {
  res.json(STARTER_TEMPLATES.map(t => ({ key: t.key, name: t.name, subject: t.subject, body: t.body })));
});

router.post('/templates', async (req, res) => {
  try {
    const result = await seedStarterTemplates(req.userId);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/skip', async (req, res) => {
  try {
    const step = String((req.body && req.body.step) || '');
    if (!STEPS.includes(step)) return res.status(400).json({ error: 'Unknown step' });
    if (REQUIRED_STEPS.includes(step)) {
      return res.status(400).json({ error: `The ${step} step cannot be skipped — nothing can be sent without it.` });
    }
    await User.updateOne({ _id: req.userId }, { $addToSet: { 'onboarding.skipped': step } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Finish.
 *
 * Re-checks the required steps against the database rather than trusting that
 * the client disabled its own Next button. The client gate is a convenience;
 * this is the one that decides whether the account is considered set up.
 */
router.post('/complete', async (req, res) => {
  try {
    const settings = await Settings.findOne(
      { userId: req.userId },
      { gmailAppPasswordEnc: 1, senderName: 1 },
    ).lean();
    const ready = checkReadiness(settings);

    if (!ready.gmail) {
      return res.status(400).json({ error: 'Connect a Gmail account before finishing.', step: 'gmail' });
    }
    if (!ready.identity) {
      return res.status(400).json({ error: 'Set the name your emails are signed with.', step: 'identity' });
    }

    await User.updateOne({ _id: req.userId }, {
      $set: {
        'onboarding.completedAt': new Date(),
        'onboarding.version': ONBOARDING_VERSION,
        'onboarding.step': STEPS.length,
      },
      $min: { 'onboarding.startedAt': new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
