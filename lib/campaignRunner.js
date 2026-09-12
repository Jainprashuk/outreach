const crypto = require('crypto');
const mongoose = require('mongoose');

const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const Contact = require('../models/Contact');
const SendJob = require('../models/SendJob');
const { inngest } = require('../inngest');
const mailer = require('./mailer');
const { importContacts } = require('./contactImport');
const { loadRenderContext, renderTemplate } = require('./renderTemplate');
const { deadline } = require('./http');

// IST is a fixed UTC+5:30 with no DST, so a date key needs no dependency and no
// Intl round-trip. `lastReleaseOn === istDateKey()` is the whole "already ran
// today" test — a STRING compare, immune to clock skew and BSON ms truncation.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// GitHub runs scheduled jobs when it has capacity, not at the requested minute
// (observed fires on this repo: 00:29, 03:03, 05:24 IST), so a projection must
// not pretend to know the trigger time. What is knowable is when a batch becomes
// releasable — runHourIst <= istHour(), i.e. the top of the hour.
const RELEASE_MINUTE_IST = 0;
const istDateKey = (d = new Date()) =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHour = (d = new Date()) =>
  new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();

// Longer than vercel.json maxDuration (60s) so a killed invocation self-heals
// rather than wedging a campaign until someone notices.
const LOCK_TTL_MS = 90_000;
// 45 of Vercel's 60 seconds, the same margin lib/postingSync.js uses.
const RUN_BUDGET_MS = 45_000;
// Gmail caps at ~500/day. Per the product decision this is DISPLAYED, never
// enforced — the runner does not trim a batch.
const DAILY_SEND_CAP = Number(process.env.DAILY_SEND_CAP || 400);
// A previous batch this broken means something is wrong with the credentials or
// the mailbox, not with the rows. Releasing again just burns the sheet.
const CIRCUIT_FAIL_RATIO = 0.8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

// ── Lease ───────────────────────────────────────────────────────────────────

/**
 * Claim one campaign for release. THE double-fire guard.
 *
 * Both conditions — "not locked" and "not already released today" — live inside
 * one atomic filter, so two cron fires a second apart cannot both proceed. With
 * no upsert, null means exactly one thing: the filter did not match. (The same
 * reasoning lib/postingSync.js claimLease() spells out; the singleton hazard it
 * warns about doesn't apply here because Campaign has real _ids.)
 */
async function claimCampaign(campaignId, today, force) {
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const notLocked = {
    $or: [
      { releaseLockAt: null },
      { releaseLockAt: { $exists: false } },
      { releaseLockAt: { $lt: stale } },
    ],
  };
  const notReleasedToday = {
    $or: [
      { lastReleaseOn: null },
      { lastReleaseOn: { $exists: false } },
      { lastReleaseOn: { $ne: today } },
    ],
  };

  const before = await Campaign.findOneAndUpdate(
    {
      _id: oid(campaignId),
      status: 'running',
      deleted: { $ne: true },
      $and: force ? [notLocked] : [notLocked, notReleasedToday],
    },
    { $set: { releaseLockAt: new Date() } },
    { returnDocument: 'before' }
  ).lean();

  return before ? { ok: true, campaign: before } : { ok: false };
}

const releaseLease = async (campaignId) => {
  try {
    await Campaign.updateOne({ _id: oid(campaignId) }, { $set: { releaseLockAt: null } });
  } catch (_) { /* the TTL is the real backstop */ }
};

/**
 * Resolve rows left `queued` by a crashed run. The rule is unambiguous ONLY
 * because releaseCampaign() stamps contactId BEFORE creating the SendJob:
 * no contact means nothing happened; a contact means the emails went or will go.
 */
async function sweepStaleClaims(campaignId) {
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const id = oid(campaignId);
  await CampaignRow.updateMany(
    { campaignId: id, status: 'queued', contactId: null, claimedAt: { $lt: stale } },
    { $set: { status: 'pending', releaseId: null, claimedAt: null } }
  );
  await CampaignRow.updateMany(
    { campaignId: id, status: 'queued', contactId: { $ne: null }, claimedAt: { $lt: stale } },
    { $set: { status: 'released' } }
  );
}

