require('dotenv').config();
const nodemailer = require('nodemailer');
const { inngest } = require('./inngest');
const SendJob = require('./models/SendJob');
const Contact = require('./models/Contact');
const mailer = require('./lib/mailer');
const db = require('./db');

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
const _atomicItemUpdate = async (jobId, contactId, fields) => {
  await SendJob.findOneAndUpdate(
    { _id: jobId, 'items.contactId': contactId },
    { $set: fields, $inc: { processedCount: 1 } }
  );
  const latest = await SendJob.findById(jobId, 'status items.status').lean();
  if (latest && latest.status === 'processing' && latest.items.every(i => i.status !== 'pending')) {
    await SendJob.findByIdAndUpdate(jobId, {
      status: 'done',
      processedCount: latest.items.length,
    });
  }
};

// Worker: send one email, update Contact and SendJob in DB.
const sendSingleEmail = inngest.createFunction(
  { id: 'send-single-email', retries: 2, triggers: { event: 'email/single.send' } },
  async ({ event, step }) => {
    const { jobId, contactId } = event.data;

    await step.run('send', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId).lean();
      if (!job || job.status === 'cancelled') return;
      if (job.status === 'paused') throw new Error('Job paused — will retry');

      const item = job.items.find(i => i.contactId === contactId && i.status === 'pending');
      if (!item) return; // already handled by a concurrent worker or a retry

      // Cooldown check — skip if this contact was sent an email within the last 2 hours
      const contactDoc = await Contact.findById(contactId).lean();
      if (contactDoc?.lastSentAt && (Date.now() - new Date(contactDoc.lastSentAt).getTime()) < COOLDOWN_MS) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'failed',
          'items.$.error': 'Cooldown — email sent within the last 2 hours. Try again later.',
          'items.$.processedAt': new Date(),
        });
        return;
      }
      const isFollowUp = !!(contactDoc?.lastSentAt && !contactDoc?.followUpSentAt);

      // Credentials stored in job at creation time; fall back to mailer (env vars)
      const senderEmail    = job.senderEmail    || mailer.senderConfig.email;
      const senderName     = job.senderName     || mailer.senderConfig.name;
      const senderPassword = job.senderAppPassword || mailer.senderAppPassword;

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
        const attachments = await mailer.getResumeAttachment(job.attachResume);
        const threadHeaders = (isFollowUp && contactDoc?.messageId)
          ? { inReplyTo: contactDoc.messageId, references: contactDoc.messageId }
          : {};
        const followUpSubject = isFollowUp && contactDoc?.sentSubject && !/^re:/i.test(item.subject)
          ? `Re: ${contactDoc.sentSubject}`
          : item.subject;
        const info = await transporter.sendMail({
          from: `"${senderName}" <${senderEmail}>`,
          to: item.to,
          subject: followUpSubject,
          text: item.body,
          html: bodyToHtml(item.body),
          ...threadHeaders,
          ...(attachments ? { attachments } : {}),
        });
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'sent',
          'items.$.messageId': info.messageId || null,
          'items.$.processedAt': new Date(),
        });
        const newStatus = isFollowUp ? 'follow-up-sent' : 'sent';
        await Contact.findByIdAndUpdate(contactId, {
          $set: {
            status: newStatus,
            messageId: info.messageId || null,
            sentSubject: followUpSubject,
            lastSentAt: new Date(),
            ...(isFollowUp ? { followUpSentAt: new Date() } : {}),
          },
          $push: { statusHistory: { status: newStatus, changedAt: new Date(), note: isFollowUp ? 'Follow-up email sent' : 'Email sent' } },
        });
      } catch (err) {
        await _atomicItemUpdate(jobId, contactId, {
          'items.$.status': 'failed',
          'items.$.error': err.message,
          'items.$.processedAt': new Date(),
        });
        await Contact.findByIdAndUpdate(contactId, {
          $set: { status: 'failed', failReason: err.message },
          $push: { statusHistory: { status: 'failed', changedAt: new Date(), note: err.message } },
        });
      }
    });
  }
);

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between sends to the same contact
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

      const senderEmail    = job.senderEmail    || mailer.senderConfig.email;
      const senderName     = job.senderName     || mailer.senderConfig.name;
      const senderPassword = job.senderAppPassword || mailer.senderAppPassword;

      if (!senderEmail || !senderPassword) {
        throw new Error('No Gmail credentials stored in job. Please re-send via the dashboard → Resume sending.');
      }

      const chunkSize = (job.chunkSize && job.chunkSize > 0) ? job.chunkSize : 20;
      const chunks = [];
      for (let i = 0; i < pendingItems.length; i += chunkSize) {
        chunks.push(pendingItems.slice(i, i + chunkSize));
      }

      const attachments = await mailer.getResumeAttachment(job.attachResume);

      for (let ci = 0; ci < chunks.length; ci++) {
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
            // Cooldown check — skip if sent within the last 2 hours
            const contactDoc = await Contact.findById(item.contactId).lean();
            const isFollowUp = !!(contactDoc?.lastSentAt && !contactDoc?.followUpSentAt);
            if (contactDoc?.lastSentAt && (Date.now() - new Date(contactDoc.lastSentAt).getTime()) < COOLDOWN_MS) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'failed',
                    'items.$.error': 'Cooldown — email sent within the last 2 hours. Try again later.',
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              continue;
            }

            try {
              const threadHeaders = (isFollowUp && contactDoc?.messageId)
                ? { inReplyTo: contactDoc.messageId, references: contactDoc.messageId }
                : {};
              const followUpSubject = isFollowUp && contactDoc?.sentSubject && !/^re:/i.test(item.subject)
                ? `Re: ${contactDoc.sentSubject}`
                : item.subject;
              const info = await transporter.sendMail({
                from: `"${senderName}" <${senderEmail}>`,
                to: item.to,
                subject: followUpSubject,
                text: item.body,
                html: bodyToHtml(item.body),
                ...threadHeaders,
                ...(attachments ? { attachments } : {}),
              });
              await SendJob.findOneAndUpdate(
                { _id: jobId, 'items.contactId': item.contactId },
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
              await Contact.findByIdAndUpdate(item.contactId, {
                $set: {
                  status: newStatus,
                  messageId: info.messageId || null,
                  sentSubject: followUpSubject,
                  lastSentAt: new Date(),
                  ...(isFollowUp ? { followUpSentAt: new Date() } : {}),
                },
                $push: { statusHistory: { status: newStatus, changedAt: new Date(), note: isFollowUp ? 'Follow-up email sent' : 'Email sent' } },
              });
            } catch (err) {
              await SendJob.findOneAndUpdate(
                { _id: jobId, 'items.contactId': item.contactId },
                {
                  $set: {
                    'items.$.status': 'failed',
                    'items.$.error': err.message,
                    'items.$.processedAt': new Date(),
                  },
                  $inc: { processedCount: 1 },
                }
              );
              await Contact.findByIdAndUpdate(item.contactId, {
                $set: { status: 'failed', failReason: err.message },
                $push: { statusHistory: { status: 'failed', changedAt: new Date(), note: err.message } },
              });
            }
          }
        } finally {
          transporter.close();
        }

        // Wait between chunks (skip delay after the last chunk)
        if (ci < chunks.length - 1) {
          await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
        }
      }

      const final = await SendJob.findById(jobId);
      if (final && final.status === 'processing') {
        final.status = 'done';
        await final.save();
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

module.exports = { sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip };
