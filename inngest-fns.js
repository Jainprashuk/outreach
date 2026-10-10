require('dotenv').config();
const nodemailer = require('nodemailer');
const { inngest } = require('./inngest');
const SendJob = require('./models/SendJob');
const Contact = require('./models/Contact');
const mailer = require('./lib/mailer');
const { COOLDOWN_ERROR, COOLDOWN_LABEL, inCooldown, priorStatus } = require('./lib/cooldown');
const { BLOCKLIST_ERROR, isBlocked, loadBlocklistSets } = require('./lib/blocklist');
const { INTERVIEW_ERROR, isInInterview, loadInterviewSets } = require('./lib/interviewGuard');
const { REPLIED_ERROR, hasUnansweredReply } = require('./lib/actionQueue');
const { notifyCampaignJobFinished } = require('./lib/campaignNotifications');
const { notifySendJobFinished, notifyGmailAuthFailed, isGmailAuthError } = require('./lib/sendNotifications');
const { logEvent } = require('./lib/activityLog');
const { reportIssue } = require('./lib/issues');
const { QUOTA_REASON, isQuotaError, pauseForQuota, resumeNextForAccount, markQuotaRecovered } = require('./lib/sendQuota');
const { DEAD_ADDRESS_ERROR, isDeadAddress, lastRealStatus } = require('./lib/deadAddress');
const db = require('./db');

// A send was skipped (cooldown, blocklist or interview): make sure the contact isn't left
// parked at `queued` by the "Reset for sending" that preceded the job.
async function restoreAfterSkip(contactDoc, note, userId) {
  if (!contactDoc || contactDoc.status !== 'queued') return;
  const status = priorStatus(contactDoc);
  await Contact.findOneAndUpdate({ _id: contactDoc._id, userId }, {
    $set: { status, approvalStatus: 'approved' },
    $push: { statusHistory: { status, changedAt: new Date(), note } },
  });
}

// A send was skipped because the address bounced before: put the contact back on
// that real status, rather than leaving it parked at `queued` or `in-campaign`.
async function restoreDeadAddress(contactDoc, userId) {
  if (!contactDoc || !['queued', 'in-campaign'].includes(contactDoc.status)) return;
  const status = lastRealStatus(contactDoc);
  await Contact.findOneAndUpdate({ _id: contactDoc._id, userId, status: contactDoc.status }, {
    $set: { status },
    $push: { statusHistory: { status, changedAt: new Date(), note: 'Send skipped — this address bounced before; status restored' } },
  });
}

// A send was skipped because the recipient is on the blocklist: mark the contact
// `blocked` rather than quietly restoring its old status, so it's visibly flagged
// and doesn't just re-enter the send queue on the next "Reset for sending".
async function markBlocked(contactDoc, userId) {
  if (!contactDoc) return;
  await Contact.findOneAndUpdate({ _id: contactDoc._id, userId }, {
    $set: { status: 'blocked' },
    $push: { statusHistory: { status: 'blocked', changedAt: new Date(), note: BLOCKLIST_ERROR } },
  });
}

// Converts plain-text template body to HTML.
// Supports [link text](url) markdown-style links → <a> tags.
// Newlines → <br>. Everything else is HTML-escaped.
function bodyToHtml(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let result = '', lastIndex = 0, match;
  while ((match = linkRe.exec(text)) !== null) {
    result += esc(text.slice(lastIndex, match.index));
    result += `<a href="${esc(match[2])}">${esc(match[1])}</a>`;
    lastIndex = linkRe.lastIndex;
  }
  result += esc(text.slice(lastIndex));
  return result.replace(/\n/g, '<br>');
}

const ensureDb = async () => {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    await db.connect();
  }
};

// Orchestrator: load pending items, set job to processing, fan-out individual sends.
const sendEmailBatch = inngest.createFunction(
  { id: 'send-email-batch', triggers: { event: 'email/batch.start' } },
  async ({ event, step }) => {
    const { jobId } = event.data;

    const items = await step.run('load-items', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId);
      if (!job) throw new Error('Job not found: ' + jobId);
      job.status = 'processing';
      await job.save();
      return job.items
        .filter(i => i.status === 'pending')
        .map(item => ({ contactId: item.contactId }));
    });

    if (items.length === 0) {
      await step.run('mark-done-empty', async () => {
        await ensureDb();
        const job = await SendJob.findById(jobId);
        if (job) { job.status = 'done'; await job.save(); }
      });
      return;
    }

    await step.sendEvent('fan-out', items.map((item, i) => ({
      name: 'email/single.send',
      data: { jobId, contactId: item.contactId },
      ts: Date.now() + i * 1500,
    })));
  }
);

