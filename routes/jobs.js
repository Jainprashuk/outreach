const router = require('express').Router();
const SendJob = require('../models/SendJob');
const { inngest } = require('../inngest');

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

// IMPORTANT: define /active before /:id so "active" isn't treated as a MongoDB ID
router.get('/active', async (req, res) => {
  try {
    const job = await SendJob.findOne({ status: { $in: ['pending', 'processing', 'paused'] } })
      .sort({ createdAt: -1 });
    res.json(job ? job.toJSON() : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = 'paused';
    await job.save();
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = 'processing';
    await job.save();
    // Re-fan-out remaining pending items
    const pendingItems = job.items.filter(i => i.status === 'pending');
    if (pendingItems.length > 0) {
      await inngest.send(pendingItems.map((item, i) => ({
        name: 'email/single.send',
        data: { jobId: job.id.toString(), contactId: item.contactId },
        ts: Date.now() + i * 1500,
      })));
    } else {
      job.status = 'done';
      await job.save();
    }
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const job = await SendJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = 'cancelled';
    await job.save();
    res.json(job.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
