const express = require('express');
const Contact = require('../models/Contact');
const SendJob = require('../models/SendJob');
const { COOLDOWN_LABEL, inCooldown, cooldownRemaining } = require('../lib/cooldown');
const { loadInterviewSets, isInInterview } = require('../lib/interviewGuard');
const { importContacts } = require('../lib/contactImport');
const { classifyReply } = require('../lib/replyClassifier');
const { deadline } = require('../lib/http');

const router = express.Router();

const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const buildFilter = (tab) => {
  if (tab === 'sent')         return { ...BASE_FILTER, status: 'sent' };
  if (tab === 'bounced')      return { ...BASE_FILTER, status: 'bounced' };
  if (tab === 'replied')      return { ...BASE_FILTER, status: 'replied' };
  if (tab === 'remaining')    return { ...BASE_FILTER, status: 'queued' };
  if (tab === 'in-campaign')  return { ...BASE_FILTER, status: 'in-campaign' };
  if (tab === 'pending')      return { ...BASE_FILTER, approvalStatus: 'pending' };
  if (tab === 'followup-due') return {
    ...BASE_FILTER,
    status: { $in: ['sent', 'replied'] },
    followUpSentAt: null,
    lastSentAt: { $lt: new Date(Date.now() - THREE_DAYS_MS) },
  };
  if (tab === 'follow-up-sent') return { ...BASE_FILTER, status: 'follow-up-sent' };
  if (tab === 'follow-up-replied') return { ...BASE_FILTER, status: 'follow-up-replied' };
  if (tab === 'closed')         return { ...BASE_FILTER, status: 'closed' };
  if (tab === 'no-openings') return { ...BASE_FILTER, status: 'no-openings' };
  if (tab === 'in-review')   return { ...BASE_FILTER, status: 'in-review' };
  if (tab === 'blocked')     return { ...BASE_FILTER, status: 'blocked' };
  return { ...BASE_FILTER };
};

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    const { tab, page, limit, ids } = req.query;
    const filter = { ...buildFilter(tab), userId: req.userId };
    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      filter._id = { $in: idList };
    }
    const q = Contact.find(filter).sort({ createdAt: -1 }).lean();

    if (page && limit) {
      const p = Math.max(1, parseInt(page, 10));
      const l = Math.min(500, Math.max(1, parseInt(limit, 10)));
      const [total, contacts] = await Promise.all([
        Contact.countDocuments(filter),
        q.skip((p - 1) * l).limit(l),
      ]);
      return res.json({ contacts: contacts.map(serialize), total, page: p, limit: l, pages: Math.ceil(total / l) });
    }

    const contacts = await q;
    res.json(contacts.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/stats — single aggregation instead of 4 countDocuments
router.get('/stats', async (req, res) => {
  try {
    const [agg] = await Contact.aggregate([
      { $match: { ...BASE_FILTER, userId: req.userId } },
      { $group: {
        _id: null,
        total:        { $sum: 1 },
        sent:         { $sum: { $cond: [{ $eq: ['$status', 'sent'] },      1, 0] } },
        bounced:      { $sum: { $cond: [{ $eq: ['$status', 'bounced'] },   1, 0] } },
        replied:      { $sum: { $cond: [{ $eq: ['$status', 'replied'] },   1, 0] } },
        followUpReplied: { $sum: { $cond: [{ $eq: ['$status', 'follow-up-replied'] }, 1, 0] } },
        failed:       { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
        pending:      { $sum: { $cond: [{ $eq: ['$approvalStatus', 'pending'] }, 1, 0] } },
        remaining:    { $sum: { $cond: [{ $eq: ['$status', 'queued'] },    1, 0] } },
        followUpDue:  { $sum: { $cond: [{ $and: [
          { $in: ['$status', ['sent', 'replied']] },
          { $eq: [{ $ifNull: ['$followUpSentAt', null] }, null] },
          { $lt: ['$lastSentAt', new Date(Date.now() - THREE_DAYS_MS)] },
        ]}, 1, 0] }},
        followUpSent: { $sum: { $cond: [{ $eq: ['$status', 'follow-up-sent'] }, 1, 0] } },
        closed:       { $sum: { $cond: [{ $eq: ['$status', 'closed'] },         1, 0] } },
        noOpenings:  { $sum: { $cond: [{ $eq: ['$status', 'no-openings'] }, 1, 0] } },
        inReview:    { $sum: { $cond: [{ $eq: ['$status', 'in-review'] },   1, 0] } },
        blocked:     { $sum: { $cond: [{ $eq: ['$status', 'blocked'] },     1, 0] } },
      }},
    ]);
    const zero = { total: 0, sent: 0, bounced: 0, replied: 0, followUpReplied: 0, failed: 0, pending: 0, remaining: 0, followUpDue: 0, followUpSent: 0, closed: 0, noOpenings: 0, inReview: 0, blocked: 0 };
    res.json(agg ? { total: agg.total, sent: agg.sent, bounced: agg.bounced, replied: agg.replied, followUpReplied: agg.followUpReplied, failed: agg.failed, pending: agg.pending, remaining: agg.remaining, followUpDue: agg.followUpDue, followUpSent: agg.followUpSent, closed: agg.closed, noOpenings: agg.noOpenings, inReview: agg.inReview, blocked: agg.blocked } : zero);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/retry-failed — reset all failed contacts to queued
router.post('/retry-failed', async (req, res) => {
  try {
    const failedContacts = await Contact.find({ ...BASE_FILTER, userId: req.userId, status: 'failed' }).lean();
    if (failedContacts.length === 0) return res.json({ ok: true, retried: 0 });
    await Contact.updateMany(
      { _id: { $in: failedContacts.map(c => c._id) }, userId: req.userId },
      { $set: { status: 'queued', approvalStatus: 'approved' } }
    );
    res.json({ ok: true, retried: failedContacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/reset-for-send — reset selected contacts back to queued+pending so they can flow through step2→step3
router.post('/reset-for-send', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty ids array' });
    }
    // Contacts emailed inside the cooldown window, blocklisted, or already in the
    // interview pipeline are left completely alone — they keep their real status
    // instead of being parked at `queued`.
    const all = await Contact.find({ _id: { $in: ids }, userId: req.userId, deleted: { $ne: true } }).lean();
    const interviewSets = await loadInterviewSets(req.userId);
    const inInterview = (c) => isInInterview({ id: c._id, email: c.email }, interviewSets);
    const skipped = all.filter(c => c.status === 'in-campaign' || c.status === 'blocked' || inCooldown(c) || inInterview(c));
    const skippedIds = new Set(skipped.map(c => String(c._id)));
    const eligibleIds = all.filter(c => !skippedIds.has(String(c._id))).map(c => c._id);

    if (eligibleIds.length > 0) {
      await Contact.updateMany(
        { _id: { $in: eligibleIds }, userId: req.userId },
        {
          $set: { status: 'queued', approvalStatus: 'pending', editedSubject: null, editedBody: null },
          $push: { statusHistory: { status: 'queued', changedAt: new Date(), note: 'Reset for sending' } },
        }
      );
    }

    const contacts = await Contact.find({ _id: { $in: eligibleIds }, userId: req.userId }).lean();
    res.json({
      ok: true,
      contacts: contacts.map(serialize),
      cooldownLabel: COOLDOWN_LABEL,
      skipped: skipped.map(c => ({
        id: String(c._id), name: c.name, email: c.email, status: c.status,
        lastSentAt: c.lastSentAt, remainingMs: cooldownRemaining(c),
        reason: c.status === 'in-campaign' ? 'in_campaign'
          : c.status === 'blocked' ? 'blocked'
          : inInterview(c) ? 'in_interview'
          : 'cooldown',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts — bulk create
router.post('/', async (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty array of contacts' });
    }
    if (rows.some(r => !r.name || !r.email)) {
      return res.status(400).json({ error: 'Each contact requires name and email' });
    }

    // Dedupe + insert live in lib/contactImport.js so /api/leads/move-to-outreach
    // applies exactly the same rules.
    const { created } = await importContacts(rows, req.userId);

    res.status(201).json({ created, skipped: rows.length - created.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts — bulk update (array of {id, ...fields})
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of updates' });
    }
    const allowed = new Set(['approvalStatus', 'status', 'editedSubject', 'editedBody', 'template', 'messageId', 'sentSubject', 'repliedAt', 'replySnippet', 'replyRead']);
    const ops = updates.map(({ id, ...rest }) => {
      const patch = {};
      for (const key of Object.keys(rest)) {
        if (allowed.has(key)) patch[key] = rest[key];
      }
      return { updateOne: { filter: { _id: id, userId: req.userId }, update: { $set: patch } } };
    });
    await Contact.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, count: ops.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Best-effort subject/body to (re)classify from: prefers the latest captured inbound
// thread entry (full body), falling back to the truncated replySnippet for contacts whose
// thread hasn't been backfilled yet.
const latestClassifiableContent = (contact) => {
  const inbound = [...(contact.thread || [])]
    .filter(t => t.direction === 'inbound')
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  return {
    subject: inbound?.subject || (contact.sentSubject ? `Re: ${contact.sentSubject}` : ''),
    body: inbound?.text || contact.replySnippet || '',
  };
};

// Backfill target: contacts who ACTUALLY REPLIED before the thread/classification pipeline
// existed — i.e. `repliedAt` is set. Mailbox is a conversation view, not a sent-mail log, so
// a contact who was only ever emailed and never replied has nothing to backfill here.
// Deliberately keyed off `repliedAt` rather than `status` — status gets overwritten by manual
// triage (e.g. a replied contact marked `closed`/`no-openings`/`in-review` after you've read
// it), but `repliedAt` never gets touched by that. `replyClassifierOk` (not `replyCategory`)
// is what decides whether classification still needs (re)running — see models/Contact.js.
const needsBackfillFilter = {
  ...BASE_FILTER,
  repliedAt: { $ne: null },
  $or: [
    { thread: { $not: { $elemMatch: { direction: 'outbound' } } } },
    { thread: { $not: { $elemMatch: { direction: 'inbound' } } } },
    { replyClassifierOk: { $ne: true } },
  ],
};

// GET /api/contacts/backfill-replies/count — how many legacy sends/replies still need backfilling
router.get('/backfill-replies/count', async (req, res) => {
  try {
    const count = await Contact.countDocuments({ ...needsBackfillFilter, userId: req.userId });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Processes one bounded batch of the backfill backlog (so a single call can't run past the
// serverless function timeout, and so a classifier rate limit only burns through part of the
// backlog per call instead of failing the whole thing). Shared by the manual "Backfill now"
// button (POST /backfill-replies below) and the automatic mailbox-check cron (server.js), so
// the backlog also drains in the background without anyone visiting Mailbox.
//
// `limit` alone is not a time bound — 50 contacts at a few seconds each overruns the 60s
// serverless cap on its own — so the batch also runs against a wall clock and returns short.
// The caller already loops until `remaining` is 0, so a partial batch just means one more
// round trip, whereas a killed function means the work done so far is lost.
const BACKFILL_BUDGET_MS = 20_000;

const runBackfillBatch = async (limit, userId) => {
  const contacts = await Contact.find({ ...needsBackfillFilter, userId }).limit(limit);
  const budget = deadline(BACKFILL_BUDGET_MS);
  let processed = 0;

  for (const contact of contacts) {
    if (budget.expired()) break;
    const hasOutboundThread = (contact.thread || []).some(t => t.direction === 'outbound');
    if (contact.lastSentAt && !hasOutboundThread) {
      // The actual rendered body was never persisted before thread capture existed — only
      // messageId/sentSubject survive a send. editedBody (a user override made before
      // sending) is the closest recoverable approximation; otherwise say so plainly rather
      // than fabricating content.
      contact.thread.push({
        direction: 'outbound',
        subject: contact.sentSubject || '',
        text: contact.editedBody || '(original message body was not stored — sent before thread capture was added)',
        html: '',
        messageId: contact.messageId || null,
        inReplyTo: null,
        at: contact.lastSentAt,
      });
    }

    const hasInboundThread = (contact.thread || []).some(t => t.direction === 'inbound');
    if (contact.repliedAt && !hasInboundThread) {
      contact.thread.push({
        direction: 'inbound',
        subject: contact.sentSubject ? `Re: ${contact.sentSubject}` : '',
        text: contact.replySnippet || '',
        html: '',
        messageId: null,
        inReplyTo: contact.messageId || null,
        at: contact.repliedAt,
      });
    }
    if (!contact.replyClassifierOk) {
      const { subject, body } = latestClassifiableContent(contact);
      const { category, reasoning, success, provider } = await classifyReply({
        subject, body, contactEmail: contact.email, contactName: contact.name, userId,
      }, { signal: budget.signal });
      if (success) {
        contact.replyCategory = category;
        contact.replyCategoryReasoning = reasoning;
        contact.replyCategorizedAt = new Date();
        contact.classifiedBy = provider;
      }
      contact.replyClassifierOk = success;
    }
    await contact.save();
    processed++;
  }

  const remaining = await Contact.countDocuments({ ...needsBackfillFilter, userId });
  return { processed, remaining };
};

// POST /api/contacts/backfill-replies — processes one bounded batch via runBackfillBatch; the
// frontend calls this repeatedly until `remaining` is 0.
router.post('/backfill-replies', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 20));
    const result = await runBackfillBatch(limit, req.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/:id/classify-reply — manual (re)trigger for a contact whose latest reply
// hasn't been successfully classified (replyClassifierOk is false) — e.g. every configured
// provider was rate-limited during the automatic attempt. Re-classifies from the latest
// inbound message and returns the updated contact either way, so the UI can show the new state.
router.post('/:id/classify-reply', async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.userId });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.repliedAt) return res.status(400).json({ error: 'This contact has no reply to classify yet' });

    const { subject, body } = latestClassifiableContent(contact);
    const { category, reasoning, success, provider } = await classifyReply({
      subject, body, contactEmail: contact.email, contactName: contact.name, userId: req.userId,
    });

    if (success) {
      contact.replyCategory = category;
      contact.replyCategoryReasoning = reasoning;
      contact.replyCategorizedAt = new Date();
      contact.classifiedBy = provider;
    }
    contact.replyClassifierOk = success;
    await contact.save();

    if (!success) return res.status(502).json({ error: 'Every classifier provider failed — they may all still be rate-limited. Try again shortly.' });
    res.json(serialize(contact.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/thread — full mailbox-style conversation (outbound + inbound, in order)
router.get('/:id/thread', async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.userId }, 'name email company thread replyCategory replyCategoryReasoning').lean();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const thread = [...(contact.thread || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json({
      name: contact.name, email: contact.email, company: contact.company,
      replyCategory: contact.replyCategory, replyCategoryReasoning: contact.replyCategoryReasoning,
      thread,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/fail-reason — look up error from SendJob items (for contacts failed before failReason was added to Contact)
router.get('/:id/fail-reason', async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.userId }, 'status failReason').lean();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.failReason) return res.json({ reason: contact.failReason });
    const job = await SendJob.findOne(
      { userId: req.userId, items: { $elemMatch: { contactId: req.params.id, status: 'failed' } } },
      { 'items.$': 1 }
    ).lean();
    const reason = job?.items?.[0]?.error || null;
    if (reason) {
      await Contact.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { failReason: reason });
    }
    res.json({ reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id — soft-delete (sets deleted: true, hides from all queries)
router.delete('/:id', async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { deleted: true, deletedAt: new Date() },
      { new: true, lean: true }
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['approvalStatus', 'status', 'editedSubject', 'editedBody', 'template', 'messageId', 'sentSubject', 'repliedAt', 'replySnippet', 'replyRead'];
    const update = {};
    for (const key of allowed) {
      if (key in req.body) update[key] = req.body[key];
    }
    const op = { $set: update };
    if (update.status) {
      op.$push = { statusHistory: { status: update.status, changedAt: new Date(), note: 'Manual status change' } };
    }
    const contact = await Contact.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, op, { new: true, lean: true });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(serialize(contact));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runBackfillBatch = runBackfillBatch;