// ── Scan ────────────────────────────────────────────────────────────────────

/**
 * Walk the sheet top-down collecting `want` usable rows, skipping and TOPPING UP
 * past blanks, malformed addresses, in-file repeats and people already in
 * Contacts.
 *
 * The pre-check against Contact is what makes top-up possible at all:
 * importContacts() silently returns FEWER created rows for duplicates, so
 * discovering them only there would hand you a short day with no way to make it
 * up. The predicate and collation are copied EXACTLY from lib/contactImport.js
 * so the pre-check and the authoritative import cannot disagree.
 *
 * Pure reads — no writes. previewNextBatch() is this function and nothing else.
 */
async function scanForBatch(campaignId, want, budget) {
  const id = oid(campaignId);
  const chosen = [];
  const skips = [];
  const seen = new Set();
  let cursor = -1;
  let scanned = 0;
  let exhausted = false;
  let timedOut = false;
  let capped = false;
  // A sheet of 5,000 dead rows must not hang the run inside a 60s invocation.
  const scanCap = Math.max(want * 10, 500);

  while (chosen.length < want) {
    if (budget && budget.expired()) { timedOut = true; break; }
    if (scanned >= scanCap) { capped = true; break; }
    const limit = Math.min(200, (want - chosen.length) * 3 + 25);
    const window = await CampaignRow.find(
      { campaignId: id, status: 'pending', rowIndex: { $gt: cursor } },
      { name: 1, email: 1, company: 1, role: 1, rowIndex: 1, sourceRow: 1, extras: 1 }
    ).sort({ rowIndex: 1 }).limit(limit).lean();

    if (window.length === 0) { exhausted = true; break; }
    scanned += window.length;
    cursor = window[window.length - 1].rowIndex;

    // ONE indexed probe per window, not per row.
    const emails = window.map(r => r.email).filter(e => e && EMAIL_RE.test(e));
    const hits = emails.length
      ? await Contact.find({ email: { $in: emails }, deleted: { $ne: true } }, { email: 1 })
          .collation({ locale: 'en', strength: 2 }).lean()
      : [];
    const taken = new Set(hits.map(c => String(c.email).trim().toLowerCase()));

    for (const r of window) {
      if (chosen.length >= want) break;
      if (!r.email)                { skips.push({ row: r, reason: 'blank_email' });        continue; }
      if (!EMAIL_RE.test(r.email)) { skips.push({ row: r, reason: 'invalid_email' });      continue; }
      if (seen.has(r.email))       { skips.push({ row: r, reason: 'duplicate_in_file' });  continue; }
      if (taken.has(r.email))      { skips.push({ row: r, reason: 'duplicate_contact' });  continue; }
      seen.add(r.email);
      chosen.push(r);
    }
  }

  return { chosen, skips, scanned, exhausted, timedOut, capped };
}

/**
 * Mark every pending row whose address is already a Contact as skipped.
 *
 * Without this, a sheet that overlaps an earlier import keeps its dead rows in
 * the pending pool forever: the release scan rediscovers them on every run, the
 * queued count overstates what is actually sendable, and a long enough run of
 * them hits the scan cap before a single usable row is reached.
 *
 * Runs once when the upload finishes and can be re-run at any time — contacts
 * are created and deleted independently of campaigns, so this is a reconcile,
 * not a one-off migration. Idempotent by construction: it only ever moves rows
 * from `pending` to `skipped`.
 *
 * Deliberately NOT part of previewNextBatch, which must stay a pure read.
 */
