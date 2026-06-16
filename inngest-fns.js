require('dotenv').config();
const { inngest } = require('./inngest');
const SendJob = require('./models/SendJob');
const Contact = require('./models/Contact');
const mailer = require('./lib/mailer');
const db = require('./db');

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

// Worker: send one email, update Contact and SendJob in DB.
const sendSingleEmail = inngest.createFunction(
  { id: 'send-single-email', retries: 2, triggers: { event: 'email/single.send' } },
  async ({ event, step }) => {
    const { jobId, contactId } = event.data;

    await step.run('send', async () => {
      await ensureDb();
      const job = await SendJob.findById(jobId);
      if (!job || job.status === 'cancelled') return;
      if (job.status === 'paused') throw new Error('Job paused — will retry');

      const item = job.items.find(i => i.contactId === contactId && i.status === 'pending');
      if (!item) return;

      const { transporter, senderConfig, getResumeAttachment } = mailer;
      if (!transporter) {
        item.status = 'failed';
        item.error = 'Transporter not configured';
        item.processedAt = new Date();
        await Contact.findByIdAndUpdate(contactId, { status: 'failed' });
      } else {
        try {
          const attachments = await getResumeAttachment(job.attachResume);
          const info = await transporter.sendMail({
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

      job.processedCount = job.items.filter(i => i.status !== 'pending').length;
      if (job.items.every(i => i.status !== 'pending')) job.status = 'done';
      await job.save();
    });
  }
);

module.exports = { sendEmailBatch, sendSingleEmail };
