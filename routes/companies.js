// Company pages: everything the app knows about one company, from every module.
// Read-only — see lib/companyView.js.

const express = require('express');
const { companyList, companyDetail } = require('../lib/companyView');

const router = express.Router();
const err500 = (res, err) => res.status(500).json({ error: err.message });

// GET /api/companies?q=&sort=score|recent|contacts&limit=
router.get('/', async (req, res) => {
  try {
    const sort = ['score', 'recent', 'contacts'].includes(req.query.sort) ? req.query.sort : 'score';
    res.json(await companyList(req.userId, {
      q: String(req.query.q || '').slice(0, 80),
      sort,
      limit: parseInt(req.query.limit, 10) || 100,
    }));
  } catch (err) { err500(res, err); }
});

// GET /api/companies/:key — key is d:<domain>, n:<name key> or a bare domain.
router.get('/:key', async (req, res) => {
  try {
    const out = await companyDetail(req.userId, req.params.key);
    if (!out) return res.status(404).json({ error: 'Not a company key' });
    res.json(out);
  } catch (err) { err500(res, err); }
});

module.exports = router;