async function reconcileDuplicates(campaignId, { budget, batchSize = 500, trigger = 'manual' } = {}) {
  const id = oid(campaignId);
  const startedAt = new Date();
  let cursor = -1;
  let scanned = 0;
  let marked = 0;
  let complete = false;

  while (!(budget && budget.expired())) {
    const window = await CampaignRow.find(
      { campaignId: id, status: 'pending', rowIndex: { $gt: cursor } },
      { email: 1, rowIndex: 1 }
    ).sort({ rowIndex: 1 }).limit(batchSize).lean();

    if (window.length === 0) { complete = true; break; }
    scanned += window.length;
    cursor = window[window.length - 1].rowIndex;

    // Same predicate and collation as lib/contactImport.js, so this can never
    // disagree with the authoritative dedupe at send time.
    const emails = window.map(r => r.email).filter(e => e && EMAIL_RE.test(e));
    if (emails.length === 0) continue;
    const hits = await Contact.find(
      { email: { $in: emails }, deleted: { $ne: true } }, { email: 1 }
    ).collation({ locale: 'en', strength: 2 }).lean();
    if (hits.length === 0) continue;

    const taken = new Set(hits.map(c => String(c.email).trim().toLowerCase()));
    const dead = window.filter(r => taken.has(r.email)).map(r => r._id);
    if (dead.length) {
      const res = await CampaignRow.updateMany(
        { _id: { $in: dead }, status: 'pending' },
        { $set: { status: 'skipped', skipReason: 'duplicate_contact' } }
      );
      marked += res.modifiedCount || 0;
    }
  }

  if (marked > 0) {
    const [pending, skipped] = await Promise.all([
      CampaignRow.countDocuments({ campaignId: id, status: 'pending' }),
      CampaignRow.countDocuments({ campaignId: id, status: 'skipped' }),
    ]);
    // Logged so a campaign that quietly loses a third of its sheet at upload
    // time can be explained later, rather than looking like rows went missing.
    await Campaign.updateOne({ _id: id }, {
      $set: { 'stats.pending': pending, 'stats.skipped': skipped },
      $push: { releases: { $each: [{
        kind: 'reconcile', trigger,
        releasedOn: istDateKey(), jobId: null,
        released: 0, skipped: marked, scanned,
        exhausted: complete, error: null,
        startedAt, finishedAt: new Date(),
      }], $slice: -60 } },
    });
  }

  return { scanned, marked, complete };
}

/** A full dry run of the release path: zero writes, identical rendering. */
async function previewNextBatch(campaignId, { limit } = {}) {
  const campaign = await Campaign.findOne({ _id: oid(campaignId), deleted: { $ne: true } }).lean();
  if (!campaign) return null;

  const want = Math.max(1, Number(limit) || campaign.contactsPerDay || 20);
  const budget = deadline(30_000);
  const [{ chosen, skips, scanned, exhausted, timedOut, capped }, ctx] = await Promise.all([
    scanForBatch(campaign._id, want, budget),
    loadRenderContext({ templateKey: campaign.templateKey }),
  ]);

  const remainingPending = await CampaignRow.countDocuments({
    campaignId: oid(campaignId), status: 'pending',
  });

  return {
    campaignId: String(campaign._id),
    date: istDateKey(),
    templateMissing: !ctx.template,
    // Byte-identical to what will send, because it is literally the same call.
    willRelease: chosen.map(r => ({
      id: String(r._id), rowIndex: r.rowIndex, sourceRow: r.sourceRow,
      name: r.name, email: r.email, company: r.company, role: r.role,
      extras: r.extras || [],
      ...renderTemplate(ctx.template, r, ctx.sender, r.extras),
    })),
    willSkip: skips.map(s => ({
      id: String(s.row._id), rowIndex: s.row.rowIndex, sourceRow: s.row.sourceRow,
      name: s.row.name, email: s.row.email, reason: s.reason,
    })),
    scanned, exhausted, remainingPending,
    // Distinguishes "the sheet is finished" from "we ran out of time" and from
    // "we read a long stretch of unusable rows" — three states that all yield an
    // empty batch and must never be reported as the same thing.
    timedOut, capped,
    skipBreakdown: skips.reduce((m, s2) => { m[s2.reason] = (m[s2.reason] || 0) + 1; return m; }, {}),
  };
}

// ── Gmail headroom (displayed, never enforced) ──────────────────────────────

