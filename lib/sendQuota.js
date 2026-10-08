const SendJob = require('../models/SendJob');
const { inngest } = require('../inngest');
const { logEvent } = require('./activityLog');
const { reportIssue } = require('./issues');

/**
 * Gmail's daily sending limit. Once Gmail answers `550 5.4.5 Daily user sending
 * limit exceeded`, every further send from that account is refused for up to 24
 * hours — so failing item by item just burns the rest of the batch (a 100-email
 * drip on 2026-10-08 marked all 100 contacts failed over 100 minutes).
 *
 * Instead the email that hit the limit stays `pending`, every live job on that
 * Gmail account is paused, and each resumes on its own after QUOTA_PAUSE_MS.
 */
const QUOTA_REASON = 'gmail_daily_limit';
// Gmail counts a rolling 24 hours and can hold the block that long after the hit.
const QUOTA_PAUSE_MS = 24 * 3_600_000;

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

/**
 * Pause every live job sending from this Gmail account and schedule its resume.
 * Safe to call concurrently: each job flips from pending/processing to paused
 * in one atomic update, so only the first caller per job schedules a resume.
 * A job the user paused or cancelled by hand is never touched.
 */
async function pauseForQuota({ jobId, userId, senderEmail, err }) {
  const pausedUntil = new Date(Date.now() + QUOTA_PAUSE_MS);
  const live = await SendJob.find({
    userId,
    status: { $in: ['pending', 'processing'] },
    $or: [{ _id: jobId }, ...(senderEmail ? [{ senderEmail }] : [])],
  }, { _id: 1 }).lean();

  const paused = [];
  for (const { _id } of live) {
    const won = await SendJob.findOneAndUpdate(
      { _id, userId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'paused', pauseReason: QUOTA_REASON, pausedUntil } },
      { projection: { _id: 1 } }
    ).lean();
    if (won) paused.push(String(_id));
  }
  if (paused.length === 0) return;

  await inngest.send(paused.map(id => ({
    name: 'email/quota.resume',
    data: { jobId: id, pausedUntil: pausedUntil.toISOString() },
    ts: pausedUntil.getTime(),
  })));

  const when = pausedUntil.toISOString();
  logEvent({ userId, category: 'email', action: 'quota_paused', message: `Gmail daily sending limit reached — ${paused.length} batch(es) paused until ${when}`, meta: { jobIds: paused, pausedUntil: when } })
    .catch(logErr => console.error('Activity log write failed:', logErr.message));
  reportIssue({
    userId, source: 'job', area: 'email', kind: 'send_quota_paused',
    message: `Gmail daily sending limit reached for ${senderEmail || 'this account'} — ${paused.length} batch(es) paused until ${when}: ${err.message}`,
    detail: err.stack,
    key: 'gmail daily limit',
    meta: { jobIds: paused, pausedUntil: when, responseCode: err.responseCode || null, response: err.response || null },
  });
}

module.exports = { QUOTA_REASON, QUOTA_PAUSE_MS, isQuotaError, dispatchPending, pauseForQuota };
