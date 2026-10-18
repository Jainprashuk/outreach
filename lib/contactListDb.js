/**
 * GET /api/contacts/list, computed in the database.
 *
 * The in-memory version (lib/contactList.js applyListQuery/getStats) pulls a
 * slim copy of EVERY contact on each call — 4.4 MB for a 12k account, which
 * takes ~36 s while Atlas throttles the free cluster. This returns the same
 * response while only the page's rows, the counts and (for a column sort) one
 * field per contact cross the wire.
 *
 * It must give exactly what lib/contactList.js gives, quirks included, so every
 * rule below is the JS rule restated — and where MongoDB cannot restate it
 * exactly, the JS runs instead:
 *
 *  - Base order is `createdAt desc` as the {userId, createdAt} index returns it,
 *    which breaks the (many — bulk imports) createdAt ties by record id. MongoDB
 *    can't sort on record id, so every query here takes its order from that same
 *    hinted index scan, never from a $sort of its own.
 *  - JS truthiness ('' is falsy, unlike in MongoDB) is spelled out by `falsy`.
 *  - $toLower only lowercases ASCII. Search and the company filter run in the
 *    database only for contacts whose text is plain ASCII; the few others are
 *    fetched and matched by the original JS functions.
 *  - Column sorts other than the default fetch just _id + the sort field, in
 *    base order, and sort with contactList.sortContacts itself.
 *  - Dates stored as anything but a Date would compare differently, so if an
 *    account has one, this returns null and the route uses the old code.
 *
 * scripts/parity/contacts-list-db.js compares both versions on real data.
 */

const mongoose = require('mongoose');
const contactList = require('./contactList');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const BASE_INDEX = { userId: 1, createdAt: -1 };
const ASCII_ONLY = '^[\\x00-\\x7F]*$';

const typeIs = (f, ...types) => ({ $in: [{ $type: f }, types] });
// JS `!value`. NaN is equal to NaN in MongoDB comparisons.
const falsy = (f) => ({ $in: [{ $ifNull: [f, null] }, [null, false, 0, '', NaN]] });
const truthy = (f) => ({ $not: [falsy(f)] });
const eq = (f, v) => ({ $eq: [f, v] });

// A string of ASCII only, or null/missing: where $toLower behaves like toLowerCase.
const asciiSafe = (f) => ({
  $cond: [typeIs(f, 'string'), { $regexMatch: { input: f, regex: ASCII_ONLY } }, typeIs(f, 'missing', 'null')],
});

// String(v) for a safe value, as `c.name + c.email` concatenates it.
const jsString = (f) => ({
  $switch: { branches: [{ case: typeIs(f, 'missing'), then: 'undefined' }, { case: typeIs(f, 'null'), then: 'null' }], default: f },
});

