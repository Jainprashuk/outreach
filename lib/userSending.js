/**
 * Admin pause/resume of ONE account's sending — every live batch and every
 * running campaign at once.
 *
 * An admin pause is marked so that resume undoes exactly it and nothing else:
 *   - SendJob: pauseReason 'admin'. The quota watcher only resumes
 *     'gmail_daily_limit', so it never picks these up. A batch the user paused
 *     by hand (pauseReason null) or Gmail paused (quota) is left alone.
 *   - Campaign: pausedByAdmin true. A campaign the user paused stays paused.
 *
 * It is a pause, not a lock: the user can still resume their own work.
 */
const SendJob = require('../models/SendJob');
const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const { dispatchPending } = require('./sendQuota');

const ADMIN_REASON = 'admin';

async function pauseAllForUser(userId) {
  const [jobs, campaigns] = await Promise.all([
    SendJob.updateMany(
      { userId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'paused', pauseReason: ADMIN_REASON, pausedUntil: null, quotaProbe: false } },
    ),
    Campaign.updateMany(
      { userId, status: 'running', deleted: { $ne: true } },
      { $set: { status: 'paused', pausedAt: new Date(), pausedByAdmin: true } },
    ),
  ]);
  return { jobs: jobs.modifiedCount || 0, campaigns: campaigns.modifiedCount || 0 };
}

async function resumeAllForUser(userId) {
  const out = { jobs: 0, jobsDone: 0, jobsNoCredentials: 0, campaigns: 0, campaignsCompleted: 0 };

  const jobs = await SendJob.find({ userId, status: 'paused', pauseReason: ADMIN_REASON },
    { _id: 1, sendMode: 1, items: 1, senderEmail: 1, senderAppPassword: 1 }).lean();
  for (const job of jobs) {
    // Same rule as POST /api/jobs/:id/resume: without stored credentials the job
    // would flip to processing and then fail every send. Leave it for the user.
    if (!job.senderEmail || !job.senderAppPassword) { out.jobsNoCredentials++; continue; }
    const hasPending = job.items.some(i => i.status === 'pending');
    // Conditional on still being admin-paused, so a concurrent user action wins.
    const flipped = await SendJob.updateOne(
      { _id: job._id, status: 'paused', pauseReason: ADMIN_REASON },
      { $set: hasPending ? { status: 'processing', pauseReason: null } : { status: 'done', pauseReason: null } },
    );
    if (!flipped.modifiedCount) continue;
    if (hasPending) { await dispatchPending(job); out.jobs++; } else out.jobsDone++;
  }

  const campaigns = await Campaign.find({ userId, status: 'paused', pausedByAdmin: true }, { _id: 1 }).lean();
  for (const c of campaigns) {
    const remaining = await CampaignRow.countDocuments({ userId, campaignId: c._id, status: 'pending' });
    const $set = remaining === 0
      ? { status: 'completed', completedAt: new Date(), pausedByAdmin: false }
      : { status: 'running', pausedAt: null, pausedByAdmin: false };
    const r = await Campaign.updateOne({ _id: c._id, status: 'paused', pausedByAdmin: true }, { $set });
    if (r.modifiedCount) { if (remaining === 0) out.campaignsCompleted++; else out.campaigns++; }
  }
  return out;
}

/** How much is paused by an admin right now — for the drawer's button state. */
async function adminPausedCounts(userId) {
  const [jobs, campaigns] = await Promise.all([
    SendJob.countDocuments({ userId, status: 'paused', pauseReason: ADMIN_REASON }),
    Campaign.countDocuments({ userId, status: 'paused', pausedByAdmin: true }),
  ]);
  return { jobs, campaigns };
}

module.exports = { ADMIN_REASON, pauseAllForUser, resumeAllForUser, adminPausedCounts };
