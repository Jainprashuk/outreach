// The "Needs you" queue: where every replied conversation stands, and the buttons that move
// it. The rules live in lib/actionQueue.js; this file only reads and writes Contact.action.
const express = require('express');
const Contact = require('../models/Contact');
const actionQueue = require('../lib/actionQueue');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };
const MAX_SNOOZE_DAYS = 366;

// GET /api/actions — every queued conversation with the bucket it's in right now, plus the
// per-bucket counts. Both come from the same rows in the same pass, so the Mailbox badge
// and the list under it cannot disagree. The Mailbox joins these ids onto the contacts it
// already has loaded; it never works out a bucket itself.
router.get('/', async (req, res) => {
  try {
    const now = new Date();
    const rows = await Contact.find(
      { ...BASE_FILTER, userId: req.userId, 'action.state': { $in: actionQueue.STATES } },
      { action: 1 },
    ).lean();

    const counts = Object.fromEntries(actionQueue.QUEUE_BUCKETS.map(s => [s, 0]));
    const items = rows.map(c => {
      const bucket = actionQueue.bucketOf(c.action, now);
      counts[bucket]++;
      return {
        id: String(c._id),
        bucket,
        reason: actionQueue.effectiveReason(c.action, now),
        since: c.action.since,
        dueAt: c.action.dueAt,
        resolvedBy: c.action.resolvedBy,
        action: c.action,
      };
    });

    // Needs you and Follow up: most actionable first, then longest waiting. The rest: newest first.
    const urgent = ['needs-you', 'follow-up'];
    const ranked = urgent.flatMap(b => actionQueue.sortNeedsYou(items.filter(i => i.bucket === b), now));
    const rest = items.filter(i => !urgent.includes(i.bucket))
      .sort((a, b) => new Date(b.since || 0) - new Date(a.since || 0));

    res.json({
      now,
      counts,
      items: [...ranked, ...rest].map(({ action, ...item }) => item),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/actions/bulk {ids, op: 'done'|'snooze'|'reopen', until?}
router.post('/bulk', async (req, res) => {
  try {
    const { ids, op, until } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (!['done', 'snooze', 'reopen'].includes(op)) return res.status(400).json({ error: 'op must be done, snooze or reopen' });

    const now = new Date();
    let untilDate = null;
    if (op === 'snooze') {
      untilDate = new Date(until);
      if (!until || Number.isNaN(untilDate.getTime()) || untilDate <= now) {
        return res.status(400).json({ error: 'Pick a snooze date in the future' });
      }
      if (untilDate > actionQueue.addDays(now, MAX_SNOOZE_DAYS)) {
        return res.status(400).json({ error: 'Snooze for at most a year' });
      }
    }

    const action = actionQueue.manual(op, now, untilDate);
    // Only conversations that are in the queue — a contact who never replied has nothing to
    // mark done, and adding one here would invent a conversation.
    const result = await Contact.updateMany(
      { _id: { $in: ids.slice(0, 500) }, userId: req.userId, ...BASE_FILTER, 'action.state': { $in: actionQueue.STATES } },
      { $set: { action } },
    );
    res.json({ ok: true, updated: result.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
