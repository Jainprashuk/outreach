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
  if (obj.items) obj.items = obj.items.map(item => { delete item._id; return item; });
  return obj;
};

// Create a new send job and trigger Inngest orchestrator
router.post('/', async (req, res) => {
  try {
    const { items, attachResume } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

    const job = await SendJob.create({
      items,
      attachResume:      !!attachResume,
      senderEmail:       mailer.senderConfig.email || '',
      senderName:        mailer.senderConfig.name  || '',
      senderAppPassword: mailer.senderAppPassword  || '',
    });
    await inngest.send({ name: 'email/batch.start', data: { jobId: job.id.toString() } });
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
  const CHUNK_SIZE = 10;
  const DELAY_MS   = 1500;
  try {
    const job = await SendJob.findByIdAndUpdate(
      req.params.id,
      { status: 'processing' },
      { new: true, lean: true }
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const pendingItems = job.items.filter(i => i.status === 'pending');
    if (pendingItems.length > 0) {
      const chunks = [];
      for (let i = 0; i < pendingItems.length; i += CHUNK_SIZE) {
        chunks.push(pendingItems.slice(i, i + CHUNK_SIZE).map(it => it.contactId));
      }
      await inngest.send(chunks.map((chunk, i) => ({
        name: 'email/chunk.send',
        data: { jobId: job._id.toString(), contactIds: chunk },
        ts: Date.now() + i * CHUNK_SIZE * DELAY_MS,
      })));
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
