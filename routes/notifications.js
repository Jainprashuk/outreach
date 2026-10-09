const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const router = express.Router();

const LIMIT = 30;

// GET /api/notifications — the newest few plus the unread total. The count is its
// own query: the 30 returned are not necessarily all the unread ones.
router.get('/', async (req, res) => {
  try {
    const visible = { userId: req.userId, clearedAt: null };
    const [rows, unread, unreadErrors] = await Promise.all([
      Notification.find(visible).sort({ createdAt: -1 }).limit(LIMIT).lean(),
      Notification.countDocuments({ ...visible, readAt: null }),
      // Any unread ERROR makes the bell red, even when it has scrolled past the first 30.
      Notification.countDocuments({ ...visible, readAt: null, severity: 'error' }),
    ]);
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

// { ids: [...] } or { all: true } → the filter for this user's rows, or null when neither.
const target = (req, extra) => {
  const { ids, all } = req.body || {};
  const filter = { userId: req.userId, ...extra };
  if (all) return filter;
  const valid = (Array.isArray(ids) ? ids : []).filter(id => mongoose.isValidObjectId(id)).slice(0, 200);
  return valid.length ? { ...filter, _id: { $in: valid } } : null;
};

// POST /api/notifications/read — { ids: [...] } or { all: true }.
router.post('/read', async (req, res) => {
  req.skipAudit = true; // marking read is not worth an activity-log row
  try {
    const filter = target(req, { readAt: null });
    if (!filter) return res.status(400).json({ error: 'ids or all is required' });
    const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/clear — { ids: [...] } or { all: true }. Hides them from the bell.
router.post('/clear', async (req, res) => {
  req.skipAudit = true;
  try {
    const filter = target(req, { clearedAt: null });
    if (!filter) return res.status(400).json({ error: 'ids or all is required' });
    const now = new Date();
    const result = await Notification.updateMany(filter, { $set: { clearedAt: now, readAt: now } });
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
