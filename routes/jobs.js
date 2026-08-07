const router = require('express').Router();
const SendJob = require('../models/SendJob');
const Contact = require('../models/Contact');
const { inngest } = require('../inngest');
const mailer = require('../lib/mailer');

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  delete obj.senderAppPassword; // never expose the app password to the browser
  obj.hasCredentials = !!(doc.senderEmail && doc.senderAppPassword);
  if (obj.items) obj.items = obj.items.map(item => { delete item._id; return item; });
  return obj;
};

// Create a new send job and trigger Inngest orchestrator
router.post('/', async (req, res) => {
  try {
    const { items, attachResume, senderEmail, senderName, senderAppPassword, sendMode, chunkSize } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

    const mode = ['bulk', 'drip'].includes(sendMode) ? sendMode : 'sequential';

    // Prefer credentials sent from the browser (guaranteed same-request values).
    // Fall back to in-memory mailer state for local dev where a single process handles all requests.
    const job = await SendJob.create({
      items,
      attachResume:      !!attachResume,
      senderEmail:       senderEmail       || mailer.senderConfig.email || '',
      senderName:        senderName        || mailer.senderConfig.name  || '',
      senderAppPassword: senderAppPassword || mailer.senderAppPassword  || '',
      sendMode:          mode,
      chunkSize:         (mode === 'bulk' && Number(chunkSize) > 0) ? Number(chunkSize) : 20,
      ratePerHour:       (mode === 'drip' && Number(req.body.ratePerHour) > 0) ? Number(req.body.ratePerHour) : 5,
    });

    const eventName = mode === 'bulk' ? 'email/bulk.start' : mode === 'drip' ? 'email/drip.start' : 'email/batch.start';
    try {
      await inngest.send({ name: eventName, data: { jobId: job.id.toString() } });
    } catch (err) {
      // The job row already exists but nothing will ever process it (bad/missing event key,
      // Inngest unreachable). Cancel it so /active doesn't hand this ghost to the widget,
      // which would then sit at "Sending emails…" forever.
      await SendJob.findByIdAndUpdate(job.id, { status: 'cancelled' });
      return res.status(502).json({ error: `Could not queue the send: ${err.message}` });
    }
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/stats/sent-24h — hourly send activity for the past 24 hours
router.get('/stats/sent-24h', async (req, res) => {
  try {
    const HOUR_MS = 60 * 60 * 1000;
    const now = new Date();
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);

    // 24 buckets: [0] = 23 hours ago, [23] = current hour
    const since = new Date(hourStart.getTime() - 23 * HOUR_MS);
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      hour: new Date(since.getTime() + i * HOUR_MS).toISOString(),
      count: 0,
    }));

    const jobs = await SendJob.find(
      { 'items.processedAt': { $gte: since } },
      { items: 1 }
    ).lean();

    let total = 0;
    for (const job of jobs) {
      for (const item of job.items) {
        if (item.status === 'sent' && item.processedAt) {
          const t = new Date(item.processedAt);
          if (t >= since) {
            const idx = Math.min(Math.floor((t - since) / HOUR_MS), 23);
            buckets[idx].count++;
            total++;
          }
        }
      }
    }

    res.json({ count: total, buckets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ACTIVE_STATUSES = ['pending', 'processing', 'paused'];
const ACTIVE_PROJECTION = { items: 1, status: 1, processedCount: 1, attachResume: 1, createdAt: 1, sendMode: 1, ratePerHour: 1 };

// Auto-cancel jobs stuck in pending/processing for over 24h with zero progress.
// These are ghost jobs where Inngest never ran (e.g. server was down when the event fired).
const cancelStaleJobs = () => {
  const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return SendJob.updateMany(
    { status: { $in: ['pending', 'processing'] }, processedCount: 0, createdAt: { $lt: staleThreshold } },
    { $set: { status: 'cancelled' } }
  );
};

// IMPORTANT: /active and /active-all must be defined before /:id
router.get('/active', async (req, res) => {
  try {
    await cancelStaleJobs();

    const job = await SendJob.findOne(
      { status: { $in: ACTIVE_STATUSES } },
      ACTIVE_PROJECTION
    ).sort({ createdAt: -1 }).lean();
    res.json(job ? serialize(job) : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/active-all — every in-flight job, newest first.
// Overlapping drips/batches all run concurrently, so the widget needs the full
// set; /active only ever surfaced the newest, hiding the others while they sent.
router.get('/active-all', async (req, res) => {
  try {
    await cancelStaleJobs();

    const jobs = await SendJob.find(
      { status: { $in: ACTIVE_STATUSES } },
      ACTIVE_PROJECTION
    ).sort({ createdAt: -1 }).limit(20).lean();
    res.json(jobs.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/latest — most recent job (any status); used by done.html to find jobId
router.get('/latest', async (req, res) => {
  try {
    const job = await SendJob.findOne().sort({ createdAt: -1 }).lean();
    res.json(job ? serialize(job) : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/retry-failed — reset failed contacts to queued so the user
// can re-send them through step3 (credential entry is required there).
// Does NOT fire Inngest — credentials must be re-entered at send time.
router.post('/:id/retry-failed', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const failedItems = job.items.filter(i => i.status === 'failed');
    if (failedItems.length === 0) return res.json({ ok: true, retried: 0, contacts: [] });

    const failedContactIds = failedItems.map(i => i.contactId);

    // Reset contacts: queued + approved so "Resume sending" picks them up
    await Contact.updateMany(
      { _id: { $in: failedContactIds } },
      { $set: { status: 'queued', approvalStatus: 'approved' } }
    );

    // Return the full contact docs so the frontend can build the approved list for step3
    const contacts = await Contact.find({ _id: { $in: failedContactIds } }).lean();
    res.json({ ok: true, retried: failedItems.length, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/repair — fixes jobs stuck in 'processing' when all items are already done.
// Called automatically by the widget when it detects this inconsistency.
router.post('/:id/repair', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id, 'status items.status').lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'processing') return res.json({ ok: true, repaired: false, status: job.status });
    if (job.items.every(i => i.status !== 'pending')) {
      await SendJob.findByIdAndUpdate(req.params.id, {
        status: 'done',
        processedCount: job.items.filter(i => i.status !== 'pending').length,
      });
      return res.json({ ok: true, repaired: true, status: 'done' });
    }
    res.json({ ok: true, repaired: false, status: 'processing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(serialize(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const job = await SendJob.findByIdAndUpdate(req.params.id, { status: 'paused' }, { new: true, lean: true });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(serialize(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    // Check credentials before updating status so we don't leave a stuck 'processing' job
    const existing = await SendJob.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: 'Job not found' });
    if (!existing.senderEmail || !existing.senderAppPassword) {
      return res.status(400).json({
        error: 'credentials_missing',
        message: 'This job has no stored Gmail credentials. Use the "Resume sending" button on the dashboard to re-enter them.',
      });
    }

    const job = await SendJob.findByIdAndUpdate(
      req.params.id,
      { status: 'processing' },
      { new: true, lean: true }
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const pendingItems = job.items.filter(i => i.status === 'pending');
    if (pendingItems.length > 0) {
      if (job.sendMode === 'bulk') {
        await inngest.send({ name: 'email/bulk.start', data: { jobId: job._id.toString() } });
      } else if (job.sendMode === 'drip') {
        await inngest.send({ name: 'email/drip.start', data: { jobId: job._id.toString() } });
      } else {
        await inngest.send(pendingItems.map((item, i) => ({
          name: 'email/single.send',
          data: { jobId: job._id.toString(), contactId: item.contactId },
          ts: Date.now() + i * 1500,
        })));
      }
    } else {
      await SendJob.findByIdAndUpdate(req.params.id, { status: 'done' });
      job.status = 'done';
    }
    res.json(serialize(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const job = await SendJob.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true, lean: true });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(serialize(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
