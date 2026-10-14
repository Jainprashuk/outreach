/**
 * Parity check for the mailbox scan's contact lookups (lib/mailboxContacts.js)
 * against the full pre-load they replaced. READ-ONLY — it never writes.
 *
 * For every account it builds the old maps exactly as server.js did (every
 * contact, the pre-load's own query), then asks the on-demand index for every
 * key that exists — every address (also upper-cased), every message id, with
 * and without brackets — plus keys that don't, in batches the way a scan would,
 * and requires the same contact (or none) from all three maps.
 *
 *   NODE_ENV=prod node scripts/parity/mailbox-contacts.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const { createContactIndex, cleanMsgId, PROJECTION } = require('../../lib/mailboxContacts');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// server.js, before: the pre-load and the loop that built the maps.
function oldMaps(allContacts) {
  const byEmailAll = new Map(), byEmail = new Map(), byMessageId = new Map();
  for (const c of allContacts) {
    const addr = c.email.toLowerCase();
    byEmailAll.set(addr, c);
    const isThreadable = !!(c.lastSentAt || c.repliedAt) || (c.thread && c.thread.length > 0);
    if (isThreadable) {
      byEmail.set(addr, c);
      if (c.messageId) byMessageId.set(c.messageId.replace(/^<|>$/g, ''), c);
      for (const t of (c.thread || [])) {
        if (t.messageId) byMessageId.set(cleanMsgId(t.messageId), c);
      }
    }
  }
  return { byEmailAll, byEmail, byMessageId };
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);
  let checks = 0;

  for (const userId of await Contact.distinct('userId', { deleted: { $ne: true } })) {
    const t0 = Date.now();
    const plan = await Contact.find({ userId, deleted: { $ne: true } }, PROJECTION).explain('queryPlanner');
    const idx = (JSON.stringify(plan[0]?.queryPlanner?.winningPlan || plan.queryPlanner?.winningPlan).match(/indexName":"([^"]+)/) || [])[1] || 'COLLSCAN';
    const all = await Contact.find({ userId, deleted: { $ne: true } }, PROJECTION).lean();
    const old = oldMaps(all);

    const emails = new Set(['', 'nobody@nowhere.invalid']);
    for (const c of all) { emails.add(c.email.toLowerCase()); }
    const ids = new Set([null, '', 'no-such-id@x']);
    for (const k of old.byMessageId.keys()) { ids.add(k); ids.add(`<${k}`); }
    for (const c of all) if (c.messageId) ids.add(c.messageId);

    const index = createContactIndex(Contact, userId);
    const E = [...emails], I = [...ids];
    for (let i = 0; i < Math.max(E.length, I.length); i += 400) {
      await index.ensure({ emails: E.slice(i, i + 400), messageIds: I.slice(i, i + 400) });
    }
    const same = (label, a, b, k) => {
      checks++;
      const x = a.get(k), y = b.get(k);
      if (String(x?._id) !== String(y?._id)) throw new Error(`user ${userId} ${label}[${JSON.stringify(k)}]: old ${x?._id} vs new ${y?._id}`);
      if (x && JSON.stringify(x) !== JSON.stringify(y)) throw new Error(`user ${userId} ${label}[${JSON.stringify(k)}]: same contact, different fields`);
    };
    for (const k of E) { same('byEmailAll', old.byEmailAll, index.byEmailAll, k); same('byEmail', old.byEmail, index.byEmail, k); }
    for (const k of I) same('byMessageId', old.byMessageId, index.byMessageId, k);
    // Upper-cased addresses are never looked up (the scan lowercases), and must miss on both.
    for (const k of E.slice(0, 200).map(e => e.toUpperCase()).filter(u => !emails.has(u))) same('byEmailAll', old.byEmailAll, index.byEmailAll, k);

    console.log(`✅  user ${userId}: ${all.length} contacts (old plan: ${idx}), ${E.length} addresses + ${I.length} message ids identical (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await mongoose.disconnect();
  console.log(`All ${checks} lookups identical.`);
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