// Atomically mark one item on a job and check if all items are now done.
// Using findOneAndUpdate with positional $ avoids the concurrent-save race condition
// where multiple sendSingleEmail workers overwrite each other's item updates.
const _atomicItemUpdate = async (jobId, contactId, fields, userId) => {
  await SendJob.findOneAndUpdate(
    { _id: jobId, userId, 'items.contactId': contactId },
    { $set: fields, $inc: { processedCount: 1 } }
  );
  const latest = await SendJob.findById(jobId, 'status items.status').lean();
  if (latest && latest.status === 'processing' && latest.items.every(i => i.status !== 'pending')) {
    // Exactly one worker wins this transition, so exactly one batch-result
    // notification is emitted even when the final sends finish concurrently.
    const completed = await SendJob.findOneAndUpdate({ _id: jobId, userId, status: 'processing' }, {
      status: 'done',
      processedCount: latest.items.length,
    }, { new: true }).lean();
    if (completed) await notifySendJobFinished(jobId);
    if (completed?.campaignId) await notifyCampaignJobFinished(jobId);
  }
};

// Worker: send one email, update Contact and SendJob in DB.
const sendSingleEmail = inngest.createFunction(
  { id: 'send-single-email', retries: 2, triggers: { event: 'email/single.send' } },
  async ({ event, step }) => {
    const { jobId, contactId } = event.data;

    await step.run('send', async () => {
      await ensureDb();
      // Only this send's item, not every item's body: a 100-email drip otherwise pulled the
      // whole job (100 rendered emails) once per email. $elemMatch returns the first item
      // matching both conditions — exactly what items.find() below used to pick.
      const job = await SendJob.findById(jobId, {
        status: 1, pauseReason: 1, quotaProbe: 1, userId: 1, attachResume: 1, senderEmail: 1, senderName: 1, senderAppPassword: 1,
        items: { $elemMatch: { contactId, status: 'pending' } },
      }).lean();
      if (!job || job.status === 'cancelled') return;
      // A quota pause re-dispatches every pending item when it resumes, so this
      // already-scheduled send can simply stand down instead of burning retries.
      if (job.status === 'paused' && job.pauseReason === QUOTA_REASON) return;
      if (job.status === 'paused') throw new Error('Job paused — will retry');

      const item = (job.items || []).find(i => i.contactId === contactId && i.status === 'pending');
      if (!item) return; // already handled by a concurrent worker or a retry

      // Cooldown check — skip if this contact was emailed inside the cooldown window
      const contactDoc = await Contact.findOne({ _id: contactId, userId: job.userId }).lean();
      if (inCooldown(contactDoc)) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'skipped',
          'items.$.error': COOLDOWN_ERROR,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await restoreAfterSkip(contactDoc, `Send skipped — already emailed within the last ${COOLDOWN_LABEL}; status restored`, job.userId);
        return;
      }

      // Dead-address check — never send again to an address that already bounced.
      if (isDeadAddress(contactDoc)) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'skipped',
          'items.$.error': DEAD_ADDRESS_ERROR,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await restoreDeadAddress(contactDoc, job.userId);
        return;
      }

      // Blocklist check — skip if the recipient's address or domain is blocklisted
      if (isBlocked(item.to, await loadBlocklistSets(job.userId))) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'skipped',
          'items.$.error': BLOCKLIST_ERROR,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await markBlocked(contactDoc, job.userId);
        return;
      }

      // Interview check — once someone is in the interview pipeline, outreach stops.
      // Unlike the blocklist this does NOT flag the contact: the interview record is
      // the source of truth, so the contact just keeps its real status.
      if (isInInterview({ id: contactId, email: item.to }, await loadInterviewSets(job.userId))) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'skipped',
          'items.$.error': INTERVIEW_ERROR,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await restoreAfterSkip(contactDoc, 'Send skipped — contact is in the interview pipeline; status restored', job.userId);
        return;
      }

      // Reply check — a reply that arrived after this job was queued means a live
      // conversation. Sending the template anyway talks past them, and the status write
      // below would erase the `replied` status.
      if (hasUnansweredReply(contactDoc)) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'skipped',
          'items.$.error': REPLIED_ERROR,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await restoreAfterSkip(contactDoc, 'Send skipped — they replied and are waiting on you; status restored', job.userId);
        return;
      }
      const isFollowUp = !!(contactDoc?.lastSentAt && !contactDoc?.followUpSentAt);

      // Credentials stored in job at creation time; fall back to mailer (env vars)
      // The job carries its own credentials so a Vercel worker never depends on
      // process state; the owner's stored settings are the fallback.
      const fallback = (job.senderEmail && job.senderAppPassword)
        ? { email: '', name: '', appPassword: '' }
        : await mailer.getSenderFor(job.userId);
      const senderEmail    = job.senderEmail       || fallback.email;
      const senderName     = job.senderName        || fallback.name;
      const senderPassword = job.senderAppPassword || fallback.appPassword;

      if (!senderEmail || !senderPassword) {
        throw new Error('No Gmail credentials stored in job. Please re-send via the dashboard → Resume sending.');
      }

      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: senderEmail, pass: senderPassword },
      });

      try {
        const attachments = await mailer.getResumeAttachment(job.attachResume, job.userId);
        const threadHeaders = (isFollowUp && contactDoc?.messageId)
          ? { inReplyTo: contactDoc.messageId, references: contactDoc.messageId }
          : {};
        const followUpSubject = isFollowUp && contactDoc?.sentSubject && !/^re:/i.test(item.subject)
          ? `Re: ${contactDoc.sentSubject}`
          : item.subject;
        const bodyHtml = bodyToHtml(item.body); // sent and stored in the thread: render once
        const info = await transporter.sendMail({
          from: `"${senderName}" <${senderEmail}>`,
          to: item.to,
          subject: followUpSubject,
          text: item.body,
          html: bodyHtml,
          ...threadHeaders,
          ...(attachments ? { attachments } : {}),
        });
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'sent',
          'items.$.messageId': info.messageId || null,
          'items.$.processedAt': new Date(),
        }, job.userId);
        const newStatus = isFollowUp ? 'follow-up-sent' : 'sent';
        const sentAt = new Date();
        await Contact.findOneAndUpdate({ _id: contactId, userId: job.userId }, {
          $set: {
            status: newStatus,
            messageId: info.messageId || null,
            sentSubject: followUpSubject,
            lastSentAt: sentAt,
            lastOutboundAt: sentAt,
            ...(isFollowUp ? { followUpSentAt: sentAt } : {}),
          },
          $push: {
            statusHistory: { status: newStatus, changedAt: sentAt, note: isFollowUp ? 'Follow-up email sent' : 'Email sent' },
            thread: {
              direction: 'outbound', subject: followUpSubject, text: item.body, html: bodyHtml,
              messageId: info.messageId || null, inReplyTo: threadHeaders.inReplyTo || null, at: sentAt,
            },
          },
        });
        logEvent({ userId: job.userId, category: 'email', action: 'sent', message: `Email sent to ${item.to}`, meta: { jobId, contactId } })
          .catch(err => console.error('Activity log write failed:', err.message));
        if (job.quotaProbe) await markQuotaRecovered(jobId, job.userId);
      } catch (err) {
        // Gmail's daily limit: the item stays pending and the job waits it out.
        if (isQuotaError(err)) {
          await pauseForQuota({ jobId, userId: job.userId, senderEmail: job.senderEmail, err });
          return;
        }
        if (isGmailAuthError(err)) await notifyGmailAuthFailed(job.userId);
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'failed',
          'items.$.error': err.message,
          'items.$.processedAt': new Date(),
        }, job.userId);
        await Contact.findOneAndUpdate({ _id: contactId, userId: job.userId }, {
          $set: { status: 'failed', failReason: err.message },
          $push: { statusHistory: { status: 'failed', changedAt: new Date(), note: err.message } },
        });
        logEvent({ userId: job.userId, category: 'email', action: 'failed', message: `Email failed for ${item.to}`, meta: { jobId, contactId, error: err.message } })
          .catch(logErr => console.error('Activity log write failed:', logErr.message));
        reportIssue({
          userId: job.userId, source: 'job', area: 'email', kind: 'send_failed',
          message: `Email to ${item.to} failed: ${err.message}`, detail: err.stack,
          key: `send ${err.responseCode || err.code || ''} ${String(err.message).replace(/\S+@\S+/g, '')}`,
          meta: { jobId, contactId, to: item.to, code: err.code || null, responseCode: err.responseCode || null, response: err.response || null },
        });
      }
    });
  }
);