/**
 * What today already owes Gmail, across EVERYTHING — campaigns and manual Step 3
 * sends alike, because it reads SendJob globally rather than campaign bookkeeping.
 *
 * Counts scheduled-but-unsent items too: a drip fanned out over ten hours is a
 * promise Gmail has not yet been asked to keep, and counting only `sent` would
 * let three campaigns each pass the check and collectively blow past the cap.
 */
async function sendHeadroom() {
  const since = new Date(new Date(istDateKey() + 'T00:00:00.000Z').getTime() - IST_OFFSET_MS);

  const recent = await SendJob.find(
    { 'items.processedAt': { $gte: since } }, { items: 1 }
  ).lean();
  const sentToday = recent.reduce((n, j) => n + j.items.filter(
    i => i.status === 'sent' && i.processedAt && new Date(i.processedAt) >= since
  ).length, 0);

  const live = await SendJob.find(
    { status: { $in: ['pending', 'processing'] } }, { items: 1 }
  ).lean();
  const inFlight = live.reduce((n, j) => n + j.items.filter(i => i.status === 'pending').length, 0);

  return {
    dailyCap: DAILY_SEND_CAP,
    sentToday,
    inFlight,
    headroom: Math.max(0, DAILY_SEND_CAP - sentToday - inFlight),
    todayIst: istDateKey(),
  };
}

// ── Sending timeline ────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Bucket key in IST: 'YYYY-MM-DD' for a day, 'YYYY-MM-DDTHH' for an hour. */
const bucketKey = (ms, granularity) => {
  const iso = new Date(ms + IST_OFFSET_MS).toISOString();
  return granularity === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10);
};

/**
 * What has been sent and what is still coming, on one timeline.
 *
 * Always computed at HOURLY resolution and rolled up afterwards, because a day's
 * peak rate cannot be recovered from a daily total — and the peak is the number
 * that decides whether Gmail is happy.
 *
 * Three sources feed it:
 *   past      — SendJob items already marked sent, by processedAt
 *   in-flight — pending items of live jobs; the drip fanned them out at creation
 *               with a fixed spacing, so item i is due at createdAt + i*delay
 *   projected — future batches of running campaigns, spread across each batch at
 *               its own ratePerHour
 */
const TIMELINE_RANGES = {
  '24h': { granularity: 'hour', pastMs: 24 * HOUR_MS, futureMs: 48 * HOUR_MS },
  '7d':  { granularity: 'day',  pastMs: 7 * DAY_MS,   futureMs: 14 * DAY_MS },
  '30d': { granularity: 'day',  pastMs: 30 * DAY_MS,  futureMs: 30 * DAY_MS },
};