// normCompanyName for a safe value: String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().
// On ASCII, JS \s and trim() are exactly these six characters.
function normCompanyExpr(f) {
  let s = { $cond: [typeIs(f, 'missing', 'null'), '', f] };
  for (const ch of ['\t', '\n', '\v', '\f', '\r']) s = { $replaceAll: { input: s, find: ch, replacement: ' ' } };
  return {
    $toLower: {
      $reduce: {
        input: { $filter: { input: { $split: [s, ' '] }, cond: { $ne: ['$$this', ''] } } },
        initialValue: '',
        in: { $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', ' ', '$$this'] }] },
      },
    },
  };
}

// lib/format isFollowUpDue. Every truthy lastSentAt is a Date (checked by `unsupported`).
const followUpDue = (now) => ({
  $and: [eq('$status', 'sent'), falsy('$followUpSentAt'), truthy('$lastSentAt'),
    { $lte: ['$lastSentAt', new Date(now - THREE_DAYS_MS)] }],
});

// contactList.filterByTab
const TAB_STATUS = {
  sent: 'sent', 'in-campaign': 'in-campaign', remaining: 'queued', bounced: 'bounced', replied: 'replied',
  'follow-up-sent': 'follow-up-sent', 'follow-up-replied': 'follow-up-replied', closed: 'closed',
  'no-openings': 'no-openings', 'in-review': 'in-review',
};
function tabExpr(tab, now) {
  if (tab === 'pending') return eq('$approvalStatus', 'pending');
  if (tab === 'followup-due') return followUpDue(now);
  if (TAB_STATUS[tab]) return eq('$status', TAB_STATUS[tab]);
  return null; // 'all', 'blocked' and anything unknown: every contact
}

// contactList.sourceOf
const { sourceExpr } = require('./statusSets');

// Anything that would make a date compare or sort differently from the JS:
// createdAt that is not a Date after 1970 (the JS sorts a missing one as 1970),
// or a truthy lastSentAt/repliedAt that is not a Date.
const unsupportedExpr = {
  $or: [
    { $not: [{ $and: [typeIs('$createdAt', 'date'), { $gt: ['$createdAt', new Date(0)] }] }] },
    ...['$lastSentAt', '$repliedAt'].map(f => ({ $and: [truthy(f), { $not: [typeIs(f, 'date')] }] })),
  ],
};

const textSafe = { $and: [asciiSafe('$name'), asciiSafe('$email'), asciiSafe('$company')] };

// contactList.getStats, as one $group.
const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const statsGroup = (now) => ({
  _id: null,
  total: { $sum: 1 },
  sent: count(eq('$status', 'sent')),
  bounced: count(eq('$status', 'bounced')),
  replied: count(eq('$status', 'replied')),
  followUpReplied: count(eq('$status', 'follow-up-replied')),
  pending: count(eq('$approvalStatus', 'pending')),
  remaining: count(eq('$status', 'queued')),
  followUpDue: count(followUpDue(now)),
  followUpSent: count(eq('$status', 'follow-up-sent')),
  closed: count(eq('$status', 'closed')),
  noOpenings: count(eq('$status', 'no-openings')),
  inReview: count(eq('$status', 'in-review')),
  resumable: count({ $and: [eq('$status', 'queued'), eq('$approvalStatus', 'approved')] }),
  failed: count(eq('$status', 'failed')),
  unread: count({ $and: [eq('$status', 'replied'), falsy('$replyRead')] }),
});
const STAT_KEYS = Object.keys(statsGroup(0)).filter(k => k !== '_id');

// sortContacts' column → the field it reads. Unknown columns fall to createdAt there too.
const SORT_FIELD = {
  name: 'name', company: 'company', template: 'template', status: 'status',
  approval: 'approvalStatus', lastSentAt: 'lastSentAt', repliedAt: 'repliedAt',
};

/**
 * The list response, or null when this account holds data the database version
 * can't treat exactly like the JS (the caller then runs the in-memory version).
 */
async function listResponse(Contact, userId, query, serialize) {
  const C = Contact.collection;
  const f = contactList.parseListQuery(query);
  const now = Date.now();
  const scope = { deleted: { $ne: true }, userId: new mongoose.Types.ObjectId(String(userId)) };
  const search = f.search.trim().toLowerCase();
  const company = f.company ? contactList.normCompanyName(f.company) : null;

  // One round trip: the support check, plus the non-ASCII contacts the JS must match.
  const facets = { unsupported: [{ $match: { $expr: unsupportedExpr } }, { $limit: 1 }, { $project: { _id: 1 } }] };
  if (search) facets.text = [{ $match: { $expr: { $not: [textSafe] } } }, { $project: { name: 1, email: 1, company: 1 } }];
  if (company !== null) facets.company = [{ $match: { $expr: { $not: [asciiSafe('$company')] } } }, { $project: { company: 1 } }];
  const [pre] = await C.aggregate([{ $match: scope }, { $facet: facets }]).toArray();
  if (pre.unsupported.length) return null;

  const conds = [];
  const tab = tabExpr(f.tab, now);
  if (tab) conds.push(tab);
  if (search) {
    const jsMatched = pre.text.filter(c => (c.name + c.email + c.company).toLowerCase().includes(search)).map(c => c._id);
    const hay = { $toLower: { $concat: [jsString('$name'), jsString('$email'), jsString('$company')] } };
    conds.push({ $or: [{ $cond: [textSafe, { $gte: [{ $indexOfCP: [hay, search] }, 0] }, false] }, { $in: ['$_id', jsMatched] }] });
  }
  if (f.status) conds.push(eq('$status', f.status));
  if (f.approval) conds.push(eq('$approvalStatus', f.approval));
  if (f.template) conds.push(eq('$template', f.template));
  if (f.category) conds.push(eq('$replyCategory', f.category));
  if (f.source) conds.push(eq(sourceExpr, f.source));
  if (company !== null) {
    const jsMatched = pre.company.filter(c => contactList.normCompanyName(c.company) === company).map(c => c._id);
    conds.push({ $or: [{ $cond: [asciiSafe('$company'), eq(normCompanyExpr('$company'), company), false] }, { $in: ['$_id', jsMatched] }] });
  }
  for (const [field, from, to] of [['$createdAt', f.createdFrom, f.createdTo], ['$lastSentAt', f.sentFrom, f.sentTo], ['$repliedAt', f.repliedFrom, f.repliedTo]]) {
    if (from == null && to == null) continue;
    conds.push({ $and: [typeIs(field, 'date'),
      ...(from != null ? [{ $gte: [field, new Date(from)] }] : []),
      ...(to != null ? [{ $lte: [field, new Date(to)] }] : [])] });
  }
  const filter = conds.length ? { ...scope, $expr: { $and: conds } } : scope;
  const inBaseOrder = (projection) => C.find(filter, { projection }).sort({ createdAt: -1 }).hint(BASE_INDEX);

  const statsP = C.aggregate([{ $match: scope }, { $group: statsGroup(now) }]).toArray().then(([g]) =>
    Object.fromEntries(STAT_KEYS.map(k => [k, g ? g[k] : 0])));

  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 25));
  const pageOf = (total) => Math.min(Math.max(1, parseInt(query.page, 10) || 1), Math.ceil(total / limit) || 1);
  const wantIds = query.ids === '1';
  let total, page, contacts, ids;

  // A stable createdAt-desc sort of the base order is the base order itself.
  const sortField = f.sort ? (SORT_FIELD[f.sort] || 'createdAt') : null;
  if (!sortField || (sortField === 'createdAt' && f.dir === 'desc')) {
    total = await C.countDocuments(filter);
    page = pageOf(total);
    const [rows, all] = await Promise.all([
      inBaseOrder({ thread: 0 }).skip((page - 1) * limit).limit(limit).toArray(),
      wantIds ? inBaseOrder({ _id: 1 }).toArray() : null,
    ]);
    contacts = rows.map(serialize);
    if (all) ids = all.map(c => String(c._id));
  } else {
    const sorted = contactList.sortContacts(await inBaseOrder({ [sortField]: 1 }).toArray(), f.sort, f.dir);
    total = sorted.length;
    page = pageOf(total);
    const pageIds = sorted.slice((page - 1) * limit, page * limit).map(c => c._id);
    const docs = pageIds.length ? await C.find({ _id: { $in: pageIds }, userId: scope.userId }, { projection: { thread: 0 } }).toArray() : [];
    const byId = new Map(docs.map(d => [String(d._id), d]));
    contacts = pageIds.map(id => byId.get(String(id))).filter(Boolean).map(serialize);
    if (wantIds) ids = sorted.map(c => String(c._id));
  }

  return {
    contacts, total, page, pages: Math.ceil(total / limit) || 1, limit,
    stats: await statsP,
    ...(wantIds ? { ids } : {}),
  };
}