const CHUNK_DELAY_MS = 2000;

// Bulk worker: splits pending items into chunks, one fresh SMTP connection per chunk.
// Avoids "Too many login attempts" (1 AUTH per chunk vs 1 per email in sequential).
// Saves progress to DB after each email so the widget tracks it in real time.
const sendEmailBulk = inngest.createFunction(
  { id: 'send-email-bulk', triggers: { event: 'email/bulk.start' } },
  async ({ event, step }) => {
    const { jobId } = event.data;

    await step.run('send-all', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId);
      if (!job) throw new Error('Job not found: ' + jobId);
      job.status = 'processing';
      await job.save();

      const pendingItems = job.items.filter(i => i.status === 'pending');
      if (pendingItems.length === 0) {
        job.status = 'done';
        await job.save();
        return;
      }

      // The job carries its own credentials so a Vercel worker never depends on
      // process state; the owner's stored settings are the fallback.
      const fallback = (job.senderEmail && job.senderAppPassword)
        ? { email: '', name: '', appPassword: '' }
        : await mailer.getSenderFor(job.userId);
      const senderEmail    = job.senderEmail       || fallback.email;
      const senderName     = job.senderName        || fallback.name;
      const senderPassword = job.senderAppPassword || fallback.appPassword;

      if (!senderEmail || !senderPassword) {
        throw new Error('No Gmail credentials stored in job. Please re-send via the dashboard → Resume sending.');
      }

      const chunkSize = (job.chunkSize && job.chunkSize > 0) ? job.chunkSize : 20;
      const chunks = [];
      for (let i = 0; i < pendingItems.length; i += chunkSize) {
        chunks.push(pendingItems.slice(i, i + chunkSize));
      }

      const attachments = await mailer.getResumeAttachment(job.attachResume, job.userId);
      const blocklistSets = await loadBlocklistSets(job.userId);
      const interviewSets = await loadInterviewSets(job.userId);

      let quotaHit = false;
      let quotaRecovered = false;
      for (let ci = 0; ci < chunks.length && !quotaHit; ci++) {
        const chunk = chunks[ci];

        // Check pause/cancel at chunk boundary
        const current = await SendJob.findById(jobId).lean();
        if (!current || current.status === 'cancelled' || current.status === 'paused') break;

        // Fresh connection per chunk — maxMessages ensures it closes cleanly after the chunk
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          pool: true,
          maxConnections: 1,
          maxMessages: chunk.length,
          auth: { user: senderEmail, pass: senderPassword },
        });

        try {
          for (const item of chunk) {
            // Cooldown check — skip if emailed inside the cooldown window
            const contactDoc = await Contact.findOne({ _id: item.contactId, userId: job.userId }).lean();
            const isFollowUp = !!(contactDoc?.lastSentAt && !contactDoc?.followUpSentAt);
            if (inCooldown(contactDoc)) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'skipped',
                    'items.$.error': COOLDOWN_ERROR,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await restoreAfterSkip(contactDoc, `Send skipped — already emailed within the last ${COOLDOWN_LABEL}; status restored`, job.userId);
              continue;
            }

            // Dead-address check — see the single-send path above.
            if (isDeadAddress(contactDoc)) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'skipped',
                    'items.$.error': DEAD_ADDRESS_ERROR,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await restoreDeadAddress(contactDoc, job.userId);
              continue;
            }

            if (isBlocked(item.to, blocklistSets)) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'skipped',
                    'items.$.error': BLOCKLIST_ERROR,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await markBlocked(contactDoc, job.userId);
              continue;
            }

            // Interview check — see the single-send path above.
            if (isInInterview({ id: item.contactId, email: item.to }, interviewSets)) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'skipped',
                    'items.$.error': INTERVIEW_ERROR,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await restoreAfterSkip(contactDoc, 'Send skipped — contact is in the interview pipeline; status restored', job.userId);
              continue;
            }

            // Reply check — see the single-send path above.
            if (hasUnansweredReply(contactDoc)) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'skipped',
                    'items.$.error': REPLIED_ERROR,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await restoreAfterSkip(contactDoc, 'Send skipped — they replied and are waiting on you; status restored', job.userId);
              continue;
            }

            try {
              const threadHeaders = (isFollowUp && contactDoc?.messageId)
                ? { inReplyTo: contactDoc.messageId, references: contactDoc.messageId }
                : {};
              const followUpSubject = isFollowUp && contactDoc?.sentSubject && !/^re:/i.test(item.subject)
                ? `Re: ${contactDoc.sentSubject}`
                : item.subject;
              const bodyHtml = bodyToHtml(item.body); // sent and stored in the thread: render once
              const info = await transporter.sendMail({
                from: `"${senderName}" <${senderEmail}>`,
                to: item.to,
                subject: followUpSubject,
                text: item.body,
                html: bodyHtml,
                ...threadHeaders,
                ...(attachments ? { attachments } : {}),
              });
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'sent',
                    'items.$.messageId': info.messageId || null,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              const newStatus = isFollowUp ? 'follow-up-sent' : 'sent';
              const sentAt = new Date();
              await Contact.findOneAndUpdate({ _id: item.contactId, userId: job.userId }, {
                $set: {
                  status: newStatus,
                  messageId: info.messageId || null,
                  sentSubject: followUpSubject,
                  lastSentAt: sentAt,
                  lastOutboundAt: sentAt,
                  ...(isFollowUp ? { followUpSentAt: sentAt } : {}),
                },
                $push: {
                  statusHistory: { status: newStatus, changedAt: sentAt, note: isFollowUp ? 'Follow-up email sent' : 'Email sent' },
                  thread: {
                    direction: 'outbound', subject: followUpSubject, text: item.body, html: bodyHtml,
                    messageId: info.messageId || null, inReplyTo: threadHeaders.inReplyTo || null, at: sentAt,
                  },
                },
              });
              if (job.quotaProbe && !quotaRecovered) { quotaRecovered = true; await markQuotaRecovered(jobId, job.userId); }
            } catch (err) {
              // Gmail's daily limit: leave this and every later item pending and stop.
              if (isQuotaError(err)) {
                await pauseForQuota({ jobId, userId: job.userId, senderEmail, err });
                quotaHit = true;
                break;
              }
              if (isGmailAuthError(err)) await notifyGmailAuthFailed(job.userId);
              await SendJob.findOneAndUpdate(
                { _id: jobId, userId: job.userId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'failed',
                    'items.$.error': err.message,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await Contact.findOneAndUpdate({ _id: item.contactId, userId: job.userId }, {
                $set: { status: 'failed', failReason: err.message },
                $push: { statusHistory: { status: 'failed', changedAt: new Date(), note: err.message } },
              });
              reportIssue({
                userId: job.userId, source: 'job', area: 'email', kind: 'send_failed',
                message: `Email to ${item.to} failed: ${err.message}`, detail: err.stack,
                key: `send ${err.responseCode || err.code || ''} ${String(err.message).replace(/\S+@\S+/g, '')}`,
                meta: { jobId, contactId: String(item.contactId), to: item.to, code: err.code || null, responseCode: err.responseCode || null, response: err.response || null, bulk: true },
              });
            }
          }
        } finally {
          transporter.close();
        }

        // Wait between chunks (skip delay after the last chunk)
        if (ci < chunks.length - 1 && !quotaHit) {
          await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
        }
      }

      const final = await SendJob.findById(jobId);
      if (final && final.status === 'processing') {
        final.status = 'done';
        await final.save();
        await notifySendJobFinished(jobId);
      }
    });
  }
);

