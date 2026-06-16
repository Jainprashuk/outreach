const router = require('express').Router();
const SendJob = require('../models/SendJob');
const { inngest } = require('../inngest');

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

    const job = await SendJob.create({ items, attachResume: !!attachResume });
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
    const job = await SendJob.findByIdAndUpdate(
      req.params.id,
      { status: 'processing' },
      { new: true, lean: true }
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const pendingItems = job.items.filter(i => i.status === 'pending');
    if (pendingItems.length > 0) {
      await inngest.send(pendingItems.map((item, i) => ({
        name: 'email/single.send',
        data: { jobId: job._id.toString(), contactId: item.contactId },
        ts: Date.now() + i * 1500,
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
