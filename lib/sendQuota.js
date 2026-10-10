const SendJob = require('../models/SendJob');
const { inngest } = require('../inngest');
const { logEvent } = require('./activityLog');
const { reportIssue } = require('./issues');
const { notifyQuotaPaused, notifySendResumed } = require('./sendNotifications');

/**
 * Gmail's daily sending limit. Once Gmail answers `550 5.4.5 Daily user sending
 * limit exceeded`, further sends from that account are refused until enough of
 * the last 24 hours' mail ages out — so failing item by item just burns the rest
 * of the batch (a 100-email drip on 2026-10-08 marked all 100 contacts failed).
 *
 * Instead the email that hit the limit stays `pending` and every live job on that
 * Gmail account is paused. The quota watcher (inngest-fns.js, hourly) then resumes
 * ONE paused batch per account at a time, oldest first. There is no Gmail API that
 * says the limit is clear, so that resume is the check: if Gmail still refuses,
 * its first email re-pauses it here at no cost; if Gmail accepts, it keeps sending.
 *
 * Nothing is booked ahead of time, so nothing can be lost. (The first version
 * booked one delayed event per batch for +24h; a booking made before the resume
 * function was synced stranded a batch for good, and every batch woke at once.)
 */
const QUOTA_REASON = 'gmail_daily_limit';
// Earliest the watcher may retry a batch after Gmail refused it.
const QUOTA_RECHECK_MS = 60 * 60_000;

const isQuotaError = (err) => {
  const text = `${err?.response || ''} ${err?.message || ''}`;
  return /\b5\.4\.5\b/.test(text) || /sending limit exceeded/i.test(text);
};

/** Re-queue a job's pending items in its own send mode. Shared with POST /api/jobs/:id/resume. */
async function dispatchPending(job) {
  const jobId = job._id.toString();
  const pending = job.items.filter(i => i.status === 'pending');
  if (job.sendMode === 'bulk') {
    await inngest.send({ name: 'email/bulk.start', data: { jobId } });
  } else if (job.sendMode === 'drip') {
    await inngest.send({ name: 'email/drip.start', data: { jobId } });
  } else {
    await inngest.send(pending.map((item, i) => ({
      name: 'email/single.send',
      data: { jobId, contactId: item.contactId },
      ts: Date.now() + i * 1500,
    })));
  }
}

const accountFilter = (userId, senderEmail) => ({ userId, senderEmail: senderEmail || '' });

/**
 * Pause every live job sending from this Gmail account. Safe to call
 * concurrently: each job flips from pending/processing to paused in one atomic
 * update. A job the user paused or cancelled by hand is never touched.
 */
async function pauseForQuota({ jobId, userId, senderEmail, err }) {
  const pausedUntil = new Date(Date.now() + QUOTA_RECHECK_MS);
  const live = await SendJob.find({
    userId,
    status: { $in: ['pending', 'processing'] },
    $or: [{ _id: jobId }, ...(senderEmail ? [{ senderEmail }] : [])],
  }, { _id: 1 }).lean();

  const paused = [];
  for (const { _id } of live) {
    const won = await SendJob.findOneAndUpdate(
      { _id, userId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil, quotaProbe: false } },
      { projection: { _id: 1 } }
    ).lean();
    if (won) paused.push(String(_id));
  }
  if (paused.length === 0) return;

  const waiting = await SendJob.countDocuments({ ...accountFilter(userId, senderEmail), status: 'paused', pauseReason: QUOTA_REASON });
  await notifyQuotaPaused(userId);
  logEvent({ userId, category: 'email', action: 'quota_paused', message: `Gmail daily sending limit reached — ${waiting} batch(es) waiting; retried hourly, one at a time`, meta: { jobIds: paused } })
    .catch(logErr => console.error('Activity log write failed:', logErr.message));
  reportIssue({
    userId, source: 'job', area: 'email', kind: 'send_quota_paused',
    message: `Gmail daily sending limit reached for ${senderEmail || 'this account'} — ${waiting} batch(es) waiting, retried hourly: ${err.message}`,
    detail: err.stack,
    key: 'gmail daily limit',
    meta: { jobIds: paused, responseCode: err.responseCode || null, response: err.response || null },
  });
}

// A batch counts as "sending" only while it is actually moving. One whose
// worker died must not hold the whole account's queue for ever.
const isMoving = (job, now) => {
  if (!job.items.some(i => i.status === 'pending')) return false;
  const quiet = Math.max(2 * 3_600_000, 3 * (3_600_000 / Math.max(1, job.ratePerHour || 5)));
  return now - new Date(job.updatedAt).getTime() < quiet;
};

/**
 * One watcher tick for one Gmail account: if nothing on it is sending, resume
 * its oldest limit-paused batch. Returns the resumed job id, or null.
 */
async function resumeNextForAccount({ userId, senderEmail }, now = Date.now()) {
  const live = await SendJob.find(
    { ...accountFilter(userId, senderEmail), status: { $in: ['pending', 'processing'] } },
    { updatedAt: 1, ratePerHour: 1, 'items.status': 1 }
  ).lean();
  if (live.some(j => isMoving(j, now))) return null;

  const job = await SendJob.findOneAndUpdate(
    { ...accountFilter(userId, senderEmail), status: 'paused', pauseReason: QUOTA_REASON, pausedUntil: { $lte: new Date(now) } },
    { $set: { status: 'processing', pauseReason: null, pausedUntil: null, quotaProbe: true } },
    { sort: { createdAt: 1 }, returnDocument: 'after', projection: { userId: 1, sendMode: 1, 'items.contactId': 1, 'items.status': 1 } }
  ).lean();
  if (!job) return null;

  if (!job.items.some(i => i.status === 'pending')) {
    await SendJob.updateOne({ _id: job._id, status: 'processing' }, { $set: { status: 'done', quotaProbe: false } });
    return String(job._id);
  }
  await dispatchPending(job);
  return String(job._id);
}

/**
 * Called after a successful send. If this job was resumed by the watcher, the
 * send just proved Gmail's limit has passed — tell the user, once.
 */
async function markQuotaRecovered(jobId, userId) {
  const won = await SendJob.findOneAndUpdate(
    { _id: jobId, userId, quotaProbe: true },
    { $set: { quotaProbe: false } },
    { projection: { _id: 1 } }
  ).lean();
  if (!won) return;
  await notifySendResumed(userId, String(jobId));
  logEvent({ userId, category: 'email', action: 'quota_resumed', message: 'Gmail is accepting sends again — batch resumed', meta: { jobId: String(jobId) } })
    .catch(err => console.error('Activity log write failed:', err.message));
}

/**
 * A campaign batch released while its account still has limit-paused batches
 * joins the queue instead of firing into a blocked account. Returns true if held.
 */
async function holdBehindQuota(job) {
  const blocked = await SendJob.exists({
    ...accountFilter(job.userId, job.senderEmail), _id: { $ne: job._id }, status: 'paused', pauseReason: QUOTA_REASON,
  });
  if (!blocked) return false;
  await SendJob.updateOne(
    { _id: job._id, status: 'pending' },
    { $set: { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil: new Date() } }
  );
  return true;
}

module.exports = {
  QUOTA_REASON, QUOTA_RECHECK_MS, isQuotaError, dispatchPending,
  pauseForQuota, resumeNextForAccount, markQuotaRecovered, holdBehindQuota,
};
