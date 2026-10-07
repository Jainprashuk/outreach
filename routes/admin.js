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
 *
 * ONE EXCEPTION, BY THE OWNER'S CHOICE (2026-10-08): the /issues endpoints at
 * the bottom of this file return raw error text — failed recipients, SMTP
 * replies, stack traces, request bodies — because a failure cannot be
 * diagnosed from a count. Invariant 2 above applies to everything else.
 * Credential-shaped keys are still redacted at write time (lib/issues.js).
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
const Issue = require('../models/Issue');
const CronBeat = require('../models/CronBeat');
const { buildTimeline, istDateKey, DAILY_SEND_CAP } = require('../lib/campaignRunner');
const { destroyAllForUser } = require('../lib/session');
const { logEvent } = require('../lib/activityLog');
const { sendAccessApproved } = require('../lib/emailOtp');
const { ONBOARDING_VERSION, checkReadiness } = require('../lib/onboarding');
const LifecycleEmail = require('../models/LifecycleEmail');
const { getLifecycleConfig, getLifecycleConfigWithHistory, setLifecycleSwitch } = require('../lib/lifecycle/config');
const { forecast, masterOnConfig } = require('../lib/lifecycle/forecast');
const { TYPES, TYPE_KEYS, isType, MANUAL_EMAILS_PER_DAY } = require('../lib/lifecycle/types');
const { istMidnight } = require('../lib/reportPeriod');
const { buildMessage } = require('../lib/lifecycle/deliver');
const { USER_FIELDS } = require('../lib/lifecycle/candidates');
const systemMail = require('../lib/systemMail');
const unsubscribe = require('../lib/lifecycle/unsubscribe');

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
        lastActiveAt: 1, emailOptOut: 1, emailBlockedByAdmin: 1,
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
        lastActiveAt: u.lastActiveAt || null,
        // Enum keys only: which email types are off for this account, and why.
        emails: {
          blockedByAdmin: (u.emailBlockedByAdmin || []).filter(isType),
          optOut: u.emailOptOut || [],
        },
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

    // Tell them, unless explicitly asked not to. Whitelisting somebody who
    // never asked is otherwise silent — they have no way to know the account
    // exists, and would only find out if you remembered to message them.
    // Same email as approving a request, because it is the same event to them.
    const notify = req.body.notify !== false;
    const mail = notify
      ? await sendAccessApproved({ to: email, appUrl: process.env.OUTREACH_URL || '' })
      : { delivered: false, skipped: true };

    logEvent({
      userId: req.userId, category: 'admin', action: 'invite',
      message: `Whitelisted ${email}`,
      meta: {
        targetUserId: String(user._id), targetEmail: email,
        isAdmin: req.body.isAdmin === true, emailed: mail.delivered === true,
      },
    }).catch(() => {});

    res.status(201).json({
      ok: true,
      id: String(user._id),
      email: user.email,
      status: user.status,
      emailed: mail.delivered === true,
      // The account exists either way — surfaced so the admin knows whether
      // they still have to tell the person themselves.
      ...(notify && mail.delivered !== true
        ? { warning: 'The account was created, but the notification email could not be sent.' }
        : {}),
    });
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

// ── Lifecycle emails ─────────────────────────────────────────────────────────
// Switches, counts and samples. Counts are grouped by enum keys (type, status,
// reason) only — no subject, no body, no error text, per the file header.

