const express = require('express');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const Contact = require('../models/Contact');
const SendJob = require('../models/SendJob');
const Template = require('../models/Template');
const {
  runDueCampaigns, releaseCampaign, previewNextBatch, sendHeadroom,
  reconcileDuplicates, buildTimeline, EMAIL_RE,
} = require('../lib/campaignRunner');
const { deadline } = require('../lib/http');
const { inCooldown } = require('../lib/cooldown');
const mailer = require('../lib/mailer');

const { requireOnboarded } = require('../lib/onboardingGuard');

const router = express.Router();

// .lean() skips schema defaults, so rows written before a field existed come back
// with the key missing entirely. Normalise here rather than making every caller
// defend against undefined.
const serialize = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  if (!obj.stats) obj.stats = {};
  for (const k of ['total', 'pending', 'released', 'skipped', 'removed']) {
    if (typeof obj.stats[k] !== 'number') obj.stats[k] = 0;
  }
  if (!Array.isArray(obj.releases)) obj.releases = [];
  if (!Array.isArray(obj.sourceColumns)) obj.sourceColumns = [];
  if (!obj.columnMap) obj.columnMap = {};
  if (obj.lastReleaseOn === undefined) obj.lastReleaseOn = null;
  if (obj.lastError === undefined) obj.lastError = null;
  // The lease is internal bookkeeping; the browser has no use for it.
  delete obj.releaseLockAt;
  return obj;
};

const serializeRow = (doc) => {
  const obj = { ...doc };
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  obj.campaignId = String(obj.campaignId);
  if (!Array.isArray(obj.extras)) obj.extras = [];
  return obj;
};

const BASE_FILTER = { deleted: { $ne: true } };

const normText = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const normEmail = (e) => String(e || '').trim().toLowerCase();

const MAX_ROWS_PER_CHUNK = 2000;
const MAX_EXTRAS = 20;
const MAX_EXTRA_LEN = 500;
// A day's drip must finish inside the day, or tomorrow's batch starts while
// today's is still fanning out and both compete for the same Gmail quota.
const MAX_DRIP_HOURS = 20;

// Every :id route needs this — an unvalidated id surfaces as a 500 CastError
// rather than a 404.
const findCampaign = async (id, userId, projection) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return Campaign.findOne({ _id: id, userId, ...BASE_FILTER }, projection).lean();
};

const dripHours = (perDay, perHour) => (perHour > 0 ? perDay / perHour : Infinity);

/** Shared by POST / and PATCH /:id. Returns an error string, or null. */
function validateConfig({ contactsPerDay, ratePerHour }) {
  if (!(contactsPerDay >= 1 && contactsPerDay <= 500)) {
    return 'Contacts per day must be between 1 and 500.';
  }
  if (!(ratePerHour >= 1 && ratePerHour <= 60)) {
    return 'Emails per hour must be between 1 and 60.';
  }
  const hours = dripHours(contactsPerDay, ratePerHour);
  if (hours > MAX_DRIP_HOURS) {
    const suggested = Math.ceil(contactsPerDay / MAX_DRIP_HOURS);
    return `${contactsPerDay} contacts at ${ratePerHour}/hour would take ${Math.round(hours)} hours, `
         + `so tomorrow's batch would start before today's finished. `
         + `Use at least ${suggested} emails per hour, or lower the daily count.`;
  }
  return null;
}

// Campaigns release unattended, so the owner's credentials must already be
// stored — there is nobody at the keyboard to supply them at send time.
const hasSendCredentials = async (userId) => {
  const sender = await mailer.getSenderFor(userId);
  return !!(sender.email && sender.appPassword);
};

async function restoreReservedContacts(rows, note, userId) {
  const ops = rows.filter(r => r.sourceContactId).map(r => ({
    updateOne: {
      filter: { _id: r.sourceContactId, userId, status: 'in-campaign', deleted: { $ne: true } },
      update: {
        $set: { status: r.sourceContactStatusBefore || 'queued' },
        $push: { statusHistory: { status: r.sourceContactStatusBefore || 'queued', changedAt: new Date(), note } },
      },
    },
  }));
  if (ops.length) await Contact.bulkWrite(ops, { ordered: false });
}