// Drip orchestrator: fans out email/single.send events spaced by (3600000 / ratePerHour) ms.
// Reuses sendSingleEmail worker — no new worker needed.
const sendEmailDrip = inngest.createFunction(
  { id: 'send-email-drip', triggers: { event: 'email/drip.start' } },
  async ({ event, step }) => {
    const { jobId } = event.data;

    const { pendingItems, ratePerHour } = await step.run('load-items', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId);
      if (!job) throw new Error('Job not found: ' + jobId);
      job.status = 'processing';
      await job.save();
      return {
        pendingItems: job.items.filter(i => i.status === 'pending').map(i => ({ contactId: i.contactId })),
        ratePerHour: job.ratePerHour || 5,
      };
    });

    if (pendingItems.length === 0) {
      await step.run('mark-done-empty', async () => {
        await ensureDb();
        const job = await SendJob.findById(jobId);
        if (job) { job.status = 'done'; await job.save(); }
      });
      return;
    }

    const delayMs = Math.round(3_600_000 / ratePerHour);
    await step.sendEvent('fan-out-drip', pendingItems.map((item, i) => ({
      name: 'email/single.send',
      data: { jobId, contactId: item.contactId },
      ts: Date.now() + i * delayMs,
    })));
  }
);

// Retired: the first quota design booked one of these per paused batch for +24h.
// Kept registered only so bookings already made fall here and do nothing — the
// quota watcher below decides when, and which ONE batch per account, resumes.
const resumeAfterQuota = inngest.createFunction(
  { id: 'resume-after-quota', triggers: { event: 'email/quota.resume' } },
  async () => {}
);

