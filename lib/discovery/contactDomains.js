/**
 * Your contacts, summarised per work domain — what the company scorer
 * (companyWorth.js) and the Companies list (companyView.js) read from them.
 *
 * Both used to load every contact (2.7 MB for a 12k account, ~25 s on the
 * throttled Atlas free tier) and group them in JS. `domainStats` and
 * `domainList` do the grouping in MongoDB and return only the domains asked
 * for, or the top of the list. `statsFromContacts` is the same summary built
 * from a contact list in JS — the definition the database versions must match
 * (scripts/parity/companies.js), and what the scorer's unit tests feed it.
 *
 * Exactness, where MongoDB and JS differ:
 *  - domainOfEmail lowercases and trims the part after the last '@'. MongoDB's
 *    $toLower is ASCII-only, so non-ASCII parts are mapped by the JS function
 *    and passed in; trim uses String#trim's exact whitespace set.
 *  - keyOf (company-name key) is JS-only (accent stripping, regexes), so the
 *    distinct company names are keyed in JS and matched back by value.
 *  - HARD_BOUNCE runs in MongoDB on ASCII bounce texts (where PCRE and JS agree);
 *    non-ASCII ones come back to be tested in JS.
 *  - "First" (the company name shown, insertion order) follows the order the
 *    old unsorted contact query returned: its cached plan's index scan, streamed.
 */

const mongoose = require('mongoose');
const { domainOfEmail, isFreeMail, FREE_MAIL } = require('../emailPatterns');
const { HARD_BOUNCE } = require('../patternScore');
const { COMPANY_SUFFIXES } = require('./linkedinResult');

const DAY = 24 * 3600 * 1000;
const POSITIVE = ['reviewing', 'resume-requested'];
const REPLIED = ['replied', 'follow-up-replied'];
// companyView.tally: a status that means an email went out.
const SENT_STATUSES = ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced'];
const JS_TRIM = '\t\n\v\f\r                  　﻿';
const ASCII_ONLY = '^[\\x00-\\x7F]*$';
const NON_ASCII = '[^\\x00-\\x7F]';
// The pre-load's projection — the query whose order "first" follows.
const OLD_PROJECTION = { email: 1, company: 1, status: 1, replyCategory: 1, repliedAt: 1, lastSentAt: 1, bounceReason: 1 };

const asId = (id) => new mongoose.Types.ObjectId(String(id));
// Every field read here. Projected first, so the database never carries whole contacts
// (with their mail threads) through a pipeline.
const SLIM = { email: 1, company: 1, status: 1, replyCategory: 1, repliedAt: 1, lastSentAt: 1, bounceReason: 1 };

function emptyStats(pos) {
  return {
    firstPos: pos, n: 0, positive: 0, stay: false, saidNo: false, anyReply: false, tried: 0, sent: 0, hard: 0,
    tallySent: 0, replied: 0, bounced: 0, lastMs: -Infinity, name: '',
  };
}

/**
 * The summary from a contact list, in list order — the reference definition.
 * @param {{ noReplyDays: number, triedAfterDays: number }} rules  companyWorth RULES
 * @param {function} keyOf  company-name key (hiringCompanies.keyOf)
 * @returns {{ byDomain: Map<string, object>, votes: Map<string, Map<string, number>> }}
 */
function statsFromContacts(contacts, { now, rules, keyOf }) {
  const t = now.getTime();
  const byDomain = new Map();
  const votes = new Map();
  contacts.forEach((c, pos) => {
    const d = domainOfEmail(c.email);
    if (!d || isFreeMail(d)) return;
    let s = byDomain.get(d);
    if (!s) byDomain.set(d, (s = emptyStats(pos)));
    s.n++;
    if (POSITIVE.includes(c.replyCategory)) s.positive++;
    if (c.replyCategory === 'stay-in-touch') s.stay = true;
    if (c.replyCategory === 'no' && c.repliedAt && new Date(c.repliedAt).getTime() >= t - rules.noReplyDays * DAY) s.saidNo = true;
    if (c.repliedAt || REPLIED.includes(c.status)) s.anyReply = true;
    if (c.lastSentAt && new Date(c.lastSentAt).getTime() <= t - rules.triedAfterDays * DAY) s.tried++;
    if (c.lastSentAt || c.status === 'bounced') s.sent++;
    if (c.status === 'bounced' && HARD_BOUNCE.test(c.bounceReason || '')) s.hard++;
    if (c.lastSentAt || SENT_STATUSES.includes(c.status)) s.tallySent++;
    if (!!c.repliedAt || REPLIED.includes(c.status)) s.replied++;
    if (c.status === 'bounced') s.bounced++;
    s.lastMs = Math.max(s.lastMs, new Date(c.repliedAt || c.lastSentAt || 0).getTime());
    if (!s.name) s.name = String(c.company || '').trim();
    const nk = keyOf(c.company || '');
    if (!nk) return;
    if (!votes.has(nk)) votes.set(nk, new Map());
    const v = votes.get(nk);
    v.set(d, (v.get(d) || 0) + 1);
  });
  return { byDomain, votes };
}

