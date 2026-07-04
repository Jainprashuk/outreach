const mongoose = require('mongoose');
const Template = require('./models/Template');
const Settings = require('./models/Settings');
const Contact = require('./models/Contact');

const DEFAULT_TEMPLATES = [
  {
    key: 'intro-v2',
    name: 'Intro v2',
    subject: 'Quick intro — {{sender}} from {{senderCompany}}',
    body: `Hi {{name}},\n\nI came across {{company}} and was genuinely impressed by what you're building. I'd love to connect for a quick 15-minute call to explore if there's a mutual fit.\n\nWould next week work for you?\n\nBest,\n{{sender}}`
  },
  {
    key: 'follow-up',
    name: 'Follow-up',
    subject: 'Re: {{sentSubject}}',
    body: `Hi {{name}},\n\nJust circling back on my previous note. I understand you're busy, but I believe what we're working on at {{senderCompany}} could genuinely add value to {{company}}.\n\nHappy to keep it brief — even 10 minutes would be great.\n\nBest,\n{{sender}}`
  },
  {
    key: 'cold',
    name: 'Cold outreach',
    subject: 'A thought on {{company}}',
    body: `Hi {{name}},\n\nCold email, I know — but I'll keep it short. We help companies like {{company}} with [value proposition]. Given your role as {{role}}, I thought this might be relevant.\n\nOpen to a quick chat?\n\n{{sender}}`
  }
];

async function backfillStatusHistory() {
  const contacts = await Contact.find({
    $or: [{ statusHistory: { $exists: false } }, { statusHistory: { $size: 0 } }],
  }).lean();

  if (contacts.length === 0) return;

  const ops = contacts.map(c => {
    const history = [];

    // Every contact started queued when created
    history.push({ status: 'queued', changedAt: c.createdAt, note: 'Contact created' });

    // Initial email sent
    if (c.lastSentAt || c.sentSubject || c.messageId) {
      // If follow-up was also sent, lastSentAt was overwritten — original send time is unknown
      const sentAt = c.followUpSentAt
        ? new Date(new Date(c.followUpSentAt).getTime() - 1000) // place just before follow-up
        : (c.lastSentAt || c.updatedAt);
      history.push({ status: 'sent', changedAt: sentAt, note: c.followUpSentAt ? 'Email sent (approx.)' : 'Email sent' });
    }

    // Follow-up sent
    if (c.followUpSentAt) {
      history.push({ status: 'follow-up-sent', changedAt: c.followUpSentAt, note: 'Follow-up email sent' });
    }

    // Bounce
    if (c.status === 'bounced') {
      history.push({ status: 'bounced', changedAt: c.updatedAt, note: c.bounceReason || 'Bounce detected' });
    }

    // Failed
    if (c.status === 'failed') {
      history.push({ status: 'failed', changedAt: c.updatedAt, note: c.failReason || 'Send failed' });
    }

    // Reply
    if (c.repliedAt) {
      history.push({ status: 'replied', changedAt: c.repliedAt, note: 'Reply received' });
    }

    // Manual statuses — use updatedAt as best approximation
    if (['closed', 'no-openings', 'in-review'].includes(c.status)) {
      history.push({ status: c.status, changedAt: c.updatedAt, note: 'Status set' });
    }

    history.sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));

    return {
      updateOne: {
        filter: { _id: c._id, $or: [{ statusHistory: { $exists: false } }, { statusHistory: { $size: 0 } }] },
        update: { $set: { statusHistory: history } },
      },
    };
  });

  const result = await Contact.bulkWrite(ops, { ordered: false });
  console.log(`✅  Backfilled status history for ${result.modifiedCount} contacts`);
}

async function seed() {
  for (const tpl of DEFAULT_TEMPLATES) {
    await Template.updateOne({ key: tpl.key }, { $setOnInsert: tpl }, { upsert: true });
  }
  // Migrate follow-up template subject to threading-compatible format
  await Template.updateOne(
    { key: 'follow-up', subject: { $ne: 'Re: {{sentSubject}}' } },
    { $set: { subject: 'Re: {{sentSubject}}' } }
  );
  await Settings.getSingleton();
}

async function connect() {
  const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
  const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

  if (!uri) {
    console.warn(`⚠️  MONGODB_URI_${env.toUpperCase()} is not set — contacts/templates/settings API will not work.`);
    return;
  }

  // bufferCommands: false — fail fast instead of queuing ops when DB is not connected
  mongoose.set('bufferCommands', false);

  await mongoose.connect(uri, {
    maxPoolSize: 5,              // keep pool small for serverless (each instance has its own)
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log(`✅  Connected to MongoDB (${env} database)`);
  await seed();
  await backfillStatusHistory();
}

module.exports = { connect };
