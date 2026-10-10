const SendJob = require('../models/SendJob');
const Campaign = require('../models/Campaign');
const { notify } = require('./notify');
const { DEAD_ADDRESS_ERROR } = require('./deadAddress');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The in-app notification for a send job that has just reached `done`.
 *
 *   all sent                  → send.finished (success)         — S1
 *   a campaign's daily batch  → campaign.finished (success)     — S3
 *   some failed               → send.failed (warning)           — P2
 *   all failed                → send.failed (error)             — P2
 *   addresses skipped as dead → send.skipped_bounced (info)     — P9
 *
 * Keyed by job id, so the several code paths that can finish a job (sequential,
 * bulk, drip, a quota resume) and any Inngest retry raise it once. Best-effort:
 * never throws.
 */
async function notifySendJobFinished(jobId) {
  try {
    const job = await SendJob.findById(jobId, { userId: 1, campaignId: 1, status: 1, 'items.status': 1, 'items.error': 1 }).lean();
    if (!job || job.status !== 'done' || !job.userId) return;

    const items = job.items || [];
    const count = (status) => items.filter(i => i.status === status).length;
    const sent = count('sent');
    const failed = count('failed');
    const skippedDead = items.filter(i => i.status === 'skipped' && i.error === DEAD_ADDRESS_ERROR).length;
    const total = items.length;
    if (total === 0) return;

    const id = String(job._id);
    let link = '/';
    let campaignName = '';
    if (job.campaignId) {
      link = `/campaigns/${job.campaignId}`;
      const c = await Campaign.findOne({ _id: job.campaignId, userId: job.userId }, { name: 1 }).lean();
      campaignName = c?.name || '';
    }

    if (failed > 0) {
      await notify(job.userId, {
        type: 'send.failed',
        severity: sent === 0 ? 'error' : 'warning',
        title: sent === 0 ? `All ${plural(failed, 'email')} failed to send` : `${failed} of ${total} emails failed`,
        body: sent === 0
          ? 'Check your Gmail connection in Settings, then retry from the contacts that failed.'
          : `${sent} sent, ${failed} failed. The failed contacts are marked Failed in Contacts.`,
        link: job.campaignId ? link : '/contacts',
        dedupeKey: `send.failed:${id}`,
      });
    } else if (sent > 0) {
      await notify(job.userId, job.campaignId ? {
        type: 'campaign.finished',
        title: `${campaignName ? `${campaignName}: ` : ''}${plural(sent, 'email')} sent today`,
        body: 'Today\'s batch for this campaign is done.',
        link,
        dedupeKey: `campaign.batch:${id}`,
      } : {
        type: 'send.finished',
        title: `${sent} of ${total} emails sent`,
        body: total - sent > 0 ? `${total - sent} skipped (already contacted, blocked or in an interview).` : '',
        link: '/contacts',
        dedupeKey: `send.finished:${id}`,
      });
    }

    if (skippedDead > 0) {
      await notify(job.userId, {
        type: 'send.skipped_bounced',
        title: `${plural(skippedDead, 'contact')} skipped — address bounced before`,
        body: 'We never email an address that already bounced.',
        link: '/contacts',
        dedupeKey: `send.skipped_bounced:${id}`,
      });
    }
  } catch (err) {
    console.error(`Send-finished notification failed for ${jobId}:`, err.message);
  }
}

/**
 * Gmail's daily limit paused sending (P1). Once per account per IST day: the
 * watcher retries hourly and each refused retry lands here again.
 */
function notifyQuotaPaused(userId) {
  const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return notify(userId, {
    type: 'send.quota_paused',
    title: 'Gmail daily sending limit reached',
    body: 'Sending is paused. We check every hour and continue one batch at a time as soon as Gmail allows — nothing is marked failed.',
    link: '/',
    dedupeKey: `send.quota_paused:${day}`,
  });
}

/** Sending came back after the pause (S7). */
function notifySendResumed(userId, jobId) {
  return notify(userId, {
    type: 'send.resumed',
    title: 'Sending resumed',
    body: 'The Gmail limit pause is over and your batch is sending again.',
    link: '/',
    dedupeKey: `send.resumed:${jobId}:${Date.now() - (Date.now() % 3_600_000)}`,
  });
}

/** Gmail refused the login (P3). Once a day per user — every email in a batch fails the same way. */
function notifyGmailAuthFailed(userId) {
  const day = new Date().toISOString().slice(0, 10);
  return notify(userId, {
    type: 'gmail.auth_failed',
    title: 'Gmail rejected your login',
    body: 'The app password may be wrong or revoked. Reconnect Gmail in Settings so sending can continue.',
    link: '/settings',
    dedupeKey: `gmail.auth_failed:${day}`,
  });
}

const isGmailAuthError = (err) =>
  err && (err.code === 'EAUTH' || err.responseCode === 535 || /\b535\b|Username and Password not accepted|Invalid login/i.test(`${err.response || ''} ${err.message || ''}`));

/** A campaign stopped on an error (P4). */
function notifyCampaignError(userId, campaign, message) {
  return notify(userId, {
    type: 'campaign.error',
    title: `Campaign "${campaign.name}" hit an error`,
    body: message,
    link: `/campaigns/${campaign._id}`,
    dedupeKey: `campaign.error:${campaign._id}:${new Date().toISOString().slice(0, 13)}`,
  });
}

/** The whole campaign is done, not just a day's batch (S3). */
function notifyCampaignDone(userId, campaign) {
  return notify(userId, {
    type: 'campaign.finished',
    title: `Campaign "${campaign.name}" is complete`,
    body: 'Every contact in the list has been processed.',
    link: `/campaigns/${campaign._id}`,
    dedupeKey: `campaign.done:${campaign._id}`,
  });
}

module.exports = {
  notifySendJobFinished, notifyQuotaPaused, notifySendResumed,
  notifyGmailAuthFailed, isGmailAuthError, notifyCampaignError, notifyCampaignDone,
};