// Hourly: for every Gmail account with batches paused on its daily limit, resume
// the oldest one if nothing on that account is sending. If Gmail still refuses,
// that batch's first email re-pauses it (lib/sendQuota.js) and nothing is lost;
// if Gmail accepts, it sends on and the next batch waits for it to finish.
const quotaWatcher = inngest.createFunction(
  { id: 'quota-watcher', concurrency: { limit: 1 }, triggers: [{ cron: 'TZ=Asia/Kolkata 5 * * * *' }] },
  async ({ step }) => {
    return step.run('resume-next', async () => {
      await ensureDb();
      const accounts = await SendJob.aggregate([
        { $match: { status: 'paused', pauseReason: QUOTA_REASON } },
        { $group: { _id: { userId: '$userId', senderEmail: '$senderEmail' } } },
      ]);
      const resumed = [];
      for (const { _id } of accounts) {
        try {
          const jobId = await resumeNextForAccount({ userId: _id.userId, senderEmail: _id.senderEmail });
          if (jobId) resumed.push(jobId);
        } catch (err) {
          // One account's trouble must not stop the others.
          console.error(`quota-watcher: ${_id.senderEmail || _id.userId}:`, err.message);
        }
      }
      return { accounts: accounts.length, resumed };
    });
  }
);

// Any Inngest function that exhausted its retries — a send batch that could not
// load its job, a lifecycle email Resend refused, a prospect search that threw —
// lands in the admin's Issues tab. One handler for all of them, so a function
// added later is covered without anyone remembering to wire it up.
const reportFailedFunctions = inngest.createFunction(
  { id: 'report-failed-functions', retries: 0, triggers: [{ event: 'inngest/function.failed' }] },
  async ({ event }) => {
    await ensureDb();
    const { function_id: fnId, run_id: runId, error = {}, event: original = {} } = event.data || {};
    const data = original.data || {};
    // A paused drip throws this ON PURPOSE so Inngest holds the send; running
    // out of retries that way is the pause working, not a failure.
    if (/Job paused/i.test(error.message || '')) return;
    let userId = data.userId || null;
    if (!userId && data.jobId) {
      const job = await SendJob.findById(data.jobId, { userId: 1 }).lean().catch(() => null);
      userId = job ? job.userId : null;
    }
    await reportIssue({
      userId, source: 'job', area: 'background', kind: 'function_failed',
      message: `${fnId}: ${error.message || 'failed'}`,
      detail: error.stack || '',
      key: `${fnId} ${error.name || ''} ${String(error.message || '').replace(/\S+@\S+/g, '')}`,
      meta: { functionId: fnId, runId, trigger: original.name || null, eventData: data },
    });
  }
);

module.exports = { sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip, resumeAfterQuota, quotaWatcher, reportFailedFunctions };
