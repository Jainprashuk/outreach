const express = require('express');
const ActivityLog = require('../models/ActivityLog');

const router = express.Router();
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const logs = await ActivityLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(logs.map(log => ({ ...log, id: String(log._id), _id: undefined, __v: undefined })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
module.exports = router;
