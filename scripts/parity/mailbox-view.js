/**
 * Parity check for GET /api/contacts?view=mailbox. READ-ONLY — it never writes.
 *
 * The Mailbox page code is unchanged; only the list it is handed shrank from
 * every contact to the ones it can show. It reads a contact in exactly two
 * ways (pages/Mailbox.tsx):
 *   queue tabs — ids from GET /api/actions looked up in the list
 *   All tab    — queue.byId.has(c.id) || c.thread.some(t => t.direction === 'inbound')
 * So if the view returns precisely the full list filtered by that predicate —
 * the same objects, in the same order — every tab renders identically. This
 * proves that on real data.
 *
 *   node scripts/parity/mailbox-view.js
 *   NODE_ENV=prod node scripts/parity/mailbox-view.js
 */
require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const actionQueue = require('../../lib/actionQueue');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// routes/contacts.js serialize, then JSON — what the browser holds.
const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };
const asBrowser = docs => JSON.parse(JSON.stringify(docs.map(serialize)));

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);

  const userIds = await Contact.distinct('userId', { deleted: { $ne: true } });
  for (const userId of userIds) {
    const base = { deleted: { $ne: true }, userId };
    const [fullDocs, viewDocs, queued] = await Promise.all([
      // GET /api/contacts
      Contact.find(base, { 'thread.html': 0 }).sort({ createdAt: -1 }).lean(),
      // GET /api/contacts?view=mailbox
      Contact.find({ ...base, $or: [{ 'action.state': { $in: actionQueue.STATES } }, { 'thread.direction': 'inbound' }] },
        { 'thread.html': 0 }).sort({ createdAt: -1 }).lean(),
      // GET /api/actions — the queue's ids
      Contact.find({ ...base, 'action.state': { $in: actionQueue.STATES } }, { _id: 1 }).lean(),
    ]);
    const full = asBrowser(fullDocs), view = asBrowser(viewDocs);
    const inQueue = new Set(queued.map(c => String(c._id)));

    const expected = full.filter(c => inQueue.has(c.id) || (c.thread || []).some(t => t.direction === 'inbound'));
    assert.deepStrictEqual(view, expected, `user ${userId}: mailbox view differs from the filtered full list`);
    const byId = new Set(view.map(c => c.id));
    for (const id of inQueue) assert.ok(byId.has(id), `user ${userId}: queued ${id} missing from the view`);

    const bytes = s => (JSON.stringify(s).length / 1024).toFixed(0);
    console.log(`✅  user ${userId}: ${view.length} of ${full.length} contacts, identical (${bytes(full)} KB → ${bytes(view)} KB)`);
  }
  await mongoose.disconnect();
  console.log('Mailbox view check passed.');
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
