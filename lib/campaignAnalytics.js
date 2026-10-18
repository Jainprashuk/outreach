// Campaigns as numbers, for Analytics → Outreach: how each recent campaign did
// (released, skipped, replied), why rows were skipped, and Gmail's daily
// limit pausing your batches. Reads what campaigns already store:
//   Campaign.stats       released / skipped / pending, kept by the runner
//   CampaignRow          skipReason on every skipped row
//   CampaignRow          the contact each released row became, found by email for repliers
//   SendJob              batches paused right now, and why
//   ActivityLog          email/quota_paused and quota_resumed (lib/sendQuota.js)

const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const SendJob = require('../models/SendJob');
const Contact = require('../models/Contact');
const ActivityLog = require('../models/ActivityLog');

const DAY = 864e5;
const SKIP_LABELS = {
  blank_email: 'No email address', invalid_email: 'Email address not valid', duplicate_in_file: 'Listed twice in the file',
  duplicate_contact: 'Already a contact', removed_by_user: 'Removed by you', queue_failed: 'Could not be queued',
  render_empty: 'Template came out empty', in_interview: 'Already in your interviews', source_contact_missing: 'Contact was deleted',
  cooldown: 'Emailed too recently', bounced: 'Address bounced before',
};
const ORIGIN_LABELS = { 'action-center': 'Action Center', contacts: 'Selected contacts', upload: 'File upload' };
const pretty = (k) => SKIP_LABELS[k] || String(k || 'unknown').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

async function campaignAnalytics(userIdRaw, { days = 30, now = new Date() } = {}) {
  const userId = new mongoose.Types.ObjectId(String(userIdRaw));
  const since = new Date(now.getTime() - days * DAY);
  const scope = { userId, deleted: { $ne: true } };

  const campaigns = await Campaign.find(
    { ...scope, $or: [{ status: { $in: ['running', 'paused'] } }, { createdAt: { $gte: since } }, { lastReleaseAt: { $gte: since } }, { completedAt: { $gte: since } }] },
    { name: 1, status: 1, stats: 1, createdAt: 1, completedAt: 1, pausedByAdmin: 1, origin: 1, actionKind: 1 },
  ).sort({ createdAt: -1 }).lean();
  const ids = campaigns.map(c => c._id);

  const [skips, quotaLog, pausedNow, repliers] = await Promise.all([
    ids.length ? CampaignRow.aggregate([
      { $match: { campaignId: { $in: ids }, status: 'skipped' } },
      { $group: { _id: { $ifNull: ['$skipReason', 'unknown'] }, n: { $sum: 1 } } },
    ]) : [],
    ActivityLog.find({ userId, category: 'email', action: { $in: ['quota_paused', 'quota_resumed'] }, createdAt: { $gte: since } },
      { action: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
    SendJob.aggregate([
      { $match: { userId, status: 'paused' } },
      { $group: { _id: { $ifNull: ['$pauseReason', 'you'] }, n: { $sum: 1 } } },
    ]),
    ids.length ? Contact.find({ userId, deleted: { $ne: true }, repliedAt: { $ne: null } }, { email: 1 }).lean() : [],
  ]);

  // Replies among each campaign's released rows. The account's repliers are a small
  // set, so their rows are found through the {campaignId, email} index — reading
  // every released row (or every SendJob item) takes seconds on a big account.
  const repliedIds = new Set(repliers.map(r => String(r._id)));
  const replyRows = repliers.length ? await CampaignRow.find(
    { campaignId: { $in: ids }, email: { $in: repliers.map(r => r.email).filter(Boolean) }, status: 'released' },
    { campaignId: 1, contactId: 1 },
  ).lean() : [];
  const repliedBy = new Map();
  for (const r of replyRows) {
    if (!repliedIds.has(String(r.contactId))) continue;
    const k = String(r.campaignId);
    repliedBy.set(k, (repliedBy.get(k) || new Set()).add(String(r.contactId)));
  }

  const rows = campaigns.map(c => {
    const st = c.stats || {};
    const replied = (repliedBy.get(String(c._id)) || new Set()).size;
    return {
      id: String(c._id), name: c.name, status: c.status, pausedByAdmin: c.pausedByAdmin === true,
      origin: c.origin || null, originLabel: ORIGIN_LABELS[c.origin] || null, actionKind: c.actionKind || null,
      total: st.total || 0, released: st.released || 0, skipped: st.skipped || 0, pending: st.pending || 0,
      replied, replyRate: st.released ? Math.round((replied / st.released) * 1000) / 10 : 0,
      createdAt: c.createdAt, completedAt: c.completedAt || null,
    };
  });

  const paused = quotaLog.filter(l => l.action === 'quota_paused');
  const pauseBy = Object.fromEntries(pausedNow.map(p => [p._id, p.n]));
  return {
    days,
    campaigns: rows,
    totals: {
      campaigns: rows.length, running: rows.filter(r => r.status === 'running').length,
      released: rows.reduce((a, r) => a + r.released, 0), skipped: rows.reduce((a, r) => a + r.skipped, 0),
      replied: rows.reduce((a, r) => a + r.replied, 0),
    },
    skipReasons: skips.map(r => ({ key: r._id, label: pretty(r._id), n: r.n })).sort((a, b) => b.n - a.n),
    quota: {
      pauses: paused.length,
      lastPausedAt: paused.length ? paused[0].createdAt : null,
      pausedNow: { gmailLimit: pauseBy.gmail_daily_limit || 0, admin: pauseBy.admin || 0, you: pauseBy.you || 0 },
    },
  };
}

module.exports = { campaignAnalytics, SKIP_LABELS, ORIGIN_LABELS };