// ── Collection-level routes ─────────────────────────────────────────────────
// Declared BEFORE /:id so Express doesn't read "meta" or "run-due" as an id.

// POST /api/campaigns/run-due — the cron entry point. Also reachable from the UI.
// Returns 200 even when individual campaigns fail: the workflow asserts
// code = 200, and one bad campaign should not turn the whole cron red. The body
// is the readable log the workflow cats.
router.post('/run-due', requireOnboarded, async (req, res) => {
  try {
    const report = await runDueCampaigns({ trigger: req.body && req.body.trigger === 'manual' ? 'manual' : 'cron' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/campaigns/meta — Gmail headroom and environment readiness.
router.get('/meta', async (req, res) => {
  try {
    const [headroom, running, paused] = await Promise.all([
      sendHeadroom(req.userId),
      Campaign.countDocuments({ userId: req.userId, ...BASE_FILTER, status: 'running' }),
      Campaign.countDocuments({ userId: req.userId, ...BASE_FILTER, status: 'paused' }),
    ]);
    // Sum of what every running campaign intends to send per day. Displayed as a
    // warning only — nothing here trims a batch.
    const active = await Campaign.find({ userId: req.userId, ...BASE_FILTER, status: 'running' },
      { contactsPerDay: 1, lastReleaseAt: 1 }).lean();
    res.json({
      ...headroom,
      cronConfigured: !!process.env.CRON_SECRET,
      credentialSource: (await hasSendCredentials(req.userId)) ? 'stored' : 'none',
      running, paused,
      dailyCommitment: active.reduce((n, c) => n + (c.contactsPerDay || 0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * What became of the contacts one or more campaigns created.
 *
 * One aggregation for every campaign at once — a per-campaign join would be N
 * round trips to render a list. Released rows carry contactId, so this reflects
 * later mailbox-check updates without the campaign recording anything itself.
 */
async function outcomesByCampaign(campaignIds, userId) {
  const match = { userId, status: 'released', contactId: { $ne: null } };
  if (campaignIds) match.campaignId = { $in: campaignIds };

  const rows = await CampaignRow.aggregate([
    { $match: match },
    { $addFields: { cid: { $toObjectId: '$contactId' } } },
    { $lookup: { from: 'contacts', localField: 'cid', foreignField: '_id', as: 'c' } },
    { $unwind: '$c' },
    { $match: { 'c.deleted': { $ne: true }, 'c.userId': userId } },
    { $group: { _id: { campaignId: '$campaignId', status: '$c.status' }, n: { $sum: 1 } } },
  ]);

  const byCampaign = new Map();
  for (const r of rows) {
    const k = String(r._id.campaignId);
    if (!byCampaign.has(k)) byCampaign.set(k, {});
    byCampaign.get(k)[r._id.status] = r.n;
  }
  return byCampaign;
}

/** Fold a per-status map into the handful of numbers the UI actually shows. */
function foldOutcomes(byStatus = {}) {
  const pick = (...keys) => keys.reduce((n, k) => n + (byStatus[k] || 0), 0);
  return {
    total: Object.values(byStatus).reduce((n, v) => n + v, 0),
    // 'sent' and 'follow-up-sent' both mean delivered with no reply yet.
    delivered: pick('sent', 'follow-up-sent'),
    replied:   pick('replied', 'follow-up-replied'),
    bounced:   pick('bounced'),
    failed:    pick('failed'),
    queued:    pick('queued'),
    closed:    pick('closed', 'no-openings', 'in-review'),
    byStatus,
  };
}

// GET /api/campaigns/timeline?granularity=day|hour — what has been sent and what
// is still coming. Declared before /:id so 'timeline' is not read as an id.
router.get('/timeline', async (req, res) => {
  try {
    const range = ['24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '7d';
    const scope = req.query.scope === 'campaigns' ? 'campaigns' : 'all';
    res.json(await buildTimeline({ range, scope, userId: req.userId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const campaigns = await Campaign.find({ userId: req.userId, ...BASE_FILTER }).sort({ createdAt: -1 }).lean();
    const ids = campaigns.map(c => c._id);
    const [byCampaign, activeJobs] = await Promise.all([
      outcomesByCampaign(ids, req.userId),
      SendJob.find({ userId: req.userId, campaignId: { $in: ids.map(String) }, status: { $in: ['pending', 'processing'] } }, { campaignId: 1 }).lean(),
    ]);
    const sending = new Set(activeJobs.map(job => String(job.campaignId)));
    res.json(campaigns.map(c => ({
      ...serialize(c),
      sending: sending.has(String(c._id)),
      outcomes: foldOutcomes(byCampaign.get(String(c._id)) || {}),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — create the draft. Rows arrive separately, in chunks.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const name = normText(b.name);
    if (!name) return res.status(400).json({ error: 'Give the campaign a name.' });

    const templateKey = String(b.templateKey || '').trim();
    if (!templateKey) return res.status(400).json({ error: 'Pick a template.' });
    if (!(await Template.exists({ userId: req.userId, key: templateKey }))) {
      return res.status(400).json({ error: `Template "${templateKey}" does not exist.` });
    }

    const contactsPerDay = Number(b.contactsPerDay) || 20;
    const ratePerHour = Number(b.ratePerHour) || 5;
    const configError = validateConfig({ contactsPerDay, ratePerHour });
    if (configError) return res.status(400).json({ error: configError });

    const runHourIst = Number.isInteger(Number(b.runHourIst))
      ? Math.min(23, Math.max(0, Number(b.runHourIst))) : 9;

    const columnMap = b.columnMap && typeof b.columnMap === 'object' ? b.columnMap : {};
    if (columnMap.email === undefined || columnMap.email === null || columnMap.email === '') {
      return res.status(400).json({ error: 'Map a column to Email — a campaign cannot send without one.' });
    }

    // Fail HERE, in the browser, where it can be fixed. Without this guard the
    // campaign happily produces jobs where every item throws "No Gmail
    // credentials stored in job" through all its retries — a silent, invisible
    // failure discovered a week and several hundred contacts later.
    if (!await hasSendCredentials(req.userId)) {
      return res.status(400).json({
        error: 'credentials_missing',
        detail: 'Campaigns send unattended, so your Gmail credentials must be saved '
              + 'first. Add them on the Send screen, then create the campaign.',
      });
    }

    const campaign = await Campaign.create({
      userId: req.userId,
      name,
      fileName: normText(b.fileName),
      templateKey,
      contactsPerDay,
      ratePerHour,
      runHourIst,
      attachResume: !!b.attachResume,
      columnMap,
      sourceColumns: Array.isArray(b.sourceColumns) ? b.sourceColumns.map(String) : [],
      headerRow: Number.isInteger(Number(b.headerRow)) ? Number(b.headerRow) : 0,
      status: 'draft',
    });

    res.status(201).json(serialize(campaign.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/from-contacts — a campaign whose rows point at existing
// contacts. This is intentionally separate from the spreadsheet endpoint: the
// latter must continue to retire existing contacts as duplicates.
router.post('/from-contacts', async (req, res) => {
  try {
    const b = req.body || {};
    const name = normText(b.name);
    if (!name) return res.status(400).json({ error: 'Give the campaign a name.' });
    const templateKey = String(b.templateKey || '').trim();
    if (!templateKey || !(await Template.exists({ userId: req.userId, key: templateKey }))) {
      return res.status(400).json({ error: 'Pick an existing template.' });
    }
    const contactsPerDay = Number(b.contactsPerDay) || 20;
    const ratePerHour = Number(b.ratePerHour) || 5;
    const configError = validateConfig({ contactsPerDay, ratePerHour });
    if (configError) return res.status(400).json({ error: configError });
    if (!await hasSendCredentials(req.userId)) return res.status(400).json({ error: 'credentials_missing' });

    const ids = [...new Set(Array.isArray(b.contactIds) ? b.contactIds.filter(mongoose.isValidObjectId) : [])];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one contact.' });
    const candidates = await Contact.find({ _id: { $in: ids }, userId: req.userId, ...BASE_FILTER, status: { $ne: 'in-campaign' } })
      .select('name email company role status lastSentAt').lean();
    const contacts = candidates.filter(c => !inCooldown(c));
    if (!contacts.length) return res.status(400).json({ error: 'None of the selected contacts are available.' });

    const runHourIst = Number.isInteger(Number(b.runHourIst))
      ? Math.min(23, Math.max(0, Number(b.runHourIst))) : 9;
    const campaign = await Campaign.create({
      userId: req.userId,
      name, templateKey, contactsPerDay, ratePerHour, runHourIst,
      attachResume: !!b.attachResume, fileName: 'Selected contacts',
      columnMap: { name: 'Contact name', email: 'Contact email', company: 'Contact company', role: 'Contact role' },
      sourceColumns: ['Contact'], headerRow: -1, status: 'running',
      stats: { total: contacts.length, pending: contacts.length, released: 0, skipped: 0, removed: 0 },
    });
    await CampaignRow.insertMany(contacts.map((c, rowIndex) => ({
      userId: req.userId,
      campaignId: campaign._id, rowIndex, sourceRow: rowIndex + 1,
      sourceContactId: String(c._id), name: c.name, email: normEmail(c.email),
      company: c.company || '', role: c.role || '', sourceContactStatusBefore: c.status,
    })));
    await Contact.updateMany(
      { _id: { $in: contacts.map(c => c._id) }, userId: req.userId, status: { $ne: 'in-campaign' } },
      {
        $set: { status: 'in-campaign' },
        $push: { statusHistory: { status: 'in-campaign', changedAt: new Date(), note: `Reserved by campaign "${name}"` } },
      },
    );
    res.status(201).json(serialize(campaign.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Per-campaign routes ─────────────────────────────────────────────────────

// POST /api/campaigns/:id/rows — append one chunk. `last:true` arms the campaign.
router.post('/:id/rows', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'completed') {
      return res.status(409).json({ error: 'This campaign has already finished.' });
    }

    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows) return res.status(400).json({ error: 'Expected a rows array.' });
    if (rows.length > MAX_ROWS_PER_CHUNK) {
      return res.status(400).json({ error: `Send at most ${MAX_ROWS_PER_CHUNK} rows per request.` });
    }

    const startIndex = Number(body.startIndex) || 0;
    const docs = rows.map((r, i) => {
      const email = normEmail(r.email);
      const extras = Array.isArray(r.extras)
        ? r.extras.slice(0, MAX_EXTRAS)
            .filter(e => e && e.k)
            .map(e => ({ k: String(e.k).slice(0, 120), v: normText(e.v).slice(0, MAX_EXTRA_LEN) }))
            .filter(e => e.v)
        : [];
      return {
        userId: req.userId,
        campaignId: campaign._id,
        rowIndex: startIndex + i,
        sourceRow: Number(r.row) || (startIndex + i + 1),
        // Contact.name is required and importContacts uses a bare insertMany, so
        // an empty name would abort a whole day's batch at release time.
        name: normText(r.name) || (email ? email.split('@')[0] : ''),
        email,
        company: normText(r.company),
        role: normText(r.role),
        extras,
      };
    });

    let inserted = 0;
    let duplicates = 0;
    if (docs.length) {
      try {
        const out = await CampaignRow.insertMany(docs, { ordered: false });
        inserted = out.length;
      } catch (err) {
        // ordered:false keeps going past duplicates. The unique
        // {campaignId, rowIndex} index is what makes a RETRIED chunk a genuine
        // no-op rather than a double insert — essential when a large upload is
        // several sequential requests and one of them fails.
        inserted = (err && err.insertedDocs && err.insertedDocs.length) || 0;
        const writeErrors = (err && err.writeErrors) || [];
        duplicates = writeErrors.filter(e => e.err && e.err.code === 11000).length;
        const other = writeErrors.length - duplicates;
        if (other > 0 && inserted === 0) throw err;
      }
    }

    const total = await CampaignRow.countDocuments({ userId: req.userId, campaignId: campaign._id });
    const pending = await CampaignRow.countDocuments({ userId: req.userId, campaignId: campaign._id, status: 'pending' });

    const update = { $set: { 'stats.total': total, 'stats.pending': pending } };
    if (body.last) {
      if (total === 0) return res.status(400).json({ error: 'No rows were uploaded.' });
      update.$set.status = campaign.status === 'draft' ? 'running' : campaign.status;
    }
    let updated = await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId }, update, { new: true }).lean();

    // Retire rows that are already Contacts the moment the sheet is complete,
    // rather than rediscovering them on every release scan. Budgeted so a very
    // large sheet cannot push this request past maxDuration; it is idempotent,
    // so whatever is left is finished by the recheck endpoint or the next run.
    let reconciled = null;
    if (body.last) {
      reconciled = await reconcileDuplicates(campaign._id, { budget: deadline(20_000), trigger: 'upload', userId: req.userId });
      if (reconciled.marked > 0) {
        updated = await Campaign.findOne({ _id: campaign._id, userId: req.userId }).lean();
      }
    }

    res.json({
      ok: true, inserted, duplicates,
      received: rows.length, totalRows: total,
      reconciled,
      campaign: serialize(updated),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id — everything the detail page needs in one call.
router.get('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Recompute from the rows rather than trusting the $inc counters — this is
    // what self-heals any drift.
    const grouped = await CampaignRow.aggregate([
      { $match: { userId: req.userId, campaignId: campaign._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const stats = { total: 0, pending: 0, released: 0, skipped: 0, removed: 0, queued: 0 };
    for (const g of grouped) {
      if (g._id in stats) stats[g._id] = g.n;
      stats.total += g.n;
    }

    // What became of the contacts this campaign created. Released rows carry the
    // contactId, so this is a join rather than anything the campaign has to
    // track itself — and it stays correct when the mailbox check later flips
    // someone to bounced or replied.
    const byCampaign = await outcomesByCampaign([campaign._id], req.userId);
    const outcomes = foldOutcomes(byCampaign.get(String(campaign._id)) || {});

    // Outcomes for recent batches, so a drip that failed wholesale is visible
    // instead of silently burning the sheet one day at a time.
    const recent = (campaign.releases || []).slice(-7).filter(r => r.jobId);
    const [jobs, activeJob] = await Promise.all([
      recent.length
        ? SendJob.find({ _id: { $in: recent.map(r => r.jobId) }, userId: req.userId },
          { items: 1, status: 1, sendMode: 1, ratePerHour: 1, createdAt: 1 }).lean()
        : [],
      SendJob.exists({ userId: req.userId, campaignId: String(campaign._id), status: { $in: ['pending', 'processing'] } }),
    ]);
    const jobSummaries = jobs.map(j => ({
      id: j._id.toString(),
      status: j.status,
      sendMode: j.sendMode,
      ratePerHour: j.ratePerHour,
      createdAt: j.createdAt,
      total: j.items.length,
      sent: j.items.filter(i => i.status === 'sent').length,
      failed: j.items.filter(i => i.status === 'failed').length,
      skipped: j.items.filter(i => i.status === 'skipped').length,
      pending: j.items.filter(i => i.status === 'pending').length,
    }));

    res.json({ campaign: { ...serialize(campaign), stats, sending: !!activeJob }, jobSummaries, outcomes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/rows?status=&page=&limit=&q=
router.get('/:id/rows', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const filter = { userId: req.userId, campaignId: campaign._id };
    if (req.query.status) filter.status = String(req.query.status);
    const q = normText(req.query.q);
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { email: re }, { company: re }];
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const [rows, total] = await Promise.all([
      CampaignRow.find(filter).sort({ rowIndex: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CampaignRow.countDocuments(filter),
    ]);

    res.json({ rows: rows.map(serializeRow), total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/preview — the dry run. Zero writes, identical rendering.
router.get('/:id/preview', async (req, res) => {
  try {
    const owned = await findCampaign(req.params.id, req.userId, { _id: 1 });
    if (!owned) return res.status(404).json({ error: 'Campaign not found' });
    const preview = await previewNextBatch(req.params.id, { limit: Number(req.query.limit) || 0, userId: req.userId });
    if (!preview) return res.status(404).json({ error: 'Campaign not found' });
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — config only.
router.patch('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const b = req.body || {};
    // Rows are already projected through the original mapping. Re-mapping would
    // leave the sheet half-mapped with no way to tell which rows are which.
    if (b.columnMap !== undefined || b.headerRow !== undefined) {
      return res.status(409).json({
        error: 'The column mapping cannot be changed after the rows are uploaded. '
             + 'Create a new campaign from the spreadsheet instead.',
      });
    }

    const $set = {};
    if (b.name !== undefined) {
      const name = normText(b.name);
      if (!name) return res.status(400).json({ error: 'Give the campaign a name.' });
      $set.name = name;
    }
    if (b.templateKey !== undefined) {
      const key = String(b.templateKey).trim();
      if (!(await Template.exists({ userId: req.userId, key }))) {
        return res.status(400).json({ error: `Template "${key}" does not exist.` });
      }
      $set.templateKey = key;
    }
    if (b.attachResume !== undefined) $set.attachResume = !!b.attachResume;
    if (b.runHourIst !== undefined) {
      $set.runHourIst = Math.min(23, Math.max(0, Number(b.runHourIst) || 0));
    }

    const contactsPerDay = b.contactsPerDay !== undefined ? Number(b.contactsPerDay) : campaign.contactsPerDay;
    const ratePerHour = b.ratePerHour !== undefined ? Number(b.ratePerHour) : campaign.ratePerHour;
    if (b.contactsPerDay !== undefined || b.ratePerHour !== undefined) {
      const configError = validateConfig({ contactsPerDay, ratePerHour });
      if (configError) return res.status(400).json({ error: configError });
      $set.contactsPerDay = contactsPerDay;
      $set.ratePerHour = ratePerHour;
    }

    const updated = await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId }, { $set }, { new: true }).lean();
    res.json(serialize(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause — stops FUTURE releases and nothing else.
// It deliberately does not read, write or even look at a SendJob: a batch already
// in flight finishes on its own, and the existing drip pause path stays untouched.
router.post('/:id/pause', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1, status: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // A finished campaign has nothing left to hold back, and flipping it to
    // 'paused' would lose the fact that it completed.
    if (campaign.status === 'completed') {
      return res.status(409).json({ error: 'This campaign has already finished.' });
    }

    const updated = await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId },
      { $set: { status: 'paused', pausedAt: new Date() } }, { new: true }).lean();

    // Reported so the UI can say honestly what is still going out.
    const jobIds = (updated.releases || []).slice(-3).map(r => r.jobId).filter(Boolean);
    const live = jobIds.length
      ? await SendJob.find({ _id: { $in: jobIds }, userId: req.userId, status: { $in: ['pending', 'processing'] } },
          { items: 1, status: 1 }).lean()
      : [];

    res.json({
      campaign: serialize(updated),
      inFlightJobs: live.map(j => ({
        id: j._id.toString(),
        status: j.status,
        pending: j.items.filter(i => i.status === 'pending').length,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', requireOnboarded, async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'completed') {
      return res.status(409).json({ error: 'This campaign has already finished.' });
    }

    const remaining = await CampaignRow.countDocuments({ userId: req.userId, campaignId: campaign._id, status: 'pending' });
    if (remaining === 0) {
      const done = await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId },
        { $set: { status: 'completed', completedAt: new Date() } }, { new: true }).lean();
      return res.json({ campaign: serialize(done), released: null });
    }

    // Clearing lastError alongside the status is what lets a campaign that tripped
    // the circuit breaker actually run again.
    const updated = await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId },
      { $set: { status: 'running', pausedAt: null, lastError: null } }, { new: true }).lean();

    // Resuming at 11pm should not dump a day's batch, so this is opt-in.
    let released = null;
    if (req.body && req.body.releaseNow) {
      released = await releaseCampaign(campaign._id, { trigger: 'manual', force: true, userId: req.userId });
    }
    res.json({ campaign: serialize(updated), released });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/run-now
router.post('/:id/run-now', requireOnboarded, async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1, status: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'running') {
      return res.status(409).json({ error: `This campaign is ${campaign.status}. Continue it first.` });
    }
    const report = await releaseCampaign(campaign._id, {
      trigger: 'manual', force: !!(req.body && req.body.force), userId: req.userId,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/rows/recheck — re-run the duplicate reconcile.
// Worth re-running at any time: contacts are created and deleted independently
// of campaigns, so a row that was sendable last week may not be today.
router.post('/:id/rows/recheck', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const result = await reconcileDuplicates(campaign._id, { budget: deadline(40_000), trigger: 'manual', userId: req.userId });
    const fresh = await Campaign.findOne({ _id: campaign._id, userId: req.userId }).lean();
    res.json({ ok: true, ...result, campaign: serialize(fresh) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/rows/remove — pull rows out of the upcoming batch.
router.post('/:id/rows/remove', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1, name: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter(id => mongoose.isValidObjectId(id));
    if (valid.length === 0) return res.status(400).json({ error: 'Expected a non-empty ids array.' });

    // `pending` only: a released row is already an email, and a row claimed by an
    // in-flight release is past the point where pulling it means anything.
    const rows = await CampaignRow.find(
      { _id: { $in: valid }, userId: req.userId, campaignId: campaign._id, status: 'pending' },
      { sourceContactId: 1, sourceContactStatusBefore: 1 },
    ).lean();
    const result = await CampaignRow.updateMany(
      { _id: { $in: valid }, userId: req.userId, campaignId: campaign._id, status: 'pending' },
      { $set: { status: 'removed', skipReason: 'removed_by_user' } }
    );
    const removed = result.modifiedCount || 0;
    if (removed === 0) {
      return res.status(409).json({
        error: 'Those rows are no longer pending — the batch may have already started sending.',
      });
    }
    await Campaign.updateOne({ _id: campaign._id, userId: req.userId },
      { $inc: { 'stats.removed': removed, 'stats.pending': -removed } });
    await restoreReservedContacts(rows, `Removed from campaign "${campaign.name}"`, req.userId);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/rows/restore
router.post('/:id/rows/restore', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1, name: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter(id => mongoose.isValidObjectId(id));
    if (valid.length === 0) return res.status(400).json({ error: 'Expected a non-empty ids array.' });

    const rows = await CampaignRow.find(
      { _id: { $in: valid }, userId: req.userId, campaignId: campaign._id, status: 'removed' },
      { sourceContactId: 1 },
    ).lean();
    const result = await CampaignRow.updateMany(
      { _id: { $in: valid }, userId: req.userId, campaignId: campaign._id, status: 'removed' },
      { $set: { status: 'pending', skipReason: null } }
    );
    const restored = result.modifiedCount || 0;
    await Campaign.updateOne({ _id: campaign._id, userId: req.userId },
      { $inc: { 'stats.removed': -restored, 'stats.pending': restored } });
    const sourceIds = rows.filter(r => r.sourceContactId).map(r => r.sourceContactId);
    if (sourceIds.length) await Contact.updateMany(
      { _id: { $in: sourceIds }, userId: req.userId, deleted: { $ne: true } },
      { $set: { status: 'in-campaign' }, $push: { statusHistory: { status: 'in-campaign', changedAt: new Date(), note: `Restored to campaign "${campaign.name}"` } } },
    );
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id — soft delete. Contacts already created are left
// alone: those emails were sent and their history is real.
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, req.userId, { _id: 1, name: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Forcing 'paused' too is belt and braces, so the runner can never pick it up
    // even if the `deleted` filter ever regresses.
    const reservedRows = await CampaignRow.find(
      { userId: req.userId, campaignId: campaign._id, status: { $in: ['pending', 'removed'] } },
      { sourceContactId: 1, sourceContactStatusBefore: 1 },
    ).lean();
    await Campaign.findOneAndUpdate({ _id: campaign._id, userId: req.userId }, {
      $set: { deleted: true, deletedAt: new Date(), status: 'paused' },
    });
    await restoreReservedContacts(reservedRows, `Campaign "${campaign.name}" deleted`, req.userId);

    let purgedRows = 0;
    if (req.query.purgeRows === '1') {
      const out = await CampaignRow.deleteMany({ userId: req.userId, campaignId: campaign._id });
      purgedRows = out.deletedCount || 0;
    }
    res.json({ ok: true, purgedRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