async function buildTimeline({ range = '7d', scope = 'all' } = {}) {
  const preset = TIMELINE_RANGES[range] || TIMELINE_RANGES['7d'];
  const { granularity } = preset;
  const now = Date.now();
  const pastMs = preset.pastMs;
  const futureMs = preset.futureMs;
  const from = now - pastMs;
  const to = now + futureMs;

  // Campaign-created jobs are identifiable from each campaign's release log, so
  // scoping needs no new field on SendJob and still covers historical batches.
  let jobFilter = {};
  if (scope === 'campaigns') {
    const camps = await Campaign.find({ deleted: { $ne: true } }, { releases: 1 }).lean();
    const ids = new Set();
    for (const c of camps) {
      for (const r of (c.releases || [])) if (r.jobId) ids.add(String(r.jobId));
    }
    // An empty set must match nothing, not everything.
    jobFilter = { _id: { $in: [...ids].map(id => {
      try { return new mongoose.Types.ObjectId(id); } catch (_) { return null; }
    }).filter(Boolean) } };
  }

  const hours = new Map();   // hourKey -> { sent, scheduled }
  const bump = (ms, field, n = 1) => {
    if (ms < from || ms > to) return;
    const k = bucketKey(ms, 'hour');
    const cur = hours.get(k) || { sent: 0, scheduled: 0 };
    cur[field] += n;
    hours.set(k, cur);
  };

  // Past: anything actually sent inside the window.
  const doneJobs = await SendJob.find(
    { ...jobFilter, 'items.processedAt': { $gte: new Date(from) } },
    { items: 1 },
  ).lean();
  for (const j of doneJobs) {
    for (const it of j.items) {
      if (it.status !== 'sent' || !it.processedAt) continue;
      bump(new Date(it.processedAt).getTime(), 'sent');
    }
  }

  // In flight: already handed to Inngest, spacing fixed at fan-out time.
  const liveJobs = await SendJob.find(
    { ...jobFilter, status: { $in: ['pending', 'processing'] } },
    { items: 1, createdAt: 1, ratePerHour: 1, sendMode: 1 },
  ).lean();
  for (const j of liveJobs) {
    const delay = j.sendMode === 'drip' ? HOUR_MS / Math.max(1, j.ratePerHour || 5) : 1500;
    const base = new Date(j.createdAt).getTime();
    j.items.forEach((it, i) => {
      if (it.status !== 'pending') return;
      bump(Math.max(now, base + i * delay), 'scheduled');
    });
  }

  // Projected: batches that have not been created yet.
  const campaigns = await Campaign.find(
    { deleted: { $ne: true }, status: 'running' },
    { contactsPerDay: 1, ratePerHour: 1, runHourIst: 1, lastReleaseOn: 1, stats: 1, name: 1 },
  ).lean();

  for (const c of campaigns) {
    let remaining = (c.stats && c.stats.pending) || 0;
    if (remaining <= 0) continue;
    const per = Math.max(1, c.contactsPerDay || 20);
    const delay = HOUR_MS / Math.max(1, c.ratePerHour || 5);

    // First future batch: the next IST day whose hour has not already been used.
    const istNow = new Date(now + IST_OFFSET_MS);
    let day = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
      c.runHourIst || 0, RELEASE_MINUTE_IST, 0) - IST_OFFSET_MS;
    // Already released today, or today's slot has passed -> start tomorrow.
    if (day <= now || c.lastReleaseOn === istDateKey()) day += DAY_MS;

    while (remaining > 0 && day <= to) {
      const n = Math.min(per, remaining);
      for (let i = 0; i < n; i++) bump(day + i * delay, 'scheduled');
      remaining -= n;
      day += DAY_MS;
    }
  }

  // Roll the hourly map up to the requested granularity, keeping the peak hour.
  const buckets = new Map();
  for (const [hourK, v] of hours) {
    const k = granularity === 'hour' ? hourK : hourK.slice(0, 10);
    const cur = buckets.get(k) || { sent: 0, scheduled: 0, peakSent: 0, peakScheduled: 0 };
    cur.sent += v.sent;
    cur.scheduled += v.scheduled;
    cur.peakSent = Math.max(cur.peakSent, v.sent);
    cur.peakScheduled = Math.max(cur.peakScheduled, v.scheduled);
    buckets.set(k, cur);
  }

  // Emit a contiguous series — gaps must read as zero, not as missing time.
  const step = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const out = [];
  const startAligned = granularity === 'hour'
    ? Math.floor(from / HOUR_MS) * HOUR_MS
    : new Date(bucketKey(from, 'day') + 'T00:00:00.000Z').getTime() - IST_OFFSET_MS;
  for (let t = startAligned; t <= to; t += step) {
    const k = bucketKey(t, granularity);
    const v = buckets.get(k) || { sent: 0, scheduled: 0, peakSent: 0, peakScheduled: 0 };
    out.push({ key: k, t, ...v, past: t < now });
  }

  return {
    range,
    scope,
    granularity,
    now,
    from: startAligned,
    to,
    dailyCap: DAILY_SEND_CAP,
    buckets: out,
  };
}

// ── Release ─────────────────────────────────────────────────────────────────

