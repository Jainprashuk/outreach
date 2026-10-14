/**
 * The Outreach analytics page's numbers, computed in the database.
 *
 * The page used to download every contact with its full status history
 * (GET /api/contacts?view=analytics — 8.7 MB for a 12k account, which on the
 * throttled Atlas free tier ran past the 45 s socket timeout) and derive
 * everything in the browser. This derives the same things where the data lives
 * and returns only the results.
 *
 * Every rule is client/src/lib/analytics.ts `analyze` and the derivations in
 * pages/Analytics.tsx, restated — scripts/parity/analytics-summary.js runs that
 * browser code on the full download and requires identical results. Notes:
 *  - Order matters where the page relied on it: object-key order (first
 *    appearance, integer-like keys first) breaks ties in sorted tables, and the
 *    event log breaks timestamp ties by contact order. Contact order is the
 *    {userId, createdAt} index scan's, ties broken by record id — so the
 *    pipeline streams that scan into one array of ids and numbers them (`pos`).
 *  - Day buckets, weekdays and hours use the browser's timezone (`tz`).
 *  - `now` is the request time; the page refreshes the activity part every minute.
 */

const mongoose = require('mongoose');

const HOUR = 3600000;
const DAY = 86400000;
const EMAILED = ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'closed', 'no-openings', 'in-review'];
// lib/analytics.ts STATUS_META, in its key order.
const STATUS_KEYS = ['queued', 'sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'failed', 'closed', 'no-openings', 'in-review', 'blocked'];
// ACTIVITY_META types a contact can produce (the interview ones come from the browser).
const CONTACT_ACTIVITY_TYPES = ['added', 'sent', 'delivered', 'follow-up-sent', 'replied', 'follow-up-replied',
  'bounced', 'failed', 'in-review', 'closed', 'no-openings', 'queued', 'blocked'];
const ACTIVITY_WINDOWS = [
  { key: '1h', ms: HOUR }, { key: '6h', ms: 6 * HOUR }, { key: '24h', ms: 24 * HOUR },
  { key: '7d', ms: 7 * DAY }, { key: '30d', ms: 30 * DAY },
];
const FEED_SIZE = 40;
// String.prototype.trim's whitespace, exactly (MongoDB's default set differs).
const JS_TRIM = '\t\n\v\f\r                  　﻿';
const NON_ASCII = '[^\\x00-\\x7F]';
const ORDER_INDEX = { userId: 1, createdAt: -1 };

// lib/analytics.ts pct
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// ── Expression helpers ───────────────────────────────────────────────────────
const typeIs = (f, ...types) => ({ $in: [{ $type: f }, types] });
const falsy = (f) => ({ $in: [{ $ifNull: [f, null] }, [null, false, 0, '', NaN]] });
const truthy = (f) => ({ $not: [falsy(f)] });
const has = (set, v) => ({ $in: [v, set] });
// new Date(v).getTime() for a Date or null (0); anything else would be NaN → null here.
const msOf = (f) => ({ $switch: { branches: [
  { case: typeIs(f, 'date'), then: { $toLong: f } },
  { case: typeIs(f, 'null'), then: 0 },
], default: null } });

/**
 * Every contact in the page's order, numbered, with the fields analytics reads and
 * `analyze()`'s results. One document per contact.
 */
function analyzedContacts(scope) {
  return [
    { $match: scope },
    { $sort: { createdAt: -1 } },
    { $group: { _id: null, ids: { $push: '$_id' } } },
    { $unwind: { path: '$ids', includeArrayIndex: 'pos' } },
    { $lookup: { from: 'contacts', localField: 'ids', foreignField: '_id', as: 'c', pipeline: [{ $project: {
      name: 1, email: 1, company: 1, status: 1, template: 1, statusHistory: { status: 1, changedAt: 1 },
      lastSentAt: 1, repliedAt: 1, followUpSentAt: 1, createdAt: 1, updatedAt: 1,
    } }] } },
    { $unwind: '$c' },
    { $replaceWith: { $mergeObjects: ['$c', { pos: '$pos' }] } },
    // hist: the history with a usable time, in stored order.
    { $addFields: { hist: { $filter: {
      input: { $map: {
        input: { $cond: [{ $isArray: '$statusHistory' }, '$statusHistory', []] },
        as: 'h', in: { s: '$$h.status', t: msOf('$$h.changedAt') },
      } },
      cond: { $ne: ['$$this.t', null] },
    } } } },
    { $addFields: {
      ever: { $setUnion: [{ $map: { input: '$hist', in: '$$this.s' } }, ['$status']] },
      sends: { $let: {
        vars: { h: { $filter: { input: '$hist', cond: has(['sent', 'follow-up-sent'], '$$this.s') } } },
        in: { $cond: [{ $and: [{ $eq: [{ $size: '$$h' }, 0] }, truthy('$lastSentAt')] },
          [{ s: 'sent', t: { $toLong: '$lastSentAt' } }], '$$h'] },
      } },
      replies: { $let: {
        vars: { h: { $filter: { input: '$hist', cond: has(['replied', 'follow-up-replied'], '$$this.s') } } },
        in: { $cond: [{ $and: [{ $eq: [{ $size: '$$h' }, 0] }, truthy('$repliedAt')] },
          [{ s: 'replied', t: { $toLong: '$repliedAt' } }], '$$h'] },
      } },
    } },
    { $addFields: {
      firstFuT: { $let: {
        vars: { fu: { $filter: { input: '$sends', cond: { $eq: ['$$this.s', 'follow-up-sent'] } } } },
        in: { $cond: [{ $gt: [{ $size: '$$fu' }, 0] }, { $min: '$$fu.t' },
          { $cond: [truthy('$followUpSentAt'), { $toLong: '$followUpSentAt' }, null] }] },
      } },
      firstReplyT: { $cond: [{ $gt: [{ $size: '$replies' }, 0] }, { $min: '$replies.t' }, null] },
      // Each reply against the latest send at or before it; 0 ≤ hours < 90 days.
      pairs: { $filter: {
        input: { $map: { input: '$replies', as: 'r', in: { $let: {
          vars: { st: { $max: { $map: {
            input: { $filter: { input: '$sends', as: 's', cond: { $lte: ['$$s.t', '$$r.t'] } } },
            in: '$$this.t',
          } } } },
          in: { $cond: [{ $eq: ['$$st', null] }, null, { $divide: [{ $subtract: ['$$r.t', '$$st'] }, HOUR] }] },
        } } } },
        cond: { $and: [{ $ne: ['$$this', null] }, { $gte: ['$$this', 0] }, { $lt: ['$$this', 24 * 90] }] },
      } },
    } },
    { $addFields: {
      everSent: { $or: [{ $gt: [{ $size: '$sends' }, 0] }, has(EMAILED, '$status'), has('$ever', 'sent')] },
      everReplied: { $gt: [{ $size: '$replies' }, 0] },
      everFollowUp: { $or: [{ $ne: ['$firstFuT', null] }, has('$ever', 'follow-up-sent'), has('$ever', 'follow-up-replied')] },
      everBounced: has('$ever', 'bounced'),
      repliedAfterFu: { $or: [has('$ever', 'follow-up-replied'), { $and: [
        { $ne: ['$firstFuT', null] }, { $ne: ['$firstReplyT', null] }, { $gt: ['$firstReplyT', '$firstFuT'] },
      ] }] },
    } },
  ];
}

// buildActivityEvents for one contact: [{ t, type, idx, countOnly }], in its insertion order.
const contactEvents = {
  $concatArrays: [
    { $cond: [typeIs('$createdAt', 'date'), [{ t: { $toLong: '$createdAt' }, type: 'added', idx: 0, countOnly: false }], []] },
    { $cond: [{ $gt: [{ $size: '$hist' }, 0] },
      { $map: { input: { $range: [0, { $size: '$hist' }] }, as: 'i', in: {
        t: { $arrayElemAt: ['$hist.t', '$$i'] }, type: { $arrayElemAt: ['$hist.s', '$$i'] },
        idx: { $add: ['$$i', 1] }, countOnly: false,
      } } },
      // No history (older contacts): the timestamp the status implies.
      { $cond: [{ $ne: ['$status', 'queued'] }, { $let: {
        vars: { t: msOf({ $let: {
          vars: { fb: { $switch: { branches: [
            { case: has(['replied', 'follow-up-replied'], '$status'), then: '$repliedAt' },
            { case: { $eq: ['$status', 'follow-up-sent'] }, then: '$followUpSentAt' },
          ], default: { $cond: [truthy('$lastSentAt'), '$lastSentAt', '$updatedAt'] } } } },
          in: { $cond: [truthy('$$fb'), '$$fb', '$updatedAt'] },
        } }) },
        in: { $cond: [{ $ne: ['$$t', null] }, [{ t: '$$t', type: '$status', idx: 1, countOnly: false }], []] },
      } }, []] }] },
    // Every send of a never-bounced contact also counts as delivered.
    { $cond: ['$everBounced', [], { $map: { input: '$sends', in: { t: '$$this.t', type: 'delivered', idx: -1, countOnly: true } } }] },
  ],
};

// Object.entries order: integer-like keys ascending, then the rest by first appearance.
function objectKeyOrder(rows, keyOf, firstOf) {
  const isIndex = (k) => /^(0|[1-9]\d*)$/.test(k) && Number(k) < 4294967295;
  return [...rows].sort((a, b) => {
    const ka = String(keyOf(a)), kb = String(keyOf(b));
    const ia = isIndex(ka), ib = isIndex(kb);
    if (ia && ib) return Number(ka) - Number(kb);
    if (ia !== ib) return ia ? -1 : 1;
    return firstOf(a) - firstOf(b);
  });
}

// The day a time falls on in `tz`, as the page's dayKey() gives it (local midnight, ms).
const dayKeyExpr = (t, tz) => ({ $toLong: { $dateTrunc: { date: { $toDate: t }, unit: 'day', timezone: tz } } });

async function activity(C, scope, now) {
  const events = [
    ...analyzedContacts(scope),
    { $project: { pos: 1, name: 1, company: 1, ev: contactEvents } },
    { $unwind: '$ev' },
    { $match: { 'ev.type': { $in: CONTACT_ACTIVITY_TYPES }, 'ev.t': { $gte: now - ACTIVITY_WINDOWS.at(-1).ms, $lte: now } } },
  ];
  const facets = {};
  for (const w of ACTIVITY_WINDOWS) {
    const inWin = { 'ev.t': { $gte: now - w.ms } };
    facets[`n${w.key}`] = [{ $match: inWin }, { $group: { _id: '$ev.type', n: { $sum: 1 } } }];
    facets[`f${w.key}`] = [{ $match: { ...inWin, 'ev.countOnly': false } },
      { $sort: { 'ev.t': -1, pos: 1, 'ev.idx': 1 } }, { $limit: FEED_SIZE },
      { $project: { _id: 0, id: { $toString: '$_id' }, name: 1, company: 1, t: '$ev.t', type: '$ev.type' } }];
  }
  const [r] = await C.aggregate([...events, { $facet: facets }], { hint: ORDER_INDEX }).toArray();
  const counts = {}, feeds = {};
  for (const w of ACTIVITY_WINDOWS) {
    counts[w.key] = Object.fromEntries(CONTACT_ACTIVITY_TYPES.map(t => [t, 0]));
    for (const g of r[`n${w.key}`]) counts[w.key][g._id] = g.n;
    feeds[w.key] = r[`f${w.key}`].map(e => ({ ...e, t: Number(e.t) }));
  }
  return { now, counts, feeds };
}

// The contacts the Interviews store points at, by id or address — the only rows
// interviewFunnel() counts. In the page's order.
async function interviewRows(Contact, Interview, userId) {
  const ivs = await Interview.find({ userId }, { sourceType: 1, sourceId: 1, email: 1 }).lean();
  const normEmail = (e) => (e || '').trim().toLowerCase();
  const ids = ivs.filter(iv => iv.sourceType === 'contact' && iv.sourceId && mongoose.isValidObjectId(String(iv.sourceId)))
    .map(iv => new mongoose.Types.ObjectId(String(iv.sourceId)));
  const emails = [...new Set(ivs.map(iv => normEmail(iv.email)).filter(Boolean))];
  if (!ids.length && !emails.length) return [];
  const norm = { $toLower: { $trim: { input: { $ifNull: ['$email', ''] }, chars: JS_TRIM } } };
  const docs = await Contact.find({ userId, deleted: { $ne: true }, $or: [
    { _id: { $in: ids } },
    { $expr: { $in: [norm, emails] } },
    { email: { $regex: NON_ASCII } }, // matched by the JS below
  ] }, { email: 1 }).sort({ createdAt: -1 }).hint(ORDER_INDEX).lean();
  const idSet = new Set(ids.map(String)), emailSet = new Set(emails);
  return docs.filter(d => idSet.has(String(d._id)) || emailSet.has(normEmail(d.email)))
    .map(d => ({ id: String(d._id), email: d.email }));
}

async function summary(Contact, Interview, userId, { tz = 'UTC', now = Date.now() } = {}) {
  const C = Contact.collection;
  const uid = new mongoose.Types.ObjectId(String(userId));
  const scope = { userId: uid, deleted: { $ne: true } };

  // Anything stored in a shape the browser code would read differently.
  const [bad] = await C.aggregate([{ $match: scope }, { $match: { $expr: { $or: [
    { $not: [typeIs('$createdAt', 'date')] },
    ...['$lastSentAt', '$repliedAt', '$followUpSentAt', '$updatedAt'].map(f => ({ $and: [truthy(f), { $not: [typeIs(f, 'date')] }] })),
    { $anyElementTrue: [{ $map: { input: { $ifNull: ['$statusHistory', []] },
      in: { $or: [{ $not: [typeIs('$$this.changedAt', 'date', 'null', 'missing')] }, { $not: [typeIs('$$this.status', 'string')] }] } } }] },
    { $not: [typeIs('$status', 'string')] },
    { $and: [truthy('$template'), { $not: [typeIs('$template', 'string')] }] },
    { $and: [truthy('$company'), { $not: [typeIs('$company', 'string')] }] },
  ] } } }, { $limit: 1 }]).toArray();
  if (bad) throw new Error(`analytics: contact ${bad._id} holds data in a shape this summary does not handle`);

  const t = (x) => Number(x);
  const wk = 7 * DAY;
  const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const co = { $trim: { input: { $ifNull: ['$company', ''] }, chars: JS_TRIM } };

  const [[{ k: today }], [f], ivRows, act] = await Promise.all([
    Contact.db.db.aggregate([{ $documents: [{}] }, { $project: { k: dayKeyExpr(now, tz) } }]).toArray(),
    C.aggregate([
    ...analyzedContacts(scope),
    { $facet: {
      m: [{ $group: {
        _id: null, total: { $sum: 1 },
        sentCount: sum('$everSent'), repliedCount: sum('$everReplied'), fuCount: sum('$everFollowUp'),
        bouncedCount: sum('$everBounced'), afterFuCount: sum('$repliedAfterFu'),
        inReviewEver: sum(has('$ever', 'in-review')), closedEver: sum(has('$ever', 'closed')),
        queuedNow: sum({ $eq: ['$status', 'queued'] }),
        adv: sum({ $and: ['$everReplied', { $or: [has('$ever', 'in-review'), has('$ever', 'closed')] }] }),
        due: sum({ $and: [has(['sent', 'replied'], '$status'), falsy('$followUpSentAt'), truthy('$lastSentAt'),
          { $gt: [{ $subtract: [now, { $toLong: '$lastSentAt' }] }, 3 * DAY] }] }),
        ...Object.fromEntries(STATUS_KEYS.map((s, i) => [`ever${i}`, sum(has('$ever', s))])),
      } }],
      statuses: [{ $group: { _id: '$status', n: { $sum: 1 }, first: { $min: '$pos' } } }],
      journey: [{ $match: { everReplied: true } }, { $group: { _id: '$status', n: { $sum: 1 }, first: { $min: '$pos' } } }],
      templates: [{ $match: { everSent: true } }, { $group: {
        _id: { $cond: [truthy('$template'), '$template', '—'] },
        sent: { $sum: 1 }, replied: sum('$everReplied'), first: { $min: '$pos' },
      } }],
      companies: [{ $addFields: { co } }, { $match: { co: { $ne: '' } } }, { $group: {
        _id: '$co', total: { $sum: 1 }, replied: sum('$everReplied'), first: { $min: '$pos' },
      } }, { $addFields: {
        isIndex: { $cond: [{ $regexMatch: { input: '$_id', regex: '^(0|[1-9][0-9]{0,9})$' } },
          { $lt: [{ $toDecimal: '$_id' }, 4294967295] }, false] },
      } }, { $addFields: { idxVal: { $cond: ['$isIndex', { $toDecimal: '$_id' }, null] } } },
      // sort by total desc — stable over Object.entries order — and keep 8.
      { $sort: { total: -1, isIndex: -1, idxVal: 1, first: 1 } }, { $limit: 8 }],
      pairs: [{ $unwind: '$pairs' }, { $group: { _id: null, all: { $push: '$pairs' } } }],
      sendTimes: [{ $unwind: '$sends' }, { $group: {
        _id: { day: dayKeyExpr('$sends.t', tz), wd: { $dayOfWeek: { date: { $toDate: '$sends.t' }, timezone: tz } } },
        n: { $sum: 1 },
        w1: sum({ $and: [{ $gte: ['$sends.t', now - wk] }, { $lt: ['$sends.t', now] }] }),
        w2: sum({ $and: [{ $gte: ['$sends.t', now - 2 * wk] }, { $lt: ['$sends.t', now - wk] }] }),
      } }],
      replyTimes: [{ $unwind: '$replies' }, { $group: {
        _id: {
          day: dayKeyExpr('$replies.t', tz),
          wd: { $dayOfWeek: { date: { $toDate: '$replies.t' }, timezone: tz } },
          hr: { $hour: { date: { $toDate: '$replies.t' }, timezone: tz } },
        },
        n: { $sum: 1 },
        w1: sum({ $and: [{ $gte: ['$replies.t', now - wk] }, { $lt: ['$replies.t', now] }] }),
        w2: sum({ $and: [{ $gte: ['$replies.t', now - 2 * wk] }, { $lt: ['$replies.t', now - wk] }] }),
      } }],
    } },
    ], { hint: ORDER_INDEX }).toArray(),
    interviewRows(Contact, Interview, uid),
    activity(C, scope, now),
  ]);

  const g = f.m[0] || { total: 0 };
  const n = (k) => g[k] || 0;
  const metrics = {
    total: n('total'), sentCount: n('sentCount'), repliedCount: n('repliedCount'), fuCount: n('fuCount'),
    bouncedCount: n('bouncedCount'), afterFuCount: n('afterFuCount'),
    beforeFuCount: n('repliedCount') - n('afterFuCount'),
    inReviewEver: n('inReviewEver'), closedEver: n('closedEver'), queuedNow: n('queuedNow'),
    replyRate: pct(n('repliedCount'), n('sentCount')), bounceRate: pct(n('bouncedCount'), n('sentCount')),
  };

  // Rows sorted by count, ties in Object.entries order — the page's sort over its reduce().
  const byCount = (rows, count) => objectKeyOrder(rows, r => r._id, r => r.first).sort((a, b) => count(b) - count(a));
  const statusCurrent = byCount(f.statuses, r => r.n).map(r => ({ s: r._id, n: r.n }));
  const statusEver = STATUS_KEYS.map((s, i) => ({ s, n: n(`ever${i}`) })).filter(r => r.n > 0).sort((a, b) => b.n - a.n);
  const journey = byCount(f.journey, r => r.n).map(r => [r._id, r.n]);
  const templates = objectKeyOrder(f.templates, r => r._id, r => r.first).map(r => [r._id, { sent: r.sent, replied: r.replied }]);
  const companies = f.companies.map(r => ({ co: r._id, total: r.total, replied: r.replied, rate: pct(r.replied, r.total) }));
  const pairs = (f.pairs[0]?.all || []).sort((a, b) => a - b);

  // buildDailySeries, for both ranges the page offers.
  const sentBy = new Map(), repBy = new Map();
  const weekday = { sends: [0, 0, 0, 0, 0, 0, 0], replies: [0, 0, 0, 0, 0, 0, 0] };
  const replyWd = [0, 0, 0, 0, 0, 0, 0], replyHr = new Array(24).fill(0);
  const week = { s1: 0, s2: 0, r1: 0, r2: 0 };
  for (const r of f.sendTimes) {
    sentBy.set(t(r._id.day), (sentBy.get(t(r._id.day)) || 0) + r.n);
    weekday.sends[(r._id.wd + 5) % 7] += r.n;
    week.s1 += r.w1; week.s2 += r.w2;
  }
  for (const r of f.replyTimes) {
    repBy.set(t(r._id.day), (repBy.get(t(r._id.day)) || 0) + r.n);
    weekday.replies[(r._id.wd + 5) % 7] += r.n;
    replyWd[r._id.wd - 1] += r.n;
    replyHr[r._id.hr] += r.n;
    week.r1 += r.w1; week.r2 += r.w2;
  }
  const series = {};
  for (const days of [30, 90]) {
    const out = [];
    const end = t(today), start = end - (days - 1) * DAY;
    for (let k = start; k <= end; k += DAY) out.push({ day: k, sent: sentBy.get(k) || 0, replied: repBy.get(k) || 0 });
    series[days] = out;
  }

  return {
    now, tz, metrics, statusCurrent, statusEver, journey, templates, companies, pairs, series,
    weekday, replyWd, replyHr, week, adv: n('adv'), due: n('due'),
    interviewRows: ivRows,
    activity: act,
  };
}

module.exports = { summary, activity, ACTIVITY_WINDOWS, CONTACT_ACTIVITY_TYPES };
