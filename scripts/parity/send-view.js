/**
 * Parity check for GET /api/contacts?view=send. READ-ONLY — it never writes.
 *
 * Send step 3 reads contacts in exactly two ways (pages/send/Step3.tsx):
 *   approved  — c.status === 'queued' && c.approvalStatus === 'approved' (these get emailed)
 *   pending   — c.approvalStatus === 'pending' (only counted)
 * and builds each email from the whole contact object. So the view must be
 * precisely the full list filtered by those two predicates — the same objects,
 * in the same order. This proves it on real data; step 3's code is unchanged.
 *
 *   node scripts/parity/send-view.js
 *   NODE_ENV=prod node scripts/parity/send-view.js
 */
require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const { subsetView, SUBSET_VIEWS } = require('../../routes/contacts');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };
const asBrowser = docs => JSON.parse(JSON.stringify(docs.map(serialize)));

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);

  const userIds = await Contact.distinct('userId', { deleted: { $ne: true } });
  for (const userId of userIds) {
    const base = { deleted: { $ne: true }, userId };
    const [fullDocs, viewDocs] = await Promise.all([
      Contact.find(base, { 'thread.html': 0 }).sort({ createdAt: -1 }).lean(),
      // GET /api/contacts?view=send — the route's own code
      subsetView(SUBSET_VIEWS.send, base),
    ]);
    const full = asBrowser(fullDocs), view = JSON.parse(JSON.stringify(viewDocs));
    const approved = c => c.status === 'queued' && c.approvalStatus === 'approved';
    const pending = c => c.approvalStatus === 'pending';

    const expected = full.filter(c => approved(c) || pending(c));
    assert.deepStrictEqual(view, expected, `user ${userId}: send view differs from the filtered full list`);
    // The two things step 3 derives — what it would send, and what it counts.
    assert.deepStrictEqual(view.filter(approved), full.filter(approved), 'approved (to be emailed) differs');
    assert.strictEqual(view.filter(pending).length, full.filter(pending).length, 'pending count differs');

    const kb = x => (JSON.stringify(x).length / 1024).toFixed(0);
    console.log(`✅  user ${userId}: ${view.filter(approved).length} approved + ${view.filter(pending).length} pending of ${full.length}, identical (${kb(full)} KB → ${kb(view)} KB)`);
  }
  await mongoose.disconnect();
  console.log('Send view check passed.');
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
