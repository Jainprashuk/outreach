const express = require('express');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const SendJob = require('../models/SendJob');
const Template = require('../models/Template');
const {
  runDueCampaigns, releaseCampaign, previewNextBatch, sendHeadroom, EMAIL_RE,
} = require('../lib/campaignRunner');

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
const findCampaign = async (id, projection) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return Campaign.findOne({ _id: id, ...BASE_FILTER }, projection).lean();
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

const hasEnvCredentials = () => !!(process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD);

// ── Collection-level routes ─────────────────────────────────────────────────
// Declared BEFORE /:id so Express doesn't read "meta" or "run-due" as an id.

// POST /api/campaigns/run-due — the cron entry point. Also reachable from the UI.
// Returns 200 even when individual campaigns fail: the workflow asserts
// code = 200, and one bad campaign should not turn the whole cron red. The body
// is the readable log the workflow cats.
router.post('/run-due', async (req, res) => {
  try {
    const report = await runDueCampaigns({ trigger: req.body && req.body.trigger === 'manual' ? 'manual' : 'cron' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/campaigns/meta — Gmail headroom and environment readiness.
router.get('/meta', async (_req, res) => {
  try {
    const [headroom, running, paused] = await Promise.all([
      sendHeadroom(),
      Campaign.countDocuments({ ...BASE_FILTER, status: 'running' }),
      Campaign.countDocuments({ ...BASE_FILTER, status: 'paused' }),
    ]);
    // Sum of what every running campaign intends to send per day. Displayed as a
    // warning only — nothing here trims a batch.
    const active = await Campaign.find({ ...BASE_FILTER, status: 'running' },
      { contactsPerDay: 1, lastReleaseAt: 1 }).lean();
    res.json({
      ...headroom,
      cronConfigured: !!process.env.CRON_SECRET,
      credentialSource: hasEnvCredentials() ? 'env' : 'none',
      running, paused,
      dailyCommitment: active.reduce((n, c) => n + (c.contactsPerDay || 0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns
router.get('/', async (_req, res) => {
  try {
    const campaigns = await Campaign.find(BASE_FILTER).sort({ createdAt: -1 }).lean();
    res.json(campaigns.map(serialize));
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
    if (!(await Template.exists({ key: templateKey }))) {
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
    if (!hasEnvCredentials()) {
      return res.status(400).json({
        error: 'credentials_missing',
        detail: 'Campaigns send unattended, so GMAIL_EMAIL and GMAIL_APP_PASSWORD '
              + 'must be set in the server environment. Add them and restart.',
      });
    }

    const campaign = await Campaign.create({
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

// ── Per-campaign routes ─────────────────────────────────────────────────────

// POST /api/campaigns/:id/rows — append one chunk. `last:true` arms the campaign.
router.post('/:id/rows', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id);
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

    const total = await CampaignRow.countDocuments({ campaignId: campaign._id });
    const pending = await CampaignRow.countDocuments({ campaignId: campaign._id, status: 'pending' });

    const update = { $set: { 'stats.total': total, 'stats.pending': pending } };
    if (body.last) {
      if (total === 0) return res.status(400).json({ error: 'No rows were uploaded.' });
      update.$set.status = campaign.status === 'draft' ? 'running' : campaign.status;
    }
    const updated = await Campaign.findByIdAndUpdate(campaign._id, update, { new: true }).lean();

    res.json({
      ok: true, inserted, duplicates,
      received: rows.length, totalRows: total,
      campaign: serialize(updated),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id — everything the detail page needs in one call.
router.get('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Recompute from the rows rather than trusting the $inc counters — this is
    // what self-heals any drift.
    const grouped = await CampaignRow.aggregate([
      { $match: { campaignId: campaign._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const stats = { total: 0, pending: 0, released: 0, skipped: 0, removed: 0, queued: 0 };
    for (const g of grouped) {
      if (g._id in stats) stats[g._id] = g.n;
      stats.total += g.n;
    }

    // Outcomes for recent batches, so a drip that failed wholesale is visible
    // instead of silently burning the sheet one day at a time.
    const recent = (campaign.releases || []).slice(-7).filter(r => r.jobId);
    const jobs = recent.length
      ? await SendJob.find({ _id: { $in: recent.map(r => r.jobId) } },
          { items: 1, status: 1, sendMode: 1, ratePerHour: 1, createdAt: 1 }).lean()
      : [];
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

    res.json({ campaign: { ...serialize(campaign), stats }, jobSummaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/rows?status=&page=&limit=&q=
router.get('/:id/rows', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const filter = { campaignId: campaign._id };
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
    const preview = await previewNextBatch(req.params.id, { limit: Number(req.query.limit) || 0 });
    if (!preview) return res.status(404).json({ error: 'Campaign not found' });
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — config only.
router.patch('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id);
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
      if (!(await Template.exists({ key }))) {
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

    const updated = await Campaign.findByIdAndUpdate(campaign._id, { $set }, { new: true }).lean();
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
    const campaign = await findCampaign(req.params.id, { _id: 1, status: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // A finished campaign has nothing left to hold back, and flipping it to
    // 'paused' would lose the fact that it completed.
    if (campaign.status === 'completed') {
      return res.status(409).json({ error: 'This campaign has already finished.' });
    }

    const updated = await Campaign.findByIdAndUpdate(campaign._id,
      { $set: { status: 'paused', pausedAt: new Date() } }, { new: true }).lean();

    // Reported so the UI can say honestly what is still going out.
    const jobIds = (updated.releases || []).slice(-3).map(r => r.jobId).filter(Boolean);
    const live = jobIds.length
      ? await SendJob.find({ _id: { $in: jobIds }, status: { $in: ['pending', 'processing'] } },
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
router.post('/:id/resume', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'completed') {
      return res.status(409).json({ error: 'This campaign has already finished.' });
    }

    const remaining = await CampaignRow.countDocuments({ campaignId: campaign._id, status: 'pending' });
    if (remaining === 0) {
      const done = await Campaign.findByIdAndUpdate(campaign._id,
        { $set: { status: 'completed', completedAt: new Date() } }, { new: true }).lean();
      return res.json({ campaign: serialize(done), released: null });
    }

    // Clearing lastError alongside the status is what lets a campaign that tripped
    // the circuit breaker actually run again.
    const updated = await Campaign.findByIdAndUpdate(campaign._id,
      { $set: { status: 'running', pausedAt: null, lastError: null } }, { new: true }).lean();

    // Resuming at 11pm should not dump a day's batch, so this is opt-in.
    let released = null;
    if (req.body && req.body.releaseNow) {
      released = await releaseCampaign(campaign._id, { trigger: 'manual', force: true });
    }
    res.json({ campaign: serialize(updated), released });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/run-now
router.post('/:id/run-now', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, { _id: 1, status: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'running') {
      return res.status(409).json({ error: `This campaign is ${campaign.status}. Continue it first.` });
    }
    const report = await releaseCampaign(campaign._id, {
      trigger: 'manual', force: !!(req.body && req.body.force),
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/rows/remove — pull rows out of the upcoming batch.
router.post('/:id/rows/remove', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter(id => mongoose.isValidObjectId(id));
    if (valid.length === 0) return res.status(400).json({ error: 'Expected a non-empty ids array.' });

    // `pending` only: a released row is already an email, and a row claimed by an
    // in-flight release is past the point where pulling it means anything.
    const result = await CampaignRow.updateMany(
      { _id: { $in: valid }, campaignId: campaign._id, status: 'pending' },
      { $set: { status: 'removed', skipReason: 'removed_by_user' } }
    );
    const removed = result.modifiedCount || 0;
    if (removed === 0) {
      return res.status(409).json({
        error: 'Those rows are no longer pending — the batch may have already started sending.',
      });
    }
    await Campaign.updateOne({ _id: campaign._id },
      { $inc: { 'stats.removed': removed, 'stats.pending': -removed } });
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/rows/restore
router.post('/:id/rows/restore', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter(id => mongoose.isValidObjectId(id));
    if (valid.length === 0) return res.status(400).json({ error: 'Expected a non-empty ids array.' });

    const result = await CampaignRow.updateMany(
      { _id: { $in: valid }, campaignId: campaign._id, status: 'removed' },
      { $set: { status: 'pending', skipReason: null } }
    );
    const restored = result.modifiedCount || 0;
    await Campaign.updateOne({ _id: campaign._id },
      { $inc: { 'stats.removed': -restored, 'stats.pending': restored } });
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id — soft delete. Contacts already created are left
// alone: those emails were sent and their history is real.
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.id, { _id: 1 });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Forcing 'paused' too is belt and braces, so the runner can never pick it up
    // even if the `deleted` filter ever regresses.
    await Campaign.findByIdAndUpdate(campaign._id, {
      $set: { deleted: true, deletedAt: new Date(), status: 'paused' },
    });

    let purgedRows = 0;
    if (req.query.purgeRows === '1') {
      const out = await CampaignRow.deleteMany({ campaignId: campaign._id });
      purgedRows = out.deletedCount || 0;
    }
    res.json({ ok: true, purgedRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
