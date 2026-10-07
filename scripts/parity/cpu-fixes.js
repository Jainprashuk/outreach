// READ-ONLY parity checks for the Vercel CPU fixes (docs/VERCEL_CPU_CHANGES.md):
//   1. sendSingleEmail's $elemMatch projection picks the same item as the old items.find()
//   2. the new needsBackfillFilter is a subset of the old one, dropping only rows that
//      could never be completed (no lastSentAt, so no outbound entry can be added).
// Usage: NODE_ENV=prod node scripts/parity/cpu-fixes.js   (reads only; never writes)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const SendJob = require('../../models/SendJob');
const Contact = require('../../models/Contact');
(async () => {
  await mongoose.connect(process.env.NODE_ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV);
  // 1. sendSingleEmail item selection
  const jobs = await SendJob.find({}, { _id: 1 }).sort({ createdAt: -1 }).limit(60).lean();
  let checks = 0, mismatches = 0;
  for (const { _id } of jobs) {
    const full = await SendJob.findById(_id).lean();
    const ids = [...new Set(full.items.map(i => i.contactId)), 'no-such-contact'];
    for (const contactId of ids) {
      const oldItem = full.items.find(i => i.contactId === contactId && i.status === 'pending') || null;
      const slim = await SendJob.findById(_id, {
        status: 1, userId: 1, attachResume: 1, senderEmail: 1, senderName: 1, senderAppPassword: 1,
        items: { $elemMatch: { contactId, status: 'pending' } },
      }).lean();
      const newItem = (slim.items || []).find(i => i.contactId === contactId && i.status === 'pending') || null;
      const same = JSON.stringify(oldItem) === JSON.stringify(newItem)
        && ['status', 'userId', 'attachResume', 'senderEmail', 'senderName', 'senderAppPassword']
          .every(k => String(full[k]) === String(slim[k]));
      checks++; if (!same) { mismatches++; if (mismatches < 4) console.log('MISMATCH', String(_id), contactId); }
    }
  }
  console.log(`item selection: ${checks} checks over ${jobs.length} jobs, ${mismatches} mismatches`);
  const withPending = await SendJob.countDocuments({ 'items.status': 'pending' });
  console.log('jobs with a pending item (exercised pending branch):', withPending);

  // 2. needsBackfillFilter old vs new
  const base = { deleted: { $ne: true }, repliedAt: { $ne: null } };
  const noIn = { thread: { $not: { $elemMatch: { direction: 'inbound' } } } };
  const noOut = { thread: { $not: { $elemMatch: { direction: 'outbound' } } } };
  const oldF = { ...base, $or: [noOut, noIn, { replyClassifierOk: { $ne: true } }] };
  const newF = { ...base, $or: [{ lastSentAt: { $ne: null }, ...noOut }, noIn, { replyClassifierOk: { $ne: true } }] };
  const oldIds = new Set((await Contact.find(oldF, { _id: 1 }).lean()).map(c => String(c._id)));
  const newRows = await Contact.find(newF, { _id: 1 }).lean();
  const dropped = await Contact.find({ _id: { $in: [...oldIds].filter(id => !newRows.some(r => String(r._id) === id)) } },
    { lastSentAt: 1, 'thread.direction': 1, replyClassifierOk: 1 }).lean();
  console.log(`backfill filter: old ${oldIds.size}, new ${newRows.length}, new ⊆ old: ${newRows.every(r => oldIds.has(String(r._id)))}`);
  console.log('dropped rows (all should have lastSentAt null, inbound present, classifier ok):',
    dropped.map(d => ({ lastSentAt: d.lastSentAt, dirs: (d.thread || []).map(t => t.direction), ok: d.replyClassifierOk })));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
