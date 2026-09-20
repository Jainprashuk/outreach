/**
 * Fleet-wide admin.
 *
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT QUERIES ACROSS USERS. Every other
 * route filters `{ userId: req.userId }`, and that convention is what keeps
 * accounts apart. Two invariants make the exception safe, and
 * scripts/test-admin-isolation.js asserts both:
 *
 *   1. The whole router sits behind requireAdmin.
 *   2. EVERY LEAF THIS FILE EMITS IS A NUMBER, DATE, BOOLEAN, ENUM KEY, OR A
 *      USER'S OWN EMAIL/NAME. No contact name, no company, no subject line, no
 *      email body, no reply text, no token, no hash. The pipelines below $group
 *      and count; none of them $push a document or $first a text field.
 *
 * Deliberately aggregates-only: there is no drill-in to another account's rows
 * and no impersonation. Support questions get answered with counts.
 */
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Session = require('../models/Session');
const Settings = require('../models/Settings');
const Template = require('../models/Template');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');
const ScrapeRun = require('../models/ScrapeRun');
const SendJob = require('../models/SendJob');
const Interview = require('../models/Interview');
const ActivityLog = require('../models/ActivityLog');
const LoginCode = require('../models/LoginCode');
const AccessRequest = require('../models/AccessRequest');
const { destroyAllForUser } = require('../lib/session');
const { logEvent } = require('../lib/activityLog');
const { sendAccessApproved } = require('../lib/emailOtp');
const { ONBOARDING_VERSION } = require('../lib/onboarding');

const router = express.Router();

const id = (v) => (v == null ? null : String(v));

/**
 * Count documents per user, broken down by one enum field, in a single pass.
 *
 * The two-stage $group into $arrayToObject is deliberate: it survives an enum
 * gaining a value without anyone editing this file, which a dozen hand-written
 * $cond branches would not.
 *
 * `deleted: { $ne: true }` is safe on collections that have no such field — a
 * missing field is not equal to true.
 *
 * NOTE: $arrayToObject throws if a key contains a dot or starts with $. None of
 * the five enums used here do, and $ifNull covers null, but an enum that ever
 * grows free-form values would take this endpoint down with it.
 */
const countByUserAnd = (Model, field, extraInner = {}, extraOuter = {}) => Model.aggregate([
  { $match: { deleted: { $ne: true } } },   // DELIBERATELY UNSCOPED — see file header
  { $group: {
    _id: { u: '$userId', k: { $ifNull: [`$${field}`, 'unknown'] } },
    n: { $sum: 1 },
    ...extraInner,
  } },
  { $group: {
    _id: '$_id.u',
    total: { $sum: '$n' },
    rows: { $push: { k: '$_id.k', v: '$n' } },
    ...extraOuter,
  } },
  { $project: {
    _id: 1, total: 1, by: { $arrayToObject: '$rows' },
    ...Object.fromEntries(Object.keys(extraOuter).map(k => [k, 1])),
  } },
]);

const byUser = (rows) => new Map(rows.map(r => [id(r._id), r]));

/**
 * GET /api/admin/users
 *
 * One read for the whole dashboard. The fleet totals are a fold over the
 * per-user rows, so a separate overview endpoint would double the cost for no
 * extra information.
 *
 * Round trips are constant (~11) regardless of how many accounts exist. The
 * obvious alternative — loop the users, query each collection per user — is
 * N×11 round trips through a 5-connection pool, which at 50 accounts is 110
 * serialised waves and will not finish inside the platform's 60s cap.
 */
