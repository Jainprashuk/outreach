/**
 * The signed-in user's OWN reports: on screen, as a PDF, or emailed to
 * themselves. Every query is scoped to req.userId; there is deliberately no
 * parameter that names another account — not even for an admin.
 */
const express = require('express');
const User = require('../models/User');
const LifecycleEmail = require('../models/LifecycleEmail');
const { resolvePeriod, lastFullWeek, istDateString, istMidnight, labelFor, DAY_MS } = require('../lib/reportPeriod');
const { buildReportStats } = require('../lib/reportStats');
const { renderReportPdf } = require('../lib/reportPdf');
const { getLifecycleConfig } = require('../lib/lifecycle/config');
const { decide, REASONS } = require('../lib/lifecycle/gate');
const { claim, buildMessage } = require('../lib/lifecycle/deliver');
const { MANUAL_EMAILS_PER_DAY } = require('../lib/lifecycle/types');
const { USER_FIELDS } = require('../lib/lifecycle/candidates');
const { sendSystemEmail } = require('../lib/systemMail');

const router = express.Router();

// Humans only. A share link or worker token has a userId but no person behind it.
router.use((req, res, next) => {
  if (!req.session && process.env.AUTH_OPEN !== '1') return res.status(401).json({ error: 'Sign in to see your reports' });
  next();
});

const periodFrom = (req, res) => {
  try { return resolvePeriod(req.query); } catch (err) { res.status(400).json({ error: err.message }); return null; }
};

/** GET /api/reports?period=last-week|this-week|last-30|week&week=|custom&from=&to= */
router.get('/', async (req, res) => {
  const p = periodFrom(req, res);
  if (!p) return;
  try {
    const stats = await buildReportStats(req.userId, p);
    res.json({ ...stats, label: labelFor(p) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pdf', async (req, res) => {
  const p = periodFrom(req, res);
  if (!p) return;
  try {
    const [stats, user] = await Promise.all([
      buildReportStats(req.userId, p),
      User.findById(req.userId, { name: 1, email: 1 }).lean(),
    ]);
    const pdf = await renderReportPdf(stats, { name: user && user.name, email: user && user.email });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="outreach-report-${istDateString(p.from)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** The last 12 finished Monday–Sunday weeks, newest first. Regenerated on demand. */
router.get('/weeks', (_req, res) => {
  const weeks = [];
  let p = lastFullWeek(new Date());
  for (let i = 0; i < 12; i++) {
    weeks.push({ week: istDateString(p.from), label: labelFor(p) });
    p = { from: new Date(p.from.getTime() - 7 * DAY_MS), to: p.from };
  }
  res.json({ weeks });
});

/** POST /api/reports/email  (same query params) — "Email it to me". */
router.post('/email', async (req, res) => {
  const p = periodFrom(req, res);
  if (!p) return;
  try {
    const [user, config] = await Promise.all([User.findById(req.userId, USER_FIELDS).lean(), getLifecycleConfig()]);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const decision = decide('manual-report', user, config);
    if (!decision.send) {
      return res.status(403).json({ error: `Emailing reports is unavailable right now: ${REASONS[decision.reason] || decision.reason}. You can still download the PDF.`, reason: decision.reason });
    }

    const sentToday = await LifecycleEmail.countDocuments({
      userId: user._id, type: 'manual-report', status: { $in: ['claimed', 'sent'] },
      createdAt: { $gte: istMidnight(new Date()) },
    });
    if (sentToday >= MANUAL_EMAILS_PER_DAY) {
      return res.status(429).json({ error: `You can email yourself ${MANUAL_EMAILS_PER_DAY} reports a day. Download the PDF instead, or try tomorrow.` });
    }

    const row = await claim({ userId: user._id, type: 'manual-report', key: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, to: decision.to, testMode: decision.testMode });
    try {
      const msg = await buildMessage('manual-report', user, { period: p, manual: true });
      const { id } = await sendSystemEmail({ ...msg, to: decision.to });
      await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'sent', providerId: id, sentAt: new Date() } });
      res.json({ ok: true, to: decision.to });
    } catch (err) {
      await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'failed', error: String(err.message).slice(0, 300) } });
      res.status(502).json({ error: `The email could not be sent: ${err.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
