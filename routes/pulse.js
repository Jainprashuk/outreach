const express = require('express');
const SendJob = require('../models/SendJob');
const Notification = require('../models/Notification');
const Settings = require('../models/Settings');
const ScrapeRun = require('../models/ScrapeRun');
const NaukriRun = require('../models/NaukriRun');
const { activeFilter } = require('./runs');

const router = express.Router();

// Same set GET /api/jobs/active-all lists (routes/jobs.js ACTIVE_STATUSES).
const ACTIVE_JOB = ['pending', 'processing', 'paused'];
const stamp = (d) => (d ? new Date(d).getTime() : 0);

// GET /api/pulse — "has anything changed?" for the always-on parts of every page
// (client/src/context/PulseContext.tsx). Each value is an opaque stamp: the page
// refetches the real endpoint only when one moves. Read-only and indexed, unlike
// /api/jobs/active-all, which also writes (cancelStaleJobs) on every call.
//   jobs           active send jobs: how many, and the latest change to any of them
//   notifications  visible / unread counts and the newest one: covers new, read
//                  and cleared
//   mailbox        the last mailbox scan, which is what moves replies into Needs you
//   runs           worker runs (LinkedIn harvest, job platforms) queued or running,
//                  and the newest finish — moves when one starts, changes state
//                  or ends (/api/runs/active has the detail)
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    const visible = { userId, clearedAt: null };
    const [jobs, newestNote, unread, shown, settings, sRuns, nRuns, sLast, nLast] = await Promise.all([
      SendJob.find({ userId, status: { $in: ACTIVE_JOB } }, { updatedAt: 1 }).limit(50).lean(),
      Notification.findOne(visible, { createdAt: 1 }).sort({ createdAt: -1 }).lean(),
      Notification.countDocuments({ ...visible, readAt: null }),
      Notification.countDocuments(visible),
      Settings.findOne({ userId }, { lastMailboxCheckAt: 1 }).lean(),
      ScrapeRun.find(activeFilter(userId), { status: 1, createdAt: 1 }).limit(10).lean(),
      NaukriRun.find(activeFilter(userId), { status: 1, createdAt: 1 }).limit(10).lean(),
      ScrapeRun.findOne({ userId, finishedAt: { $ne: null } }, { finishedAt: 1 }).sort({ createdAt: -1 }).lean(),
      NaukriRun.findOne({ userId, finishedAt: { $ne: null } }, { finishedAt: 1 }).sort({ createdAt: -1 }).lean(),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      jobs: `${jobs.length}:${Math.max(0, ...jobs.map(j => stamp(j.updatedAt)))}`,
      notifications: `${shown}:${unread}:${stamp(newestNote && newestNote.createdAt)}`,
      mailbox: String(stamp(settings && settings.lastMailboxCheckAt)),
      runs: [...sRuns, ...nRuns].map(r => `${r.status[0]}${stamp(r.createdAt)}`).sort().join(',')
        + `:${Math.max(stamp(sLast && sLast.finishedAt), stamp(nLast && nLast.finishedAt))}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