/**
 * The original in-memory version, unchanged: the fallback, and the reference the
 * parity script compares against. `slim` lets that script load the list once.
 */
async function memoryListResponse(Contact, userId, query, serialize, slim) {
  const f = contactList.parseListQuery(query);
  if (!slim) {
    slim = await Contact.find({ deleted: { $ne: true }, userId }, contactList.FILTER_FIELDS)
      .sort({ createdAt: -1 }).lean();
  }
  const filtered = contactList.applyListQuery(slim, f);

  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 25));
  const pages = Math.ceil(filtered.length / limit) || 1;
  const page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), pages);
  const pageIds = filtered.slice((page - 1) * limit, page * limit).map(c => c._id);

  // The rows themselves, whole except the thread — which neither table reads.
  const docs = pageIds.length
    ? await Contact.find({ _id: { $in: pageIds }, userId }, { thread: 0 }).lean()
    : [];
  const byId = new Map(docs.map(d => [String(d._id), d]));
  const contacts = pageIds.map(id => byId.get(String(id))).filter(Boolean).map(serialize);

  return {
    contacts, total: filtered.length, page, pages, limit,
    stats: contactList.getStats(slim),
    ...(query.ids === '1' ? { ids: filtered.map(c => String(c._id)) } : {}),
  };
}

module.exports = { listResponse, memoryListResponse };
