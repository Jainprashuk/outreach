/**
 * The contact lookups a mailbox scan matches mail against — loaded on demand.
 *
 * The scan used to pre-load EVERY contact (4.7 MB for a 12k account) to build three
 * maps, which on a throttled Atlas free tier took ~40 s and pushed the scan past the
 * 45 s socket timeout. A scan only ever looks contacts up by the addresses and
 * message ids in the mail it reads, so `ensure()` loads just the contacts holding
 * those keys, right before the (synchronous) lookups that need them.
 *
 * The maps give what the full pre-load gave:
 *  - the same keys: lowercased email; the bracket-free messageId and thread ids,
 *    for "threadable" contacts only (ever sent, replied, or with a thread);
 *  - the same winner when contacts share a key (prod has 536 duplicate emails): the
 *    LAST in the pre-load's order. That order was the query planner's choice; the
 *    {userId, createdAt} index scan is the one it used for the account that has
 *    the duplicates, so lookups hint that index;
 *  - one object per contact, shared by all three maps, so the scan's in-memory marks
 *    (status = 'bounced', a pushed thread id) are seen by every later lookup;
 *  - entries the scan itself sets (byMessageId.set) are never overwritten.
 */

const PROJECTION = {
  email: 1, name: 1, company: 1, status: 1, bounceReason: 1, messageId: 1, updatedAt: 1,
  'thread.messageId': 1, lastSentAt: 1, repliedAt: 1, action: 1, replyCategory: 1,
  lastInboundAt: 1, lastOutboundAt: 1,
};
const ORDER_INDEX = { userId: 1, createdAt: -1 };
const NON_ASCII = '[^\\x00-\\x7F]';

// server.js cleanMsgId
const cleanMsgId = (id) => (id || '').replace(/^<|>$/g, '') || null;

const isThreadable = (c) => !!(c.lastSentAt || c.repliedAt) || !!(c.thread && c.thread.length > 0);

// Every byMessageId key the pre-load gave this contact.
function messageIdKeys(c) {
  const keys = [];
  if (c.messageId) keys.push(c.messageId.replace(/^<|>$/g, ''));
  for (const t of (c.thread || [])) if (t.messageId) keys.push(cleanMsgId(t.messageId));
  return keys;
}

// Stored values that can produce key k: k with or without one leading '<' / trailing '>'.
// (null and '' come from values that were nothing but brackets.)
function storedVariants(k) {
  if (k === null || k === '') return ['<', '>', '<>'];
  return [k, `<${k}`, `${k}>`, `<${k}>`];
}

function createContactIndex(Contact, userId) {
  const byEmailAll = new Map();
  const byEmail = new Map();
  const byMessageId = new Map();
  const doneEmails = new Set();
  const doneIds = new Set();
  const loaded = new Map(); // String(_id) → { obj, threadable } — the first load wins

  async function ensure({ emails = [], messageIds = [] } = {}) {
    const needEmails = [...new Set(emails)].filter(k => !doneEmails.has(k) && !byEmailAll.has(k));
    const needIds = [...new Set(messageIds)].filter(k => !doneIds.has(k) && !byMessageId.has(k));
    needEmails.forEach(k => doneEmails.add(k));
    needIds.forEach(k => doneIds.add(k));
    if (!needEmails.length && !needIds.length) return;

    const or = [];
    if (needEmails.length) {
      or.push({ email: { $in: needEmails } });
      // $toLower only lowercases ASCII, so non-ASCII addresses come back too and
      // are matched by toLowerCase() below.
      or.push({ $expr: { $in: [{ $toLower: '$email' }, needEmails] } });
      or.push({ email: { $regex: NON_ASCII } });
    }
    if (needIds.length) {
      const variants = [...new Set(needIds.flatMap(storedVariants))];
      or.push({ messageId: { $in: variants } }, { 'thread.messageId': { $in: variants } });
    }
    const docs = await Contact.find({ userId, deleted: { $ne: true }, $or: or }, PROJECTION)
      .hint(ORDER_INDEX).lean();

    const emailSet = new Set(needEmails);
    const idSet = new Set(needIds);
    for (const doc of docs) {
      const id = String(doc._id);
      if (!loaded.has(id)) loaded.set(id, { obj: doc, threadable: isThreadable(doc) });
      const { obj, threadable } = loaded.get(id);

      const email = doc.email.toLowerCase();
      if (emailSet.has(email)) {
        byEmailAll.set(email, obj);
        if (threadable) byEmail.set(email, obj);
      }
      if (threadable) for (const k of messageIdKeys(doc)) if (idSet.has(k)) byMessageId.set(k, obj);
    }
  }

  return { byEmailAll, byEmail, byMessageId, ensure };
}

module.exports = { createContactIndex, cleanMsgId, messageIdKeys, isThreadable, PROJECTION };