/** The domain a company name points at: most contacts, first seen on a tie. */
function domainForName(votes, keyOf, name) {
  const v = votes.get(keyOf(name || ''));
  if (!v) return null;
  return [...v.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── The database version ────────────────────────────────────────────────────
const typeIs = (f, ...types) => ({ $in: [{ $type: f }, types] });
const falsy = (f) => ({ $in: [{ $ifNull: [f, null] }, [null, false, 0, '', NaN]] });
const truthy = (f) => ({ $not: [falsy(f)] });
const ascii = (f) => ({ $regexMatch: { input: f, regex: ASCII_ONLY } });
const msOf = (f) => ({ $toLong: f });

// The order the old unsorted pre-load query returned. MongoDB caches one plan per query
// shape, and the cached plan for {userId, deleted} is this index scan (checked against
// the real query for every prod account by scripts/parity/companies.js).
const ORDER_INDEX = { userId: 1, createdAt: -1 };

// The part after the last '@' (when it isn't the first character), else null.
const TAIL = { $let: {
  vars: { e: { $ifNull: ['$email', ''] } },
  in: { $let: {
    vars: { last: { $arrayElemAt: [{ $split: ['$$e', '@'] }, -1] } },
    in: { $cond: [{ $gt: [{ $subtract: [{ $strLenCP: '$$e' }, { $add: [{ $strLenCP: '$$last' }, 1] }] }, 0] }, '$$last', null] },
  } },
} };

// hiringCompanies.keyOf for an ASCII name, step by step — normCompany, then the trailing
// ".com"-style words and the spaces dropped. NFKD changes nothing in ASCII, and on ASCII
// PCRE and JS agree on these patterns (\b, alternation order, left-to-right matches).
const KEY_TLDS = ['com', 'in', 'io', 'co', 'net', 'org', 'ai', 'tech'];
function keyOfExpr(f) {
  const s1 = { $replaceAll: { input: { $toLower: f }, find: '&', replacement: ' and ' } };
  // .replace(COMPANY_SUFFIXES, ' '): rebuild the string around every match.
  const s2 = { $let: { vars: { s: s1 }, in: { $let: {
    vars: { r: { $reduce: {
      input: { $regexFindAll: { input: '$$s', regex: COMPANY_SUFFIXES.source } },
      initialValue: { out: '', at: 0 },
      in: {
        out: { $concat: ['$$value.out', { $substrCP: ['$$s', '$$value.at', { $subtract: ['$$this.idx', '$$value.at'] }] }, ' '] },
        at: { $add: ['$$this.idx', { $strLenCP: '$$this.match' }] },
      },
    } } },
    in: { $concat: ['$$r.out', { $substrCP: ['$$s', '$$r.at', { $strLenCP: '$$s' }] }] },
  } } } };
  // .replace(/[^a-z0-9]+/g, ' ').trim() — the alphanumeric runs, single-spaced.
  const words = { $map: { input: { $regexFindAll: { input: s2, regex: '[a-z0-9]+' } }, in: '$$this.match' } };
  return { $let: { vars: { w: words }, in: { $let: {
    // .replace(/( (com|in|…))+$/, ''): trailing such words, never the first.
    vars: { drop: { $reduce: {
      input: { $reverseArray: '$$w' },
      initialValue: { n: 0, stop: false },
      in: { $cond: [
        { $and: [{ $not: ['$$value.stop'] }, { $in: ['$$this', KEY_TLDS] }, { $lt: ['$$value.n', { $subtract: [{ $size: '$$w' }, 1] }] }] },
        { n: { $add: ['$$value.n', 1] }, stop: false },
        { n: '$$value.n', stop: true },
      ] },
    } } },
    // .replace(/ /g, '')
    in: { $reduce: { input: { $slice: ['$$w', 0, { $max: [1, { $subtract: [{ $size: '$$w' }, '$$drop.n'] }] }] }, initialValue: '', in: { $concat: ['$$value', '$$this'] } } },
  } } } };
}

/**
 * Every contact with a work domain, in the old order, numbered (`pos`), with `d`.
 * `tailMap` maps the non-ASCII tails to the JS domain.
 */
function keptContacts(scope, tailMap, now, rules, { withKeys = false } = {}) {
  const tails = Object.keys(tailMap), ds = tails.map(k => tailMap[k]);
  const reason = { $ifNull: ['$bounceReason', ''] };
  return [
    { $match: scope },
    { $project: SLIM },
    { $group: { _id: null, cs: { $push: {
      tail: TAIL, company: '$company', s: '$status', rc: '$replyCategory', r: '$repliedAt', l: '$lastSentAt',
      // HARD_BOUNCE: decided here for ASCII texts, in JS otherwise (the text comes back).
      hb: { $cond: [{ $eq: ['$status', 'bounced'] },
        { $cond: [ascii(reason), { $regexMatch: { input: reason, regex: HARD_BOUNCE.source, options: 'i' } }, 'js'] }, false] },
      br: { $cond: [{ $and: [{ $eq: ['$status', 'bounced'] }, { $not: [ascii(reason)] }] }, reason, '$$REMOVE'] },
    } } } },
    { $unwind: { path: '$cs', includeArrayIndex: 'pos' } },
    { $replaceWith: { $mergeObjects: ['$cs', { pos: '$pos' }] } },
    { $addFields: { d: { $cond: [{ $eq: ['$tail', null] }, '',
      { $cond: [ascii('$tail'), { $trim: { input: { $toLower: '$tail' }, chars: JS_TRIM } },
        { $arrayElemAt: [ds, { $indexOfArray: [tails, '$tail'] }] }] }] } } },
    { $match: { d: { $ne: '' }, $expr: { $not: [{ $in: ['$d', [...FREE_MAIL]] }] } } },
    { $addFields: {
      nameTrim: { $trim: { input: { $cond: [truthy('$company'), '$company', ''] }, chars: JS_TRIM } },
      lastMs: { $cond: [truthy('$r'), msOf('$r'), { $cond: [truthy('$l'), msOf('$l'), 0] }] },
      saidNoOne: { $and: [{ $eq: ['$rc', 'no'] }, truthy('$r'), { $gte: [msOf('$r'), now - rules.noReplyDays * DAY] }] },
      triedOne: { $and: [truthy('$l'), { $lte: [msOf('$l'), now - rules.triedAfterDays * DAY] }] },
    } },
    ...(withKeys ? [{ $addFields: {
      // keyOf(company || ''): here for ASCII names, in JS (from `kc`) for the rest.
      nk: { $cond: [{ $and: [truthy('$company'), { $not: [ascii('$company')] }] }, null,
        { $cond: [truthy('$company'), keyOfExpr('$company'), ''] }] },
      kc: { $cond: [{ $and: [truthy('$company'), { $not: [ascii('$company')] }] }, '$company', '$$REMOVE'] },
    } }] : []),
  ];
}

const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const STATS_GROUP = {
  _id: '$d',
  firstPos: { $min: '$pos' },
  n: { $sum: 1 },
  positive: sum({ $in: ['$rc', POSITIVE] }),
  stay: { $max: { $eq: ['$rc', 'stay-in-touch'] } },
  saidNo: { $max: '$saidNoOne' },
  anyReply: { $max: { $or: [truthy('$r'), { $in: ['$s', REPLIED] }] } },
  tried: sum('$triedOne'),
  sent: sum({ $or: [truthy('$l'), { $eq: ['$s', 'bounced'] }] }),
  hard: sum({ $eq: ['$hb', true] }),
  jsBounces: { $push: { $cond: [{ $eq: ['$hb', 'js'] }, '$br', '$$REMOVE'] } },
  tallySent: sum({ $or: [truthy('$l'), { $in: ['$s', SENT_STATUSES] }] }),
  replied: sum({ $or: [truthy('$r'), { $in: ['$s', REPLIED] }] }),
  bounced: sum({ $eq: ['$s', 'bounced'] }),
  lastMs: { $max: '$lastMs' },
  first: { $min: { $cond: [{ $ne: ['$nameTrim', ''] }, { p: '$pos', nm: '$nameTrim' }, null] } },
};

// Grouped rows travel with one-letter keys (the link is throttled; this halves them).
const SHORT = {
  _id: 1, p: '$firstPos', n: 1, a: '$positive', y: '$stay', o: '$saidNo', r: '$anyReply', t: '$tried', s: '$sent',
  h: '$hard', j: '$jsBounces', e: '$tallySent', l: '$replied', b: '$bounced', m: '$lastMs', f: '$first.nm',
};

// A grouped row → the shape statsFromContacts gives.
function toStats(g) {
  return {
    firstPos: Number(g.p), n: g.n, positive: g.a, stay: g.y, saidNo: g.o, anyReply: g.r,
    tried: g.t, sent: g.s, hard: g.h + g.j.filter(b => HARD_BOUNCE.test(b)).length,
    tallySent: g.e, replied: g.l, bounced: g.b, lastMs: Number(g.m), name: g.f || '',
  };
}

/**
 * What every query here needs first: the non-ASCII email tails mapped by the JS
 * domainOfEmail. Throws when a contact holds data in a shape the database version
 * would read differently. Run once per request and pass to domainStats/domainList.
 */
async function prepare(Contact, userId) {
  const uid = asId(userId);
  const scope = { userId: uid, deleted: { $ne: true } };
  const [f] = await Contact.collection.aggregate([{ $match: scope }, { $project: SLIM }, { $facet: {
    bad: [{ $match: { $expr: { $or: [
      { $and: [truthy('$email'), { $not: [typeIs('$email', 'string')] }] },
      { $and: [truthy('$company'), { $not: [typeIs('$company', 'string')] }] },
      { $and: [truthy('$bounceReason'), { $not: [typeIs('$bounceReason', 'string')] }] },
      ...['$repliedAt', '$lastSentAt'].map(f => ({ $and: [truthy(f), { $not: [typeIs(f, 'date')] }] })),
    ] } } }, { $limit: 1 }, { $project: { _id: 1 } }],
    tails: [{ $project: { tail: TAIL } }, { $match: { tail: { $ne: null, $not: { $regex: ASCII_ONLY } } } }, { $group: { _id: '$tail' } }],
  } }]).toArray();
  if (f.bad.length) throw new Error(`companies: contact ${f.bad[0]._id} holds data in a shape this summary does not handle`);
  const tailMap = {};
  for (const { _id: tail } of f.tails) tailMap[tail] = domainOfEmail(`x@${tail}`);
  return { uid, scope, tailMap };
}

/**
 * Stats for `domains`, plus the votes for the company-name keys `nks` and stats for
 * every domain those votes point at. Same values as statsFromContacts.
 */
async function domainStats(Contact, userId, { now, rules, keyOf, domains = [], nks = [], prep = null }) {
  const { scope, tailMap } = prep || await prepare(Contact, userId);
  const C = Contact.collection, hint = ORDER_INDEX;
  const wantNks = new Set(nks.filter(Boolean));

  const [r] = await C.aggregate([
    ...keptContacts(scope, tailMap, now.getTime(), rules, { withKeys: wantNks.size > 0 }),
    { $facet: {
      votes: wantNks.size
        ? [{ $match: { $or: [{ nk: { $in: [...wantNks] } }, { kc: { $exists: true } }] } },
          { $group: { _id: { k: '$nk', c: { $ifNull: ['$kc', null] }, d: '$d' }, n: { $sum: 1 }, first: { $min: '$pos' } } }]
        : [{ $match: { $expr: false } }],
      stats: [{ $group: STATS_GROUP }, { $project: SHORT }],
    } },
    // Only the stats asked for, and those of every domain a vote points at.
    { $project: { votes: 1, stats: { $filter: { input: '$stats', cond: { $or: [
      { $in: ['$$this._id', domains] },
      { $in: ['$$this._id', { $map: { input: '$votes', in: '$$this._id.d' } }] },
    ] } } } } },
  ], { hint }).toArray();

  const byDomain = new Map(r.stats.map(g => [g._id, toStats(g)]));
  // Votes per (key, domain), each pair placed where its first contact was.
  const pairs = new Map();
  for (const v of r.votes) {
    const nk = v._id.k !== null ? v._id.k : keyOf(v._id.c || '');
    if (!wantNks.has(nk)) continue;
    const id = `${nk}\u0000${v._id.d}`;
    const p = pairs.get(id) || { nk, d: v._id.d, n: 0, first: Infinity };
    p.n += v.n; p.first = Math.min(p.first, Number(v.first));
    pairs.set(id, p);
  }
  const votes = new Map();
  for (const p of [...pairs.values()].sort((a, b) => a.first - b.first)) {
    if (!votes.has(p.nk)) votes.set(p.nk, new Map());
    votes.get(p.nk).set(p.d, p.n);
  }
  return { byDomain, votes };
}

// hiringCompanies.nameFromDomain, for an ASCII domain.
const NAME_FROM_DOMAIN = { $ifNull: [{ $reduce: {
  input: { $filter: {
    input: { $split: [{ $replaceAll: { input: { $arrayElemAt: [{ $split: ['$_id', '.'] }, 0] }, find: '_', replacement: '-' } }, '-'] },
    cond: { $ne: ['$$this', ''] },
  } },
  initialValue: null,
  in: { $let: {
    vars: { w: { $concat: [{ $toUpper: { $substrCP: ['$$this', 0, 1] } }, { $substrCP: ['$$this', 1, { $strLenCP: '$$this' }] }] } },
    in: { $cond: [{ $eq: ['$$value', null] }, '$$w', { $concat: ['$$value', ' ', '$$w'] }] },
  } },
} }, ''] };

/**
 * The Companies list's contact-only rows: every work domain not in `exclude`,
 * matching `needle` (already trimmed + lowercased), the first `limit` under `sort`.
 * Rows whose name or domain isn't ASCII are matched in JS by the caller (`jsRows`).
 * @returns {{ rows: object[], jsRows: object[], total: number }}  rows carry `domain` + stats
 */
async function domainList(Contact, userId, { now, rules, exclude = [], needle = '', sort = 'score', limit = 100, prep = null }) {
  const { scope, tailMap } = prep || await prepare(Contact, userId);
  const C = Contact.collection, hint = ORDER_INDEX;
  const order = sort === 'recent' ? { lastMs: -1, firstPos: 1 }
    : sort === 'contacts' ? { n: -1, replied: -1, firstPos: 1 } : { n: -1, firstPos: 1 };
  const isJs = { $or: [{ $not: [ascii('$_id')] }, { $and: [{ $ne: ['$first', null] }, { $not: [ascii('$first.nm')] }] }] };
  const matches = needle ? { $or: [
    { $gte: [{ $indexOfCP: [{ $toLower: '$company' }, needle] }, 0] },
    { $gte: [{ $indexOfCP: ['$_id', needle] }, 0] },
  ] } : true;

  const [r] = await C.aggregate([
    ...keptContacts(scope, tailMap, now.getTime(), rules),
    { $group: STATS_GROUP },
    { $match: { _id: { $nin: exclude } } },
    { $addFields: { js: isJs } },
    { $addFields: { company: { $cond: ['$js', null, { $ifNull: ['$first.nm', NAME_FROM_DOMAIN] }] } } },
    { $facet: {
      // Without a search every row is plain data; with one, js rows are matched by the caller.
      rows: [{ $match: needle ? { js: false, $expr: matches } : {} }, { $sort: order }, { $limit: limit }, { $project: SHORT }],
      total: [{ $match: needle ? { js: false, $expr: matches } : {} }, { $count: 'n' }],
      jsRows: needle ? [{ $match: { js: true } }, { $project: SHORT }] : [{ $match: { $expr: false } }],
    } },
  ], { hint }).toArray();
  const out = (g) => ({ domain: g._id, ...toStats(g) });
  return { rows: r.rows.map(out), jsRows: r.jsRows.map(out), total: r.total[0]?.n || 0 };
}

module.exports = { statsFromContacts, domainForName, prepare, domainStats, domainList, OLD_PROJECTION, keyOfExpr };