/** Did the previous batch fail so completely that releasing again is pointless? */
async function circuitTripped(campaign) {
  if (!campaign.lastJobId) return null;
  const job = await SendJob.findById(campaign.lastJobId, { items: 1, status: 1 }).lean();
  if (!job || !job.items || job.items.length === 0) return null;
  const done = job.items.filter(i => i.status !== 'pending');
  if (done.length < job.items.length) return null;   // still sending; judge it later
  const failed = done.filter(i => i.status === 'failed').length;
  if (failed / done.length < CIRCUIT_FAIL_RATIO) return null;
  return `The previous batch failed almost entirely (${failed}/${done.length} emails). `
       + 'Check the Gmail credentials and mailbox, then resume the campaign.';
}

/**
 * Release one day's batch.
 *
 * The ORDER of operations is the crash-safety design:
 *   lastReleaseOn is stamped AFTER the rows are claimed but BEFORE anything is
 *   sent. lib/postingSync.js stamps last because its work is idempotent; ours
 *   sends email, so a crash must cost a LOST DAY (recoverable via run-now with
 *   force), never a DOUBLE SEND (not recoverable).
 */
async function releaseCampaign(campaignId, { trigger = 'cron', force = false, budget } = {}) {
  const today = istDateKey();
  const startedAt = new Date();

  const claim = await claimCampaign(campaignId, today, force);
  if (!claim.ok) return { ok: false, reason: 'locked_or_already_released', campaignId: String(campaignId) };

  const campaign = claim.campaign;
  const id = oid(campaignId);
  const report = {
    ok: false, campaignId: String(id), name: campaign.name, trigger,
    releasedOn: today, released: 0, skipped: 0, scanned: 0,
    exhausted: false, jobId: null, error: null,
    startedAt: startedAt.toISOString(), finishedAt: null,
  };

  try {
    await sweepStaleClaims(id);

    // Fail fast, before anything is created, if the template is gone.
    const ctx = await loadRenderContext({ templateKey: campaign.templateKey });
    if (!ctx.template) {
      throw new Error(`Template "${campaign.templateKey}" no longer exists. `
                    + 'Pick a different template in the campaign setup.');
    }

    const tripped = await circuitTripped(campaign);
    if (tripped) throw new Error(tripped);

    const want = Math.max(1, campaign.contactsPerDay || 20);
    const scan = await scanForBatch(id, want, budget);
    report.scanned = scan.scanned;
    report.exhausted = scan.exhausted;

    // Mark the losers before anything else — they are settled either way.
    if (scan.skips.length) {
      await CampaignRow.bulkWrite(scan.skips.map(s => ({
        updateOne: {
          filter: { _id: s.row._id, status: 'pending' },
          update: { $set: { status: 'skipped', skipReason: s.reason } },
        },
      })), { ordered: false });
      report.skipped = scan.skips.length;
    }

    if (scan.chosen.length === 0) {
      const left = await CampaignRow.countDocuments({ campaignId: id, status: 'pending' });
      const done = left === 0;
      // Only burn the day when the answer is genuinely "nobody to send to".
      //
      // A scan that ran out of time, or that stopped at its row cap with usable
      // rows still further down, has NOT answered the question — stamping
      // lastReleaseOn there would silently cancel the real release and lose a
      // day's sending for a reason that has nothing to do with the contacts.
      // Leaving it unstamped lets the next hourly fire pick up where this left
      // off; the cap path marks rows skipped as it goes, so it always advances
      // and cannot loop.
      const conclusive = done || (!scan.timedOut && !scan.capped);
      await Campaign.updateOne({ _id: id }, {
        $set: {
          lastReleaseAt: new Date(), lastError: null,
          ...(conclusive ? { lastReleaseOn: today } : {}),
          ...(done ? { status: 'completed', completedAt: new Date() } : {}),
        },
        $push: { releases: { $each: [{ ...toReleaseEntry(report, startedAt) }], $slice: -60 } },
      });
      report.ok = true;
      report.retryable = !conclusive;
      report.timedOut = !!scan.timedOut;
      report.capped = !!scan.capped;
      report.finishedAt = new Date().toISOString();
      return report;
    }

    // ── The point of no return ───────────────────────────────────────────────
    const releaseId = crypto.randomUUID();
    const claimedAt = new Date();
    await CampaignRow.updateMany(
      { _id: { $in: scan.chosen.map(r => r._id) }, status: 'pending' },
      { $set: { status: 'queued', releaseId, claimedAt } }
    );
    // The day is now burned. A crash past this line costs a day, never a re-send.
    await Campaign.updateOne({ _id: id }, {
      $set: { lastReleaseOn: today, lastReleaseAt: new Date() },
    });

    // importContacts is the authoritative dedupe chokepoint (lib/contactImport.js).
    // Contact.name is required and it uses a bare insertMany, so one empty name
    // would abort the whole batch — guarantee one here, as routes/leads.js does.
    const rows = scan.chosen.map(r => ({
      name: r.name || r.email.split('@')[0],
      email: r.email,
      company: r.company || '',
      role: r.role || '',
      template: campaign.templateKey,
    }));
    const { created } = await importContacts(rows);
    const madeByEmail = new Map(created.map(c => [c.email, c]));

    const releasedRows = scan.chosen.filter(r => madeByEmail.has(r.email));
    const lostToRace = scan.chosen.filter(r => !madeByEmail.has(r.email));
    // Someone created these between the scan and the import. A slightly short day
    // is harmless; re-looping inside a 60s budget is not.
    if (lostToRace.length) {
      await CampaignRow.updateMany(
        { _id: { $in: lostToRace.map(r => r._id) } },
        { $set: { status: 'skipped', skipReason: 'duplicate_contact', releaseId: null, claimedAt: null } }
      );
      report.skipped += lostToRace.length;
    }

    if (releasedRows.length === 0) {
      throw new Error('Every contact in this batch already existed — nothing to send.');
    }

    // contactId BEFORE the SendJob exists: this is what makes sweepStaleClaims
    // unambiguous if we die in the next few lines.
    await CampaignRow.bulkWrite(releasedRows.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { contactId: String(madeByEmail.get(r.email)._id) } },
      },
    })), { ordered: false });

    await Contact.updateMany(
      { _id: { $in: created.map(c => c._id) } },
      {
        $set: { status: 'queued', approvalStatus: 'approved' },
        $push: { statusHistory: { status: 'queued', changedAt: new Date(),
                                  note: `Released by campaign "${campaign.name}"` } },
      }
    );

    const items = releasedRows.map(r => {
      const c = madeByEmail.get(r.email);
      const { subject, body } = renderTemplate(ctx.template, c, ctx.sender, r.extras);
      return { contactId: String(c._id), to: c.email, name: c.name, subject, body };
    // SendJob.items marks subject and body required — one empty string would
    // abort the entire create, taking the whole batch with it.
    }).filter(i => i.subject && i.body);

    if (items.length === 0) {
      throw new Error('The template rendered empty for every contact in this batch.');
    }

    // Credentials come from GMAIL_EMAIL/GMAIL_APP_PASSWORD, which lib/mailer.js
    // seeds at module load — the only source reliably present on a cold start.
    // (/api/config writes to a per-instance singleton a cron would never see.)
    const job = await SendJob.create({
      items,
      attachResume: !!campaign.attachResume,
      senderEmail:       mailer.senderConfig.email || '',
      senderName:        ctx.sender.name || mailer.senderConfig.name || '',
      senderAppPassword: mailer.senderAppPassword || '',
      sendMode: 'drip',
      ratePerHour: campaign.ratePerHour || 5,
    });
    report.jobId = job.id.toString();

    let queueError = null;
    try {
      await inngest.send({ name: 'email/drip.start', data: { jobId: job.id.toString() } });
    } catch (err) {
      // Same handling as routes/jobs.js: the row exists but nothing will process
      // it. The Contacts DO exist and are queued+approved — exactly the state the
      // normal Step 3 flow wants — so never delete them; say so instead.
      await SendJob.findByIdAndUpdate(job.id, { status: 'cancelled' });
      queueError = `Could not queue the send: ${err.message}. `
                 + 'The contacts were created and can be sent from the Send wizard.';
    }

    const now = new Date();
    await CampaignRow.updateMany(
      { _id: { $in: releasedRows.map(r => r._id) } },
      { $set: {
          status: 'released',
          jobId: queueError ? null : job.id.toString(),
          ...(queueError ? { skipReason: 'queue_failed' } : {}),
          releasedAt: now, releasedOn: today,
      } }
    );

    report.released = releasedRows.length;
    report.error = queueError;
    report.ok = !queueError;
    report.finishedAt = new Date().toISOString();

    const left = await CampaignRow.countDocuments({ campaignId: id, status: 'pending' });
    await Campaign.updateOne({ _id: id }, {
      $set: {
        lastJobId: report.jobId,
        lastError: queueError,
        ...(left === 0 ? { status: 'completed', completedAt: new Date() } : {}),
      },
      $inc: { 'stats.released': report.released, 'stats.skipped': report.skipped,
              'stats.pending': -(report.released + report.skipped) },
      $push: { releases: { $each: [toReleaseEntry(report, startedAt)], $slice: -60 } },
    });

    return report;
  } catch (err) {
    report.error = err.message;
    report.finishedAt = new Date().toISOString();
    await Campaign.updateOne({ _id: id }, {
      $set: { lastError: err.message, status: 'failed' },
      $push: { releases: { $each: [toReleaseEntry(report, startedAt)], $slice: -60 } },
    }).catch(() => {});
    return report;
  } finally {
    await releaseLease(id);
  }
}

