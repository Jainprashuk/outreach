// Jobs from every sharing account, read-only, plus "add to my jobs". Mounted behind
// requireLibraryAccess (server.js): the same admin switch as the Library decides who
// can see other accounts' jobs. See lib/sharedJobs.js.

const express = require('express');
const sharedJobs = require('../lib/sharedJobs');

const router = express.Router();

// GET /api/shared-jobs?q=&platform=&page=&limit=
router.get('/', async (req, res) => {
  try {
    res.json(await sharedJobs.list(req.userId, {
      q: req.query.q, platform: req.query.platform, page: req.query.page, limit: req.query.limit,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/shared-jobs/add { keys: ['hirist:123', ...] }
router.post('/add', async (req, res) => {
  try {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    if (!keys.length) return res.status(400).json({ error: 'Pick at least one job' });
    res.json(await sharedJobs.addToMine(req.userId, keys));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
