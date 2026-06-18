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

    const mode = sendMode === 'bulk' ? 'bulk' : 'sequential';

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
    });

    const eventName = mode === 'bulk' ? 'email/bulk.start' : 'email/batch.start';
    await inngest.send({ name: eventName, data: { jobId: job.id.toString() } });
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORTANT: /active must be defined before /:id
router.get('/active', async (req, res) => {
  try {
    const job = await SendJob.findOne(
      { status: { $in: ['pending', 'processing', 'paused'] } },
      { items: 1, status: 1, processedCount: 1, attachResume: 1, createdAt: 1 }
    ).sort({ createdAt: -1 }).lean();
    res.json(job ? serialize(job) : null);
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