const toReleaseEntry = (report, startedAt) => ({
  releasedOn: report.releasedOn,
  trigger: report.trigger,
  jobId: report.jobId,
  released: report.released,
  skipped: report.skipped,
  scanned: report.scanned,
  exhausted: report.exhausted,
  error: report.error,
  startedAt,
  finishedAt: new Date(),
});

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run every campaign whose IST hour has arrived and which has not released today.
 *
 * SEQUENTIAL, never parallel: the Mongoose pool is capped at 5 (db.js), and two
 * campaigns containing the same email must not both create a Contact — in order,
 * the second correctly sees a duplicate and tops up.
 */
async function runDueCampaigns({ campaignIds = null, trigger = 'cron', force = false } = {}) {
  const startedAt = new Date();
  const today = istDateKey();
  const hour = istHour();
  const budget = deadline(RUN_BUDGET_MS);

  const filter = {
    deleted: { $ne: true },
    status: 'running',
    ...(campaignIds ? { _id: { $in: campaignIds.map(oid) } } : {}),
    ...(force ? {} : {
      runHourIst: { $lte: hour },
      $or: [
        { lastReleaseOn: null },
        { lastReleaseOn: { $exists: false } },
        { lastReleaseOn: { $ne: today } },
      ],
    }),
  };

  const due = await Campaign.find(filter, { _id: 1, name: 1 }).sort({ createdAt: 1 }).lean();

  const reports = [];
  const deferred = [];
  for (const c of due) {
    if (budget.expired()) { deferred.push({ campaignId: String(c._id), name: c.name }); continue; }
    reports.push(await releaseCampaign(c._id, { trigger, force, budget }));
  }

  const finishedAt = new Date();
  return {
    ok: true,
    todayIst: today,
    hourIst: hour,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ms: finishedAt - startedAt,
    // Reported so the cron log says why a campaign was passed over, not just that
    // it was. Deferred campaigns are untouched — no lease, no stamp.
    deferred,
    campaigns: reports,
    totals: {
      due: due.length,
      ran: reports.length,
      deferred: deferred.length,
      released: reports.reduce((n, r) => n + (r.released || 0), 0),
      skipped: reports.reduce((n, r) => n + (r.skipped || 0), 0),
      errored: reports.filter(r => r.error).length,
    },
  };
}

module.exports = {
  runDueCampaigns,
  buildTimeline,
  TIMELINE_RANGES,
  reconcileDuplicates,
  releaseCampaign,
  previewNextBatch,
  sendHeadroom,
  scanForBatch,
  istDateKey,
  istHour,
  EMAIL_RE,
  DAILY_SEND_CAP,
};