router.get('/users', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      users, contacts, campaigns, leads, scrapes, sendJobs, interviews,
      templates, settings, sessions, activity, series, signups,
    ] = await Promise.all([
      // The ONLY source of identity in this file, and the only place a string
      // leaves it. .lean() BYPASSES the toJSON transform in models/User.js, so
      // the token hashes are NOT stripped for us — they are projected in here
      // purely to become booleans, and must never reach the response.
      User.find({}, {
        email: 1, name: 1, createdAt: 1, lastLoginAt: 1, isAdmin: 1, status: 1,
        onboarding: 1, workerTokenHash: 1, shareTokenHash: 1,
      }).sort({ createdAt: 1 }).lean(),

      countByUserAnd(Contact, 'status',
        {
          // Two traps live in these three lines.
          //
          // $sum, NOT $max: $max collapses each status group to a 0/1 flag, and
          // summing the group's SIZE against that flag counts every contact in
          // any group containing a single sent one.
          //
          // And $ifNull is load-bearing. In aggregation a MISSING field is
          // undefined, which does NOT equal null — so a bare
          // `$ne: ['$lastSentAt', null]` counts every contact that has never
          // had the field at all. That is the opposite of the query language,
          // where `{ lastSentAt: { $ne: null } }` excludes missing too, and the
          // mismatch is silent: it just inflates the number.
          sent: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$lastSentAt', null] }, null] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$repliedAt', null] }, null] }, 1, 0] } },
          followedUp: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$followUpSentAt', null] }, null] }, 1, 0] } },
          lastSentAt: { $max: '$lastSentAt' },
        },
        {
          everSent: { $sum: '$sent' },
          everReplied: { $sum: '$replied' },
          everFollowedUp: { $sum: '$followedUp' },
          lastSentAt: { $max: '$lastSentAt' },
        }),
      countByUserAnd(Campaign, 'status'),
      countByUserAnd(Lead, 'applyStatus'),
      countByUserAnd(ScrapeRun, 'status', { last: { $max: '$createdAt' } }, { lastRunAt: { $max: '$last' } }),
      countByUserAnd(SendJob, 'status'),
      countByUserAnd(Interview, 'status'),

      Template.aggregate([{ $group: { _id: '$userId', total: { $sum: 1 } } }]),

      // Health, never content. resume.filename is tested but never returned,
      // and resume.data is never touched — pulling those Buffers fleet-wide
      // would be catastrophic on a small instance.
      Settings.aggregate([
        { $group: {
          _id: '$userId',
          // > 1 means the unique index on userId is missing. A live alarm for
          // the duplicate-Settings bug, surfaced where someone will see it.
          docs: { $sum: 1 },
          hasGmail: { $max: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$gmailAppPasswordEnc', ''] } }, 0] }, 1, 0] } },
          hasResume: { $max: { $cond: [{ $ifNull: ['$resume.filename', false] }, 1, 0] } },
          lastMailboxCheckAt: { $max: '$lastMailboxCheckAt' },
        } },
      ]),

      Session.aggregate([
        { $match: { expiresAt: { $gt: new Date() } } },
        { $group: { _id: '$userId', active: { $sum: 1 }, newest: { $max: '$createdAt' } } },
      ]),

      ActivityLog.aggregate([
        { $facet: {
          all: [{ $group: { _id: '$userId', events: { $sum: 1 }, lastEventAt: { $max: '$createdAt' } } }],
          recent: [{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$userId', events: { $sum: 1 } } }],
        } },
      ]),

      // Fleet trend. Uses the scalar timestamps rather than statusHistory:
      // $unwind-ing that array across every tenant is the one query here that
      // could genuinely exceed the platform time limit.
      //
      // CAVEAT, and the reason the chart says "trend": lastSentAt is
      // OVERWRITTEN by a follow-up, so this undercounts initial sends for
      // contacts that were later followed up. client/src/lib/analytics.ts gets
      // it exactly right per-user because it has the full history to work from.
      Contact.aggregate([
        { $match: {
          deleted: { $ne: true },
          $or: [{ lastSentAt: { $gte: since } }, { repliedAt: { $gte: since } }],
        } },
        { $facet: {
          sent: [
            { $match: { lastSentAt: { $gte: since } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$lastSentAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
          ],
          replied: [
            { $match: { repliedAt: { $gte: since } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$repliedAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
          ],
        } },
      ]),

      User.aggregate([
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Folded into this response rather than left to a second request, so the
    // dashboard cannot render without showing that somebody is waiting.
    const pendingRequests = await AccessRequest.countDocuments({ status: 'pending' });

    const cMap = byUser(contacts), kMap = byUser(campaigns), lMap = byUser(leads);
    const rMap = byUser(scrapes), jMap = byUser(sendJobs), iMap = byUser(interviews);
    const tMap = byUser(templates), sMap = byUser(settings), zMap = byUser(sessions);
    const aMap = byUser(activity[0]?.all || []), aRecent = byUser(activity[0]?.recent || []);

    const blank = { total: 0, by: {} };
    const buildRow = (key, base) => ({
      ...base,
      contacts: {
        ...(cMap.get(key) || blank),
        everSent: (cMap.get(key) || {}).everSent || 0,
        everReplied: (cMap.get(key) || {}).everReplied || 0,
        everFollowedUp: (cMap.get(key) || {}).everFollowedUp || 0,
        lastSentAt: (cMap.get(key) || {}).lastSentAt || null,
      },
      campaigns: kMap.get(key) || blank,
      leads: lMap.get(key) || blank,
      scrapes: { ...(rMap.get(key) || blank), lastRunAt: (rMap.get(key) || {}).lastRunAt || null },
      sendJobs: jMap.get(key) || blank,
      interviews: iMap.get(key) || blank,
      activity: {
        events: (aMap.get(key) || {}).events || 0,
        events30d: (aRecent.get(key) || {}).events || 0,
        lastEventAt: (aMap.get(key) || {}).lastEventAt || null,
      },
    });

    const rows = users.map((u) => {
      const key = id(u._id);
      const set = sMap.get(key) || {};
      return buildRow(key, {
        id: key,
        email: u.email,
        name: u.name || '',
        isAdmin: u.isAdmin === true,
        status: u.status || 'active',
        createdAt: u.createdAt || null,
        lastLoginAt: u.lastLoginAt || null,
        activeSessions: (zMap.get(key) || {}).active || 0,
        onboarding: {
          completedAt: (u.onboarding && u.onboarding.completedAt) || null,
          step: (u.onboarding && u.onboarding.step) || 0,
          skipped: (u.onboarding && u.onboarding.skipped) || [],
          current: (u.onboarding && (u.onboarding.version || 0) >= ONBOARDING_VERSION),
        },
        config: {
          hasGmail: !!set.hasGmail,
          hasResume: !!set.hasResume,
          settingsDocs: set.docs || 0,
          templates: (tMap.get(key) || {}).total || 0,
          // Mapped to booleans and the hashes dropped in the same breath. This
          // is the single most likely leak in the file.
          hasWorkerToken: typeof u.workerTokenHash === 'string',
          hasShareToken: typeof u.shareTokenHash === 'string',
          lastMailboxCheckAt: set.lastMailboxCheckAt || null,
        },
      });
    });

    // Documents whose userId is null predate the multi-tenant backfill. They
    // belong to nobody and are invisible to every account, so they are surfaced
    // here rather than silently dropped from the totals.
    const orphan = buildRow('null', { id: null, email: '(unassigned)', name: '', isAdmin: false, status: 'n/a' });
    const hasOrphans = ['contacts', 'campaigns', 'leads', 'scrapes', 'sendJobs', 'interviews']
      .some(k => (orphan[k] || {}).total > 0);

    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    const everSent = sum(r => r.contacts.everSent);
    const everReplied = sum(r => r.contacts.everReplied);

    const days_ = new Map();
    for (const d of (series[0]?.sent || [])) days_.set(d._id, { day: d._id, sent: d.n, replied: 0 });
    for (const d of (series[0]?.replied || [])) {
      const row = days_.get(d._id) || { day: d._id, sent: 0, replied: 0 };
      row.replied = d.n; days_.set(d._id, row);
    }

    // The cross-tenant READ is the sensitive operation here, and
    // auditHttpMutations only logs mutations. Throttled to one row per admin per
    // ten minutes so a dashboard left open does not flood the activity log.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentRead = await ActivityLog.findOne({
      userId: req.userId, category: 'admin', action: 'read-fleet',
      createdAt: { $gt: tenMinutesAgo },
    }, { _id: 1 }).lean();
    if (!recentRead) {
      logEvent({
        userId: req.userId, category: 'admin', action: 'read-fleet',
        message: `Viewed fleet-wide totals for ${rows.length} account(s)`,
        meta: { accounts: rows.length, days },
      }).catch(() => {});
    }

    res.json({
      generatedAt: new Date(),
      days,
      users: rows,
      unassigned: hasOrphans ? orphan : null,
      totals: {
        users: rows.length,
        active: rows.filter(r => r.status === 'active').length,
        invited: rows.filter(r => r.status === 'invited').length,
        disabled: rows.filter(r => r.status === 'disabled').length,
        onboarded: rows.filter(r => r.onboarding.completedAt).length,
        withGmail: rows.filter(r => r.config.hasGmail).length,
        contacts: sum(r => r.contacts.total),
        everSent,
        everReplied,
        replyRate: everSent ? Math.round((everReplied / everSent) * 1000) / 10 : 0,
        leads: sum(r => r.leads.total),
        campaigns: sum(r => r.campaigns.total),
        interviews: sum(r => r.interviews.total),
        activeSessions: sum(r => r.activeSessions),
        scrapeFailures: sum(r => (r.scrapes.by || {}).failed || 0),
        duplicateSettings: rows.filter(r => r.config.settingsDocs > 1).length,
        pendingRequests,
      },
      series: [...days_.values()].sort((a, b) => a.day.localeCompare(b.day)),
      signups: signups.map(s => ({ month: s._id, n: s.n })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Sign-in codes that could not be delivered — the only view of a mail outage. */
router.get('/otp-health', async (_req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failures = await LoginCode.find(
      { deliveryError: { $ne: null }, createdAt: { $gt: since } },
      { email: 1, deliveryError: 1, createdAt: 1 },
    ).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      since,
      failures: failures.map(f => ({ email: f.email, error: f.deliveryError, at: f.createdAt })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Whitelist an address. With OTP sign-in, creating the row IS the invitation. */
router.post('/users', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const name = String((req.body && req.body.name) || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email address is required' });

    const existing = await User.findOne({ email }, { _id: 1 }).lean();
    // Enumeration is moot here — the caller is already an admin and can list
    // every account anyway.
    if (existing) return res.status(409).json({ error: `${email} already has an account` });

    const user = await User.create({
      email, name,
      isAdmin: req.body.isAdmin === true,
      status: 'invited',
      invitedAt: new Date(),
      invitedBy: req.userId,
      onboarding: { startedAt: null, completedAt: null, step: 0, skipped: [], version: 0 },
    });

    logEvent({
      userId: req.userId, category: 'admin', action: 'invite',
      message: `Whitelisted ${email}`,
      meta: { targetUserId: String(user._id), targetEmail: email, isAdmin: req.body.isAdmin === true },
    }).catch(() => {});

    res.status(201).json({ ok: true, id: String(user._id), email: user.email, status: user.status });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'That address already has an account' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Enable, disable or change admin on one account.
 *
 * Disabling is the answer to "delete this account". A hard delete would have to
 * cascade sixteen collections with no transaction available and no undo, and a
 * partial one leaves orphans nobody can ever see. scripts/delete-account.js is
 * the place for that, deliberately offline.
 */
router.patch('/users/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid account id' });
    const target = await User.findById(req.params.id, { email: 1, isAdmin: 1, status: 1 }).lean();
    if (!target) return res.status(404).json({ error: 'No such account' });

    const isSelf = String(req.userId) === String(target._id);
    const wantsStatus = req.body && typeof req.body.status === 'string' ? req.body.status : null;
    const wantsAdmin = req.body && typeof req.body.isAdmin === 'boolean' ? req.body.isAdmin : null;

    if (wantsStatus && !['invited', 'active', 'disabled'].includes(wantsStatus)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    // Locking yourself out is recoverable only by editing the database by hand.
    if (isSelf && wantsStatus === 'disabled') {
      return res.status(400).json({ error: 'You cannot disable your own account.' });
    }
    if (isSelf && wantsAdmin === false) {
      return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    }

    // And neither may the last one go, or the install becomes unadministerable.
    const losingAnAdmin = target.isAdmin === true && (wantsAdmin === false || wantsStatus === 'disabled');
    if (losingAnAdmin) {
      const remaining = await User.countDocuments({ isAdmin: true, status: { $ne: 'disabled' }, _id: { $ne: target._id } });
      if (remaining < 1) return res.status(400).json({ error: 'That is the only active admin — promote someone else first.' });
    }

    const $set = {};
    if (wantsStatus) $set.status = wantsStatus;
    if (wantsAdmin !== null) $set.isAdmin = wantsAdmin;
    if (!Object.keys($set).length) return res.status(400).json({ error: 'Nothing to change' });

    await User.updateOne({ _id: target._id }, { $set });

    let revoked = 0;
    if (wantsStatus === 'disabled') {
      // requireAuth does not re-read status on every request — destroying the
      // sessions is what actually ends access. Without this a disabled user
      // stays signed in for up to thirty days.
      const result = await destroyAllForUser(target._id);
      revoked = (result && result.deletedCount) || 0;
    }

    const what = wantsStatus ? `status -> ${wantsStatus}` : `admin -> ${wantsAdmin}`;
    logEvent({
      userId: req.userId, category: 'admin', action: 'update-user',
      message: `${target.email}: ${what}`,
      meta: { targetUserId: String(target._id), targetEmail: target.email, ...$set, revoked },
    }).catch(() => {});
    // A second row owned by the person it happened TO. "Someone ended your
    // sessions" belongs in your own log; it names the action, not the admin's
    // other business.
    logEvent({
      userId: target._id, category: 'account', action: 'changed-by-admin',
      message: wantsStatus === 'disabled'
        ? `Your account was disabled and ${revoked} session(s) ended`
        : `An administrator changed your account (${what})`,
      meta: { ...$set },
    }).catch(() => {});

    res.json({ ok: true, revoked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Sign someone out everywhere. Cheap, reversible, and the most useful thing here. */
router.post('/users/:id/revoke-sessions', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid account id' });
    const target = await User.findById(req.params.id, { email: 1 }).lean();
    if (!target) return res.status(404).json({ error: 'No such account' });

    const result = await destroyAllForUser(target._id);
    const revoked = (result && result.deletedCount) || 0;

    logEvent({
      userId: req.userId, category: 'admin', action: 'revoke-sessions',
      message: `Ended ${revoked} session(s) for ${target.email}`,
      meta: { targetUserId: String(target._id), targetEmail: target.email, revoked },
    }).catch(() => {});
    logEvent({
      userId: target._id, category: 'account', action: 'sessions-revoked',
      message: `An administrator ended ${revoked} of your session(s)`,
      meta: { revoked },
    }).catch(() => {});

    res.json({ ok: true, revoked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Access requests ─────────────────────────────────────────────────────────
// People asking to be let in. Approving one creates their account; rejecting it
// is final, and re-asking does not reopen it (see lib/loginCode.js).

/** The queue. Defaults to pending, which is the only part needing attention. */
router.get('/access-requests', async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status)
      ? req.query.status : 'pending';
    const filter = status === 'all' ? {} : { status };
    const [requests, pendingCount] = await Promise.all([
      AccessRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
      AccessRequest.countDocuments({ status: 'pending' }),
    ]);
    res.json({
      pendingCount,
      requests: requests.map(r => ({
        id: String(r._id),
        email: r.email,
        name: r.name || '',
        note: r.note || '',
        status: r.status,
        requestCount: r.requestCount || 1,
        createdAt: r.createdAt,
        lastRequestedAt: r.lastRequestedAt || r.createdAt,
        decidedAt: r.decidedAt || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Approve: create the account, then tell them.
 *
 * The account is created FIRST and the email sent after. If the mail fails the
 * approval still stands and they can sign in — the reverse order would promise
 * access that does not exist yet.
 */
router.post('/access-requests/:id/approve', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid request id' });
    const reqDoc = await AccessRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'No such request' });
    if (reqDoc.status === 'approved') return res.status(409).json({ error: 'That request was already approved' });

    const existing = await User.findOne({ email: reqDoc.email }, { _id: 1 }).lean();
    let userId;
    if (existing) {
      // Someone whitelisted them by hand while the request was sitting in the
      // queue. Close it out rather than failing on the unique index.
      userId = existing._id;
    } else {
      const user = await User.create({
        email: reqDoc.email,
        name: reqDoc.name || '',
        isAdmin: false,
        status: 'invited',
        invitedAt: new Date(),
        invitedBy: req.userId,
        onboarding: { startedAt: null, completedAt: null, step: 0, skipped: [], version: 0 },
      });
      userId = user._id;
    }

    await AccessRequest.updateOne({ _id: reqDoc._id }, {
      $set: { status: 'approved', decidedAt: new Date(), decidedBy: req.userId },
    });

    // Never throws — see lib/emailOtp.js. The approval is done either way.
    const mail = await sendAccessApproved({
      to: reqDoc.email,
      appUrl: process.env.OUTREACH_URL || '',
    });

    logEvent({
      userId: req.userId, category: 'admin', action: 'approve-access',
      message: `Approved access for ${reqDoc.email}`,
      meta: { targetUserId: String(userId), targetEmail: reqDoc.email, emailed: mail.delivered === true },
    }).catch(() => {});

    res.json({
      ok: true,
      id: String(userId),
      email: reqDoc.email,
      emailed: mail.delivered === true,
      // Surfaced so the admin knows to tell them another way rather than
      // assuming the person has been notified.
      ...(mail.delivered === true ? {} : { warning: 'The account was created, but the notification email could not be sent.' }),
    });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'That address already has an account' });
    res.status(500).json({ error: err.message });
  }
});

/** Reject. Final, and deliberately not emailed to the requester. */
router.post('/access-requests/:id/reject', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid request id' });
    const reqDoc = await AccessRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'No such request' });
    if (reqDoc.status === 'approved') {
      return res.status(409).json({ error: 'That request was already approved — disable the account instead.' });
    }

    await AccessRequest.updateOne({ _id: reqDoc._id }, {
      $set: {
        status: 'rejected',
        decidedAt: new Date(),
        decidedBy: req.userId,
        decisionNote: String((req.body && req.body.note) || '').trim().slice(0, 500),
      },
    });

    logEvent({
      userId: req.userId, category: 'admin', action: 'reject-access',
      message: `Declined access for ${reqDoc.email}`,
      meta: { targetEmail: reqDoc.email },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Clear a decided request out of the list. Pending ones must be decided first. */
router.delete('/access-requests/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid request id' });
    const reqDoc = await AccessRequest.findById(req.params.id, { status: 1, email: 1 }).lean();
    if (!reqDoc) return res.status(404).json({ error: 'No such request' });
    if (reqDoc.status === 'pending') {
      return res.status(400).json({ error: 'Approve or decline it first.' });
    }
    // Deleting a REJECTED row lets that address ask again, which is the only way
    // back from a rejection. Deliberate: rejection is final, but not permanent.
    await AccessRequest.deleteOne({ _id: reqDoc._id });
    logEvent({
      userId: req.userId, category: 'admin', action: 'clear-access-request',
      message: `Cleared the ${reqDoc.status} request from ${reqDoc.email}`,
      meta: { targetEmail: reqDoc.email, was: reqDoc.status },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
