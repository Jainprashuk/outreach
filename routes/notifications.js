const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const router = express.Router();

const LIMIT = 30;

// GET /api/notifications — the newest few plus the unread total. The count is its
// own query: the 30 returned are not necessarily all the unread ones.
router.get('/', async (req, res) => {
  try {
    const [rows, unread] = await Promise.all([
      Notification.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(LIMIT).lean(),
      Notification.countDocuments({ userId: req.userId, readAt: null }),
    ]);
    // Any unread ERROR makes the bell red, even when it has scrolled past the first 30.
    const unreadErrors = await Notification.countDocuments({ userId: req.userId, readAt: null, severity: 'error' });
    res.set('Cache-Control', 'no-store');
    res.json({
      unread,
      unreadErrors,
      items: rows.map(n => ({
        id: String(n._id), type: n.type, severity: n.severity, title: n.title, body: n.body,
        link: n.link, read: !!n.readAt, createdAt: n.createdAt,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/read — { ids: [...] } or { all: true }.
router.post('/read', async (req, res) => {
  req.skipAudit = true; // marking read is not worth an activity-log row
  try {
    const { ids, all } = req.body || {};
    const filter = { userId: req.userId, readAt: null };
    if (!all) {
      const valid = (Array.isArray(ids) ? ids : []).filter(id => mongoose.isValidObjectId(id)).slice(0, 200);
      if (valid.length === 0) return res.status(400).json({ error: 'ids or all is required' });
      filter._id = { $in: valid };
    }
    const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
