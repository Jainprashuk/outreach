require('dotenv').config();
const nodemailer = require('nodemailer');
const { inngest } = require('./inngest');
const SendJob = require('./models/SendJob');
const Contact = require('./models/Contact');
const mailer = require('./lib/mailer');
const db = require('./db');

const CHUNK_SIZE = 10;
const DELAY_MS   = 1500;

const ensureDb = async () => {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    await db.connect();
  }
};

// Orchestrator: load pending items, set job to processing, fan-out chunk sends.
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

    // Group into chunks of CHUNK_SIZE; offset each chunk by its full duration so
    // emails within each chunk go out together and chunks are spaced ~15s apart.
    const chunks = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      chunks.push(items.slice(i, i + CHUNK_SIZE).map(it => it.contactId));
    }

    await step.sendEvent('fan-out', chunks.map((chunk, i) => ({
      name: 'email/chunk.send',
      data: { jobId, contactIds: chunk },
      ts: Date.now() + i * CHUNK_SIZE * DELAY_MS,
    })));
  }
);

// Worker: send N emails per invocation using a single pooled SMTP connection (1 auth per chunk).
// This reduces Gmail SMTP login attempts from N → ceil(N/CHUNK_SIZE).
const sendEmailChunk = inngest.createFunction(
  { id: 'send-email-chunk', retries: 2, triggers: { event: 'email/chunk.send' } },
  async ({ event, step }) => {
    const { jobId, contactIds } = event.data;

    await step.run('send-chunk', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId);
      if (!job || job.status === 'cancelled') return;
      if (job.status === 'paused') throw new Error('Job paused — will retry');

      const { senderConfig, senderAppPassword, getResumeAttachment } = mailer;

      if (!senderConfig.email || !senderAppPassword) {
        for (const contactId of contactIds) {
          const item = job.items.find(i => i.contactId === contactId && i.status === 'pending');
          if (item) {
            item.status = 'failed';
            item.error = 'Transporter not configured — set GMAIL_EMAIL and GMAIL_APP_PASSWORD in env';
            item.processedAt = new Date();
          }
          await Contact.findByIdAndUpdate(contactId, { status: 'failed' });
        }
        job.processedCount = job.items.filter(i => i.status !== 'pending').length;
        if (job.items.every(i => i.status !== 'pending')) job.status = 'done';
        await job.save();
        return;
      }

      // One pooled transporter for the entire chunk = ONE SMTP login for all emails here
      const pooledTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        pool: true,
        maxConnections: 1,
        maxMessages: Infinity,
        auth: { user: senderConfig.email, pass: senderAppPassword },
      });

      const attachments = await getResumeAttachment(job.attachResume);

      for (const contactId of contactIds) {
        const item = job.items.find(i => i.contactId === contactId && i.status === 'pending');
        if (!item) continue;

        try {
          const info = await pooledTransporter.sendMail({
            from: `"${senderConfig.name}" <${senderConfig.email}>`,
            to: item.to,
            subject: item.subject,
            text: item.body,
            ...(attachments ? { attachments } : {}),
          });
          item.status = 'sent';
          item.messageId = info.messageId || null;
          item.processedAt = new Date();
          await Contact.findByIdAndUpdate(contactId, {
            status: 'sent',
            messageId: info.messageId || null,
            sentSubject: item.subject,
          });
        } catch (err) {
          item.status = 'failed';
          item.error = err.message;
          item.processedAt = new Date();
          await Contact.findByIdAndUpdate(contactId, { status: 'failed' });
        }
      }

      pooledTransporter.close();

      job.processedCount = job.items.filter(i => i.status !== 'pending').length;
      if (job.items.every(i => i.status !== 'pending')) job.status = 'done';
      await job.save();
    });
  }
);

module.exports = { sendEmailBatch, sendEmailChunk };
