const mongoose = require('mongoose');
const Settings = require('./models/Settings');
const Contact = require('./models/Contact');

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

// Derives lastSentAt/followUpSentAt from statusHistory for legacy contacts that predate
// these fields being written (they're plain missing keys, not null — MongoDB comparison
// operators like $lt never match a missing field, so these contacts silently vanish from
// the followup-due filter no matter how stale they are).
async function backfillSendTimestamps() {
  const contacts = await Contact.find({ lastSentAt: { $exists: false } }).lean();

  if (contacts.length === 0) return;

  const ops = [];
  for (const c of contacts) {
    const history = c.statusHistory || [];
    const lastSent = [...history].reverse().find(h => h.status === 'sent' || h.status === 'follow-up-sent');
    if (!lastSent) continue; // never actually sent — nothing to backfill

    const set = { lastSentAt: lastSent.changedAt };
    if (c.followUpSentAt === undefined) {
      const followUp = [...history].reverse().find(h => h.status === 'follow-up-sent');
      if (followUp) set.followUpSentAt = followUp.changedAt;
    }

    ops.push({
      updateOne: {
        filter: { _id: c._id, lastSentAt: { $exists: false } },
        update: { $set: set },
      },
    });
  }

  if (ops.length === 0) return;

  const result = await Contact.bulkWrite(ops, { ordered: false });
  console.log(`✅  Backfilled send timestamps for ${result.modifiedCount} contacts`);
}

// One-time reclassification: contacts stuck at status 'replied' from before the
// 'follow-up-replied' status existed, whose reply actually came in after a follow-up
// was already sent. Without this they'd stay mislabeled forever (nothing else touches
// old statusHistory/status once written).
async function backfillFollowUpReplied() {
  const contacts = await Contact.find({
    status: 'replied',
    followUpSentAt: { $ne: null },
  }).lean();

  const ops = [];
  for (const c of contacts) {
    if (!c.repliedAt || new Date(c.repliedAt) <= new Date(c.followUpSentAt)) continue;

    ops.push({
      updateOne: {
        filter: { _id: c._id, status: 'replied' },
        update: {
          $set: { status: 'follow-up-replied' },
          $push: { statusHistory: { status: 'follow-up-replied', changedAt: new Date(), note: 'Reclassified: reply was after follow-up (migration)' } },
        },
      },
    });
  }

  if (ops.length === 0) return;

  const result = await Contact.bulkWrite(ops, { ordered: false });
  console.log(`✅  Reclassified ${result.modifiedCount} contacts as follow-up-replied`);
}

// No template seeding — templates are yours to create in the Templates page.
async function seed() {
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
  await backfillSendTimestamps();
  await backfillFollowUpReplied();
}

module.exports = { connect };