router.get('/emails', async (_req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [{ config, changes }, grouped, recentFailures] = await Promise.all([
      getLifecycleConfigWithHistory(),
      LifecycleEmail.aggregate([
        { $match: { createdAt: { $gte: since } } },   // DELIBERATELY UNSCOPED — see file header
        { $group: { _id: { t: '$type', s: '$status', r: { $ifNull: ['$reason', 'none'] } }, n: { $sum: 1 } } },
      ]),
      LifecycleEmail.find({ status: 'failed', createdAt: { $gte: since } }, { userId: 1, type: 1, attempts: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 }).limit(10).lean(),
    ]);

    const counts = Object.fromEntries(TYPE_KEYS.map(t => [t, { sent: 0, failed: 0, skipped: 0, testOnly: 0, skippedBy: {} }]));
    for (const g of grouped) {
      const c = counts[g._id.t];
      if (!c) continue;
      if (g._id.s === 'sent') c.sent += g.n;
      else if (g._id.s === 'failed') c.failed += g.n;
      else if (g._id.s === 'skipped') {
        if (g._id.r === 'test-mode') c.testOnly += g.n;
        else { c.skipped += g.n; c.skippedBy[g._id.r] = (c.skippedBy[g._id.r] || 0) + g.n; }
      }
    }

    const failUsers = await User.find({ _id: { $in: recentFailures.map(f => f.userId) } }, { email: 1 }).lean();
    const emailOf = new Map(failUsers.map(u => [id(u._id), u.email]));

    res.json({
      config,
      types: TYPE_KEYS.map(k => ({ key: k, label: TYPES[k].label })),
      counts,
      recentFailures: recentFailures.map(f => ({ email: emailOf.get(id(f.userId)) || '(deleted)', type: f.type, attempts: f.attempts, at: f.updatedAt })),
      changes: changes.map(c => ({ field: c.field, value: c.value, byEmail: c.byEmail, at: c.at })),
      readiness: {
        sender: systemMail.isConfigured(),
        links: !!unsubscribe.appUrl() && unsubscribe.isConfigured(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/emails', async (req, res) => {
  try {
    const { field, value } = req.body || {};
    const me = await User.findById(req.userId, { email: 1 }).lean();
    const config = await setLifecycleSwitch({ field: String(field || ''), value, admin: { id: req.userId, email: me.email } });
    logEvent({
      userId: req.userId, category: 'admin', action: 'lifecycle-switch',
      message: `Lifecycle emails: ${field} -> ${value ? 'on' : 'off'}`, meta: { field, value },
    }).catch(() => {});
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Which lifecycle emails fall due in the next few days, per sweep. Read-only:
 * the same forecast scripts/lifecycle-preview.js prints (lib/lifecycle/forecast.js),
 * minus the subject lines and report numbers — per the file header, only
 * account emails, enum keys and dates leave here.
 *
 * Each item answers twice: `now` with the switches as saved, `ifOn` as if the
 * master switch were on with everything else as saved.
 */
router.get('/emails/upcoming', async (req, res) => {
  try {
    const days = Math.min(7, Math.max(1, Number(req.query.days) || 3));
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const config = await getLifecycleConfig();
    const { runs, midSetup } = await forecast({ now, until, config, hypothetical: masterOnConfig(config, now) });

    // What a setup reminder would ask for — readiness keys, nothing else.
    const setupIds = runs.flatMap(r => r.items).filter(i => i.c.type === 'setup-reminder').map(i => i.c.userId);
    const settings = setupIds.length
      ? await Settings.find({ userId: { $in: setupIds } }, { userId: 1, gmailAppPasswordEnc: 1, senderName: 1 }).lean()
      : [];
    const missingOf = new Map(settings.map(st => [id(st.userId),
      Object.entries(checkReadiness(st)).filter(([, ok]) => !ok).map(([k]) => k)]));

    const verdict = (d) => ({ send: !!d.send, reason: d.reason || null, testMode: !!d.testMode });
    res.json({
      generatedAt: now,
      until,
      days,
      masterOn: !!config.enabled,
      runs: runs.map(r => ({
        at: r.at,
        kind: r.kind,
        items: r.items.map(({ c, dNow, dOn }) => ({
          userId: id(c.userId),
          email: c.user.email,
          name: c.user.name || '',
          type: c.type,
          due: c.due,
          ...(c.type === 'setup-reminder' ? { missing: missingOf.get(id(c.userId)) || ['gmail', 'identity'] } : {}),
          ...(c.type === 'inactive' ? { since: c.context.since } : {}),
          ...(c.type === 'weekly-report' ? { period: { from: c.context.period.from, to: c.context.period.to } } : {}),
          now: verdict(dNow),
          ifOn: verdict(dOn),
        })),
      })),
      midSetup: midSetup.map(u => ({ userId: id(u._id), email: u.email, name: u.name || '' })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The lifecycle send log, newest first: one row per slot (sent, skipped,
 * failed or claimed). Paged with `before` (an ISO date from the last row).
 * Leaves are enum keys, dates, counts and the account's own email — the
 * provider error text stays out, per the file header.
 */
router.get('/emails/log', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const q = {};   // DELIBERATELY UNSCOPED — see file header
    if (isType(String(req.query.type || ''))) q.type = String(req.query.type);
    if (['sent', 'skipped', 'failed', 'claimed'].includes(String(req.query.status || ''))) q.status = String(req.query.status);
    if (req.query.testMode === 'only') q.testMode = true;
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !Number.isNaN(before.getTime())) q.createdAt = { $lt: before };

    const rows = await LifecycleEmail.find(q, {
      userId: 1, type: 1, key: 1, status: 1, reason: 1, testMode: 1, attempts: 1, sentAt: 1, createdAt: 1, updatedAt: 1,
    }).sort({ createdAt: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    const users = await User.find({ _id: { $in: [...new Set(page.map(r => id(r.userId)))] } }, { email: 1, name: 1 }).lean();
    const who = new Map(users.map(u => [id(u._id), u]));

    res.json({
      rows: page.map(r => {
        const u = who.get(id(r.userId));
        // The key's tail is a date for inactive ('inactive:<ISO>') and weekly
        // ('week:<YYYY-MM-DD>') slots — what the email was about.
        const tail = String(r.key || '').split(':').slice(1).join(':');
        const about = (r.type === 'inactive' || r.type === 'weekly-report') && tail && !Number.isNaN(new Date(tail.replace(/#test$/, '')).getTime())
          ? new Date(tail.replace(/#test$/, '')) : null;
        return {
          id: id(r._id),
          userId: id(r.userId),
          email: u ? u.email : '(deleted)',
          name: (u && u.name) || '',
          type: r.type,
          status: r.status,
          reason: r.reason || null,
          testMode: !!r.testMode || /#test$/.test(String(r.key || '')),
          attempts: r.attempts || 0,
          about,
          sentAt: r.sentAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
      next: rows.length > limit ? page[page.length - 1].createdAt : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Sends one type to the admin, built from the ADMIN'S own data. Ignores the switches. */
router.post('/emails/sample', async (req, res) => {
  try {
    const type = String((req.body && req.body.type) || '');
    if (!isType(type)) return res.status(400).json({ error: 'Unknown email type' });
    if (!systemMail.isConfigured()) return res.status(400).json({ error: 'Set LIFECYCLE_FROM_EMAIL and RESEND_API_KEY first.' });
    // A sample ignores the switches, but not this: without a public URL every
    // link in it, the opt-out included, would be dead.
    if (!unsubscribe.appUrl() || !unsubscribe.isConfigured()) {
      return res.status(400).json({ error: 'Set OUTREACH_URL (the app\'s public URL) and CREDENTIAL_KEY first, or the links in the email will not work.' });
    }
    const me = await User.findById(req.userId, USER_FIELDS).lean();
    const msg = await buildMessage(type, me, { manual: type === 'manual-report' });
    await systemMail.sendSystemEmail({ ...msg, subject: `[Sample] ${msg.subject}`, to: me.email });
    res.json({ ok: true, to: me.email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * "Send today's digest now": the daily admin digest, today so far, to the admin
 * who clicked. Like a sample it ignores the switches (the click is the consent,
 * and it only ever goes to the clicker), but it is recorded in the ledger under
 * `now:<ms>` so the History panel shows it, and capped per day.
 */
router.post('/emails/daily-digest', async (req, res) => {
  try {
    if (!systemMail.isConfigured()) return res.status(400).json({ error: 'Set LIFECYCLE_FROM_EMAIL and RESEND_API_KEY first.' });
    if (!unsubscribe.appUrl() || !unsubscribe.isConfigured()) {
      return res.status(400).json({ error: 'Set OUTREACH_URL (the app\'s public URL) and CREDENTIAL_KEY first, or the links in the email will not work.' });
    }
    const now = new Date();
    const sentToday = await LifecycleEmail.countDocuments({
      userId: req.userId, type: 'admin-daily', key: /^now:/, createdAt: { $gte: istMidnight(now) },
    });
    if (sentToday >= MANUAL_EMAILS_PER_DAY) {
      return res.status(429).json({ error: `You can send the digest by hand up to ${MANUAL_EMAILS_PER_DAY} times a day. It still goes out at 21:00 IST.` });
    }
    const me = await User.findById(req.userId, USER_FIELDS).lean();
    const row = await LifecycleEmail.create({ userId: me._id, type: 'admin-daily', key: `now:${now.getTime()}`, status: 'claimed', to: me.email, attempts: 1 });
    try {
      const msg = await buildMessage('admin-daily', me, { now });
      const { id: providerId } = await systemMail.sendSystemEmail({ ...msg, subject: `[Now] ${msg.subject}`, to: me.email });
      await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'sent', providerId, sentAt: new Date(), reason: msg.quiet ? 'quiet-note' : null } });
    } catch (err) {
      await LifecycleEmail.updateOne({ _id: row._id }, { $set: { status: 'failed', error: String(err.message).slice(0, 300) } });
      throw err;
    }
    logEvent({
      userId: req.userId, category: 'admin', action: 'admin-digest-now', message: 'Sent the daily admin digest by hand',
    }).catch(() => {});
    res.json({ ok: true, to: me.email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Turn one email type on/off for ONE account. Cannot touch that user's own opt-outs. */
router.patch('/users/:id/emails', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Not a valid account id' });
    // Either one type ({ type, blocked }) or every type at once ({ all: true, blocked }).
    const { type, blocked, all } = req.body || {};
    if (typeof blocked !== 'boolean' || (all !== true && !isType(type))) {
      return res.status(400).json({ error: 'Send { type, blocked } or { all: true, blocked }' });
    }
    const target = await User.findById(req.params.id, { email: 1 }).lean();
    if (!target) return res.status(404).json({ error: 'No such account' });
    const update = all === true
      ? { $set: { emailBlockedByAdmin: blocked ? [...TYPE_KEYS] : [] } }
      : blocked ? { $addToSet: { emailBlockedByAdmin: type } } : { $pull: { emailBlockedByAdmin: type } };
    await User.updateOne({ _id: target._id }, update);
    logEvent({
      userId: req.userId, category: 'admin', action: 'lifecycle-user-switch',
      message: `${target.email}: ${all === true ? 'all emails' : TYPES[type].label} -> ${blocked ? 'off' : 'on'}`,
      meta: { targetUserId: id(target._id), type: all === true ? 'all' : type, blocked },
    }).catch(() => {});
    const u = await User.findById(target._id, { emailBlockedByAdmin: 1 }).lean();
    res.json({ ok: true, blockedByAdmin: u.emailBlockedByAdmin || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Issues ────────────────────────────────────────────────────────────────────
// Everything that went wrong for anybody. Written by lib/issues.js.

const ISSUE_SOURCES = ['server', 'validation', 'job', 'client'];
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GET /api/admin/issues?status=open|resolved|all&source=&userId=&q=&limit= */
router.get('/issues', async (req, res) => {
  try {
    const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const filter = {};
    if (status !== 'all') filter.status = status;
    if (ISSUE_SOURCES.includes(req.query.source)) filter.source = req.query.source;
    if (req.query.userId === 'none') filter.userId = null;
    else if (req.query.userId) {
      if (!mongoose.isValidObjectId(req.query.userId)) return res.status(400).json({ error: 'Not a valid account id' });
      filter.userId = new mongoose.Types.ObjectId(String(req.query.userId));
    }
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      filter.$or = [{ message: re }, { area: re }, { kind: re }];
    }

    const [rows, total, openBySource, users] = await Promise.all([
      Issue.find(filter).sort({ lastSeenAt: -1 }).limit(limit).lean(),
      Issue.countDocuments(filter),
      Issue.aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: '$source', issues: { $sum: 1 }, occurrences: { $sum: '$count' } } },
      ]),
      User.find({}, { email: 1 }).lean(),
    ]);
    const emailOf = new Map(users.map(u => [id(u._id), u.email]));

    res.json({
      issues: rows.map(r => ({
        id: id(r._id), userId: id(r.userId), userEmail: r.userId ? (emailOf.get(id(r.userId)) || '(deleted account)') : null,
        source: r.source, area: r.area, kind: r.kind, message: r.message, detail: r.detail, meta: r.meta || {},
        count: r.count, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, status: r.status, resolvedAt: r.resolvedAt,
      })),
      total,
      open: Object.fromEntries(openBySource.map(g => [g._id, { issues: g.issues, occurrences: g.occurrences }])),
      users: users.map(u => ({ id: id(u._id), email: u.email })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/issues/status { ids: [...], status: 'open'|'resolved' }
 * Explicit ids only — never "everything matching a filter", so what changes is
 * exactly what the admin was looking at.
 */
router.post('/issues/status', async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!['open', 'resolved'].includes(status)) return res.status(400).json({ error: 'status must be open or resolved' });
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(v => mongoose.isValidObjectId(v))) {
      return res.status(400).json({ error: 'Send 1-500 issue ids' });
    }
    const r = await Issue.updateMany(
      { _id: { $in: ids } },
      { $set: { status, resolvedAt: status === 'resolved' ? new Date() : null } },
    );
    res.json({ ok: true, updated: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sending ───────────────────────────────────────────────────────────────────
// How the app is coping with email across every account: what is sending right
// now, what ran, what is scheduled, how close each Gmail is to its cap, and
// whether the scheduler is actually firing. Counts, timestamps and the senders'
// own addresses — no recipient, subject or body leaves this endpoint, except
// the raw failure reason on a batch (same choice as the Issues tab).

const LIVE_JOB = ['pending', 'processing', 'paused'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST_MS = 5.5 * HOUR;

// What each scheduled endpoint is ASKED to do (.github/workflows).
const CRONS = [
  { name: '/api/check-mailbox', label: 'Mailbox check', everyMin: 5 },
  { name: '/api/campaigns/run-due', label: 'Campaign releases', everyMin: 60 },
  { name: '/api/postings/sync', label: 'Job postings sync', everyMin: 360 },
];

const countWhere = (cond) => ({ $size: { $filter: { input: '$items', as: 'i', cond } } });
const st = (v) => ({ $eq: ['$$i.status', v] });

/** How long before a live batch with nothing happening counts as stuck. */
function stallAfterMs(job) {
  if (job.sendMode === 'drip') return Math.max(3 * HOUR / Math.max(1, job.ratePerHour || 5), 20 * MIN);
  return 10 * MIN;
}

/** Most common failure text of a batch, with its count. */
function topError(errors) {
  const m = new Map();
  for (const e of errors || []) if (e) m.set(e, (m.get(e) || 0) + 1);
  let best = null;
  for (const [msg, n] of m) if (!best || n > best.n) best = { msg, n };
  return best;
}

/** When a running campaign next releases, IST hour rules as runDueCampaigns. */
function nextRelease(c, now) {
  const today = istDateKey(new Date(now));
  const ist = new Date(now + IST_MS);
  const slotToday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), c.runHourIst || 0, 0, 0) - IST_MS;
  const releasedToday = c.lastReleaseOn === today;
  if (!releasedToday && now >= slotToday) return { at: slotToday, dueNow: true };
  return { at: releasedToday ? slotToday + DAY : slotToday, dueNow: false };
}

/** GET /api/admin/sending?days=7 */
router.get('/sending', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const now = Date.now();
    const since = new Date(now - days * DAY);
    const todayStart = istMidnight(new Date(now));

    const [jobs, campaigns, users, beats] = await Promise.all([
      SendJob.aggregate([   // DELIBERATELY UNSCOPED — see file header
        { $match: { $or: [
          { status: { $in: LIVE_JOB } },
          { createdAt: { $gte: since } },
          { updatedAt: { $gte: todayStart } },
        ] } },
        { $project: {
          userId: 1, campaignId: 1, status: 1, sendMode: 1, ratePerHour: 1, chunkSize: 1,
          senderEmail: 1, createdAt: 1, updatedAt: 1,
          total: { $size: '$items' },
          sent: countWhere(st('sent')),
          failed: countWhere(st('failed')),
          skipped: countWhere(st('skipped')),
          pending: countWhere(st('pending')),
          sentToday: countWhere({ $and: [st('sent'), { $gte: ['$$i.processedAt', todayStart] }] }),
          failedToday: countWhere({ $and: [st('failed'), { $gte: ['$$i.processedAt', todayStart] }] }),
          firstAt: { $min: '$items.processedAt' },
          lastAt: { $max: '$items.processedAt' },
          errors: { $slice: [{ $map: {
            input: { $filter: { input: '$items', as: 'i', cond: st('failed') } }, as: 'i', in: '$$i.error',
          } }, 100] },
        } },
        { $sort: { createdAt: -1 } },
        { $limit: 1000 },
      ]),
      Campaign.find({ deleted: { $ne: true } },
        { userId: 1, name: 1, status: 1, contactsPerDay: 1, ratePerHour: 1, runHourIst: 1,
          lastReleaseOn: 1, lastReleaseAt: 1, lastError: 1, stats: 1 }).lean(),
      User.find({}, { email: 1, status: 1 }).lean(),
      CronBeat.find({}).lean(),
    ]);

    const emailOf = new Map(users.map(u => [id(u._id), u.email]));
    const campName = new Map(campaigns.map(c => [id(c._id), c.name]));
    const who = (uid) => (uid ? emailOf.get(id(uid)) || '(deleted account)' : '(no account)');

    const shape = (j) => {
      const lastAt = j.lastAt ? new Date(j.lastAt).getTime() : null;
      const createdAt = new Date(j.createdAt).getTime();
      const delay = j.sendMode === 'drip' ? HOUR / Math.max(1, j.ratePerHour || 5) : 1500;
      const live = LIVE_JOB.includes(j.status);
      // Drip items are fanned out at creation with fixed spacing, so the
      // last one is due at createdAt + (total-1)*delay.
      const etaAt = live && j.pending > 0 ? Math.max(now, createdAt + (j.total - 1) * delay) : null;
      const idleMs = now - (lastAt || createdAt);
      const stalled = (j.status === 'processing' || j.status === 'pending') && j.pending > 0
        && idleMs > stallAfterMs(j)
        // A drip that has not reached its next slot yet is waiting, not stuck.
        && !(j.sendMode === 'drip' && createdAt + (j.total - j.pending) * delay > now - stallAfterMs(j));
      const top = topError(j.errors);
      return {
        id: id(j._id), userId: id(j.userId), userEmail: who(j.userId), senderEmail: j.senderEmail || '',
        campaignId: j.campaignId || null, campaignName: j.campaignId ? campName.get(String(j.campaignId)) || '(deleted campaign)' : null,
        status: j.status, sendMode: j.sendMode || 'sequential', ratePerHour: j.ratePerHour || null,
        total: j.total, sent: j.sent, failed: j.failed, skipped: j.skipped, pending: j.pending,
        createdAt: j.createdAt, firstAt: j.firstAt || null, lastAt: j.lastAt || null, updatedAt: j.updatedAt,
        etaAt: etaAt ? new Date(etaAt) : null, idleMs, stalled,
        topError: top ? top.msg : null, topErrorCount: top ? top.n : 0,
      };
    };

    const shaped = jobs.map(shape);
    const live = shaped.filter(j => LIVE_JOB.includes(j.status));
    const past = shaped.filter(j => !LIVE_JOB.includes(j.status) && new Date(j.createdAt) >= since);

    // Per-account Gmail load today. inFlight counts promised-but-unsent items,
    // like sendHeadroom(), so three drips cannot each look safe on their own.
    const load = new Map();
    for (const j of jobs) {
      const k = id(j.userId);
      const cur = load.get(k) || { userId: k, userEmail: who(j.userId), sentToday: 0, failedToday: 0, inFlight: 0, errors: [] };
      cur.sentToday += j.sentToday;
      cur.failedToday += j.failedToday;
      if (j.status === 'pending' || j.status === 'processing') cur.inFlight += j.pending;
      if (j.failedToday) cur.errors.push(...(j.errors || []));
      load.set(k, cur);
    }
    const accounts = [...load.values()]
      .filter(a => a.sentToday || a.failedToday || a.inFlight)
      .map(({ errors, ...a }) => {
        const top = topError(errors);
        return { ...a, cap: DAILY_SEND_CAP, usedPct: Math.round(((a.sentToday + a.inFlight) / DAILY_SEND_CAP) * 100),
          failRate: a.sentToday + a.failedToday ? Math.round((a.failedToday / (a.sentToday + a.failedToday)) * 100) : 0,
          topError: top ? top.msg : null };
      })
      .sort((a, b) => (b.sentToday + b.inFlight) - (a.sentToday + a.inFlight));

    // Scheduled campaign batches.
    const upcoming = campaigns
      .filter(c => c.status === 'running' && (c.stats?.pending || 0) > 0)
      .map(c => {
        const nr = nextRelease(c, now);
        const per = Math.max(1, c.contactsPerDay || 20);
        const pending = c.stats.pending;
        return {
          campaignId: id(c._id), name: c.name, userId: id(c.userId), userEmail: who(c.userId),
          nextAt: new Date(nr.at), dueNow: nr.dueNow, overdueMs: nr.dueNow ? now - nr.at : 0,
          batch: Math.min(per, pending), pending, perDay: per, ratePerHour: c.ratePerHour || 5,
          batchHours: Math.round((Math.min(per, pending) / Math.max(1, c.ratePerHour || 5)) * 10) / 10,
          daysLeft: Math.ceil(pending / per), lastReleaseAt: c.lastReleaseAt || null, lastError: c.lastError || null,
        };
      })
      .sort((a, b) => a.nextAt - b.nextAt);

    const crons = CRONS.map(c => {
      const b = beats.find(x => x.name === c.name);
      const recent = (b?.recent || []).map(d => new Date(d).getTime());
      const in24h = recent.filter(t => t >= now - DAY);
      const gaps = in24h.slice(1).map((t, i) => t - in24h[i]);
      return {
        ...c, lastAt: b?.lastAt || null, lastStatus: b?.lastStatus ?? null, lastMs: b?.lastMs ?? null,
        lastOkAt: b?.lastOkAt || null, lastSummary: b?.lastSummary || null,
        runs24h: in24h.length, expected24h: Math.round(1440 / c.everyMin),
        medianGapMin: gaps.length ? Math.round(gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] / MIN) : null,
      };
    });

    // ── Things worth a look, worst first ──
    const alerts = [];
    for (const j of live.filter(x => x.stalled)) {
      alerts.push({ level: 'critical', area: 'batch', text: `A ${j.sendMode} batch for ${j.userEmail} has sent nothing for ${Math.round(j.idleMs / MIN)} min with ${j.pending} still queued.`, ref: j.id, userId: j.userId });
    }
    for (const a of accounts) {
      if (a.failedToday >= 5 && a.failRate >= 50) {
        alerts.push({ level: 'critical', area: 'account', text: `${a.userEmail}: ${a.failRate}% of today's sends failed (${a.failedToday}). Most common: ${a.topError || 'unknown'}`, ref: a.userId, userId: a.userId });
      }
      if (a.usedPct >= 100) alerts.push({ level: 'critical', area: 'account', text: `${a.userEmail} is at ${a.sentToday + a.inFlight} of ${a.cap} for today, counting what is queued — over the Gmail daily cap.`, ref: a.userId, userId: a.userId });
      else if (a.usedPct >= 80) alerts.push({ level: 'warning', area: 'account', text: `${a.userEmail} is at ${a.usedPct}% of the ${a.cap}/day Gmail cap, counting what is queued.`, ref: a.userId, userId: a.userId });
    }
    for (const u of upcoming.filter(x => x.dueNow && x.overdueMs > 2 * HOUR)) {
      alerts.push({ level: 'warning', area: 'campaign', text: `Campaign "${u.name}" (${u.userEmail}) has been due for ${Math.round(u.overdueMs / HOUR)}h and not released — waiting on the scheduler.`, ref: u.campaignId, userId: u.userId });
    }
    for (const c of campaigns.filter(x => x.status === 'failed')) {
      alerts.push({ level: 'critical', area: 'campaign', text: `Campaign "${c.name}" (${who(c.userId)}) is in a failed state: ${c.lastError || 'no error recorded'}`, ref: id(c._id), userId: id(c.userId) });
    }
    for (const j of live.filter(x => x.status === 'paused' && now - new Date(x.updatedAt).getTime() > DAY)) {
      alerts.push({ level: 'info', area: 'batch', text: `A batch for ${j.userEmail} has been paused for ${Math.round((now - new Date(j.updatedAt).getTime()) / DAY)} day(s) with ${j.pending} unsent.`, ref: j.id, userId: j.userId });
    }
    for (const c of crons) {
      if (!c.lastAt) alerts.push({ level: 'warning', area: 'scheduler', text: `${c.label} has not been seen since tracking started.`, ref: c.name });
      else if (c.lastStatus >= 400) alerts.push({ level: 'critical', area: 'scheduler', text: `${c.label}'s last run returned HTTP ${c.lastStatus}.`, ref: c.name });
      else if (now - new Date(c.lastAt).getTime() > Math.max(3 * c.everyMin * MIN, 3 * HOUR)) {
        alerts.push({ level: 'warning', area: 'scheduler', text: `${c.label} last ran ${Math.round((now - new Date(c.lastAt).getTime()) / HOUR)}h ago (asked for every ${c.everyMin} min).`, ref: c.name });
      }
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => rank[a.level] - rank[b.level]);

    const sum = (arr, k) => arr.reduce((n, x) => n + (x[k] || 0), 0);
    res.json({
      now: new Date(now), days, dailyCap: DAILY_SEND_CAP,
      totals: {
        liveBatches: live.filter(j => j.status !== 'paused').length,
        pausedBatches: live.filter(j => j.status === 'paused').length,
        stalled: live.filter(j => j.stalled).length,
        queued: sum(live.filter(j => j.status !== 'paused'), 'pending'),
        sentToday: sum(accounts, 'sentToday'),
        failedToday: sum(accounts, 'failedToday'),
        sendingAccounts: accounts.length,
        pastBatches: past.length,
        pastSent: sum(past, 'sent'), pastFailed: sum(past, 'failed'), pastSkipped: sum(past, 'skipped'),
        scheduledToday: upcoming.filter(u => new Date(u.nextAt).getTime() < todayStart.getTime() + DAY).reduce((n, u) => n + u.batch, 0),
      },
      alerts, live, past: past.slice(0, 300), upcoming, accounts, crons,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/sending/timeline?range=24h|7d|30d&scope=all|campaigns — every account on one chart. */
router.get('/sending/timeline', async (req, res) => {
  try {
    const range = ['24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '7d';
    const scope = req.query.scope === 'campaigns' ? 'campaigns' : 'all';
    res.json(await buildTimeline({ range, scope, fleet: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
