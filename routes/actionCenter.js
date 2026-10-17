const express = require('express');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Prospect = require('../models/Prospect');
const SendJob = require('../models/SendJob');
const Settings = require('../models/Settings');
const mailer = require('../lib/mailer');
const { SCREEN_FIELDS, screenDocs } = require('../lib/sendScreen');
const { loadInterviewSets } = require('../lib/interviewGuard');

const router = express.Router();

// The Action Center: the floating button's counts, and the id lists its one-click
// workflows start from (client/src/components/ActionCenter.tsx). Read-only.
//
// Each count and its id list are built the same way, so the number on a button is
// exactly how many contacts the button acts on. The contact buttons also apply the
// send rules (lib/sendScreen.js): someone in your interviews, waiting on your
// reply, emailed in the last 24h, or bounced is never offered — the send would
// only refuse them.

const DAY = 24 * 3600 * 1000;
const THREE_DAYS_MS = 3 * DAY;
const NOT_DELETED = { deleted: { $ne: true } };
// Caps: what one click acts on. Big enough for any real day's backlog, small
// enough that a URL (step-wise sends) and one request stay comfortable.
const MAX = { followup: 500, ready: 500, pending: 500, leads: 200, prospects: 500 };

// lib/contactListDb.js followUpDue, as a find filter: the Follow-up due tab.
const followUpFilter = (userId, now = Date.now()) => ({
  userId, ...NOT_DELETED, status: 'sent', followUpSentAt: null,
  lastSentAt: { $ne: null, $lte: new Date(now - THREE_DAYS_MS) },
});
// Approved and never sent: exactly what Step 3 would send, minus contacts a send
// job already holds (they are still `queued` until the job reaches them).
const readyFilter = (userId) => ({ userId, ...NOT_DELETED, status: 'queued', approvalStatus: 'approved', lastSentAt: null });
// Waiting for Step 2. Only `queued` ones: a pending contact that was already sent
// to (an old import) is not a send waiting to happen.
const pendingFilter = (userId) => ({ userId, ...NOT_DELETED, status: 'queued', approvalStatus: 'pending' });
const leadsFilter = (userId) => ({ userId, ...NOT_DELETED, status: 'new', email: { $ne: null }, fitScore: { $gt: -999 } });
// Found on Discover with a high-confidence address, and not already a contact.
const prospectsFilter = (userId) => ({
  userId, ...NOT_DELETED, status: 'ready', email: { $ne: null }, emailConfidence: 'high',
  $or: [{ existingContactId: null }, { existingContactId: { $exists: false } }],
});


async function heldBySendJobs(userId) {
  const jobs = await SendJob.find({ userId, status: { $in: ['pending', 'processing', 'paused'] } }, { 'items.contactId': 1, 'items.status': 1 }).lean();
  const held = new Set();
  for (const j of jobs) for (const it of j.items || []) if (it.status === 'pending') held.add(String(it.contactId));
  return held;
}

// Sendable contact ids for one button, in its order.
const SORT = { followup: { lastSentAt: 1 }, ready: { createdAt: 1 }, pending: { createdAt: 1 } };
const FILTER = { followup: followUpFilter, ready: readyFilter, pending: pendingFilter };
async function sendableIds(userId, kind, interviewSets) {
  const [rows, held] = await Promise.all([
    Contact.find(FILTER[kind](userId)).select(SCREEN_FIELDS).sort(SORT[kind]).lean(),
    kind === 'ready' ? heldBySendJobs(userId) : new Set(),
  ]);
  const { contacts } = await screenDocs(userId, rows.filter(r => !held.has(String(r._id))), interviewSets);
  return contacts.map(c => String(c._id));
}
const readyIds = (userId, sets) => sendableIds(userId, 'ready', sets);

// GET /api/action-center/summary — every count the panel shows, in one round trip.
router.get('/summary', async (req, res) => {
  try {
    const userId = req.userId;
    const sets = await loadInterviewSets(userId);
    const [followUpDue, ready, pending, failed, newLeads, readyProspects, settings, sender] = await Promise.all([
      sendableIds(userId, 'followup', sets).then(ids => ids.length),
      sendableIds(userId, 'ready', sets).then(ids => ids.length),
      sendableIds(userId, 'pending', sets).then(ids => ids.length),
      Contact.countDocuments({ userId, ...NOT_DELETED, status: 'failed' }),
      Lead.countDocuments(leadsFilter(userId)),
      Prospect.countDocuments(prospectsFilter(userId)),
      Settings.findOne({ userId }, { lastMailboxCheckAt: 1 }).lean(),
      mailer.getSenderFor(userId).catch(() => ({})),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      followUpDue, ready, pending, failed, newLeads, readyProspects,
      lastMailboxCheckAt: (settings && settings.lastMailboxCheckAt) || null,
      gmailConnected: !!(sender && sender.email && sender.appPassword),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/action-center/ids?kind=… — what one workflow button acts on.
//   followup | ready | pending   → { ids }        contact ids
//   leads                        → { ids }        lead ids, best fit first
//   prospects                    → { ids }        prospect ids
router.get('/ids', async (req, res) => {
  try {
    const userId = req.userId;
    const kind = String(req.query.kind || '');
    const pluck = (rows) => rows.map(r => String(r._id));
    let out;
    if (kind === 'followup' || kind === 'ready' || kind === 'pending') {
      out = { ids: (await sendableIds(userId, kind)).slice(0, MAX[kind]) };
    } else if (kind === 'leads') {
      out = { ids: pluck(await Lead.find(leadsFilter(userId), { _id: 1 }).sort({ fitScore: -1, createdAt: -1 }).limit(MAX.leads).lean()) };
    } else if (kind === 'prospects') {
      out = { ids: pluck(await Prospect.find(prospectsFilter(userId), { _id: 1 }).sort({ createdAt: 1 }).limit(MAX.prospects).lean()) };
    } else {
      return res.status(400).json({ error: 'Unknown kind' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = { followUpFilter, readyFilter, pendingFilter, leadsFilter, prospectsFilter, sendableIds, readyIds };
