/**
 * The shared Library: every account's contact DATA, pooled — never anyone's
 * progress. This is the second place in the app that reads across accounts
 * (routes/admin.js is the first, and returns numbers only), so the rules here
 * are deliberately blunt:
 *
 *  - Every pipeline starts with `userId: { $in: <sharing accounts> }`. An account
 *    is sharing unless it is disabled or opted out (User.libraryOptOut). An empty
 *    list matches nothing.
 *  - Every pipeline names its output fields in an explicit $project / $group.
 *    Nothing is spread from the source document, so a field added to Contact next
 *    month (a reply, a note, a status) cannot reach another account by accident.
 *    scripts/test-library.js asserts the exact keys of every row.
 *  - The one bit derived from progress is `bounced`: a boolean, true when any
 *    sharing account's contact at that address hard-bounced. No who, no when.
 *  - Nothing is stored. The Library is computed on read, so it can never drift
 *    from (or outlive) the rows it is built from.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Prospect = require('../models/Prospect');
const CompanyPattern = require('../models/CompanyPattern');
const { FREE_MAIL } = require('./emailPatterns');

const TABS = ['people', 'leads', 'discover', 'companies'];
const MAX_LIMIT = 100;
const MAX_IDS = 2000;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lc = (s) => String(s || '').trim().toLowerCase();
const FREE = [...FREE_MAIL];

// ── Who is in the pool ──────────────────────────────────────────────────────

/** The sharing accounts, and the name to show for each in "Added by". */
async function sharingUsers() {
  const users = await User.find(
    { status: { $ne: 'disabled' }, libraryOptOut: { $ne: true } },
    { name: 1, email: 1 },
  ).lean();
  const names = new Map(users.map(u => [String(u._id), (u.name || '').trim() || u.email]));
  return { ids: users.map(u => u._id), names };
}

/** Lowercased addresses that hard-bounced for any of these accounts. */
async function bouncedEmails(userIds) {
  const list = await Contact.distinct('email', { userId: { $in: userIds }, status: 'bounced', deleted: { $ne: true } });
  return [...new Set(list.map(lc).filter(Boolean))];
}

/** The viewer's own contact addresses — for "In my contacts" and "Hide ones I have". */
async function myEmails(userId) {
  const list = await Contact.distinct('email', { userId, deleted: { $ne: true } });
  return [...new Set(list.map(lc).filter(Boolean))];
}

// ── Filters ─────────────────────────────────────────────────────────────────

function parseFilters(q = {}) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit, 10) || 25));
  return {
    q: String(q.q || '').trim().slice(0, 120),
    source: String(q.source || '').trim(),
    domain: lc(q.domain).replace(/^@/, '').slice(0, 200),
    hideMine: q.hideMine === '1' || q.hideMine === 'true',
    hideBounced: q.hideBounced === '1' || q.hideBounced === 'true',
    sort: q.sort === 'people' ? 'people' : 'recent',
    page, limit,
    ids: q.ids === '1',
  };
}

/** A case-insensitive "contains" over several fields. */
const searchOn = (fields, q) => {
  if (!q) return null;
  const re = { $regex: escapeRe(q), $options: 'i' };
  return { $or: fields.map(f => ({ [f]: re })) };
};
const onDomain = (field, d) => (d ? { [field]: { $regex: `@${escapeRe(d)}$`, $options: 'i' } } : null);
const and = (...parts) => {
  const p = parts.filter(Boolean);
  return p.length ? { $and: p } : {};
};

// ── One pipeline per tab, up to and including the per-key group ─────────────
//
// Each returns stages whose output rows are keyed by `_id` (the dedupe key)
// and carry `users` (contributing account ids) and `lastAt`.

function peopleStages(userIds, f) {
  const src = {
    lead: { source: 'lead' },
    discover: { prospectId: { $type: 'string' } },
    naukri: { naukriJobId: { $type: 'string' } },
    outreach: { source: { $ne: 'lead' }, prospectId: { $exists: false }, naukriJobId: { $exists: false } },
  }[f.source] || null;
  return [
    { $match: and(
      { userId: { $in: userIds }, deleted: { $ne: true }, email: { $type: 'string', $ne: '' } },
      src, onDomain('email', f.domain), searchOn(['name', 'email', 'company', 'role', 'jobTitle'], f.q),
    ) },
    { $project: {
      _id: 0, userId: 1, createdAt: 1,
      email: { $toLower: { $trim: { input: '$email' } } },
      name: 1, company: 1, role: 1, jobTitle: 1, linkedin: 1,
      src: { $cond: [{ $ifNull: ['$prospectId', false] }, 'discover',
        { $cond: [{ $ifNull: ['$naukriJobId', false] }, 'naukri',
          { $cond: [{ $eq: ['$source', 'lead'] }, 'lead', 'outreach'] }] }] },
    } },
    // $max on a string keeps a non-empty value over an empty one, whatever order
    // the rows arrive in — so the merged row is the same on every read.
    { $group: {
      _id: '$email',
      name: { $max: '$name' }, company: { $max: '$company' }, role: { $max: '$role' },
      jobTitle: { $max: '$jobTitle' }, linkedin: { $max: '$linkedin' },
      sources: { $addToSet: '$src' },
      users: { $addToSet: '$userId' },
      firstAt: { $min: '$createdAt' }, lastAt: { $max: '$createdAt' },
    } },
    { $addFields: { email: '$_id' } },
  ];
}

function leadStages(userIds, f) {
  const sources = ['scroll', 'paste', 'hn', 'web-post', 'gmail'];
  return [
    { $match: and(
      { userId: { $in: userIds }, deleted: { $ne: true } },
      sources.includes(f.source) ? { source: f.source } : null,
      onDomain('email', f.domain), searchOn(['authorName', 'email', 'company', 'role', 'location'], f.q),
    ) },
    { $project: {
      _id: 0, userId: 1, createdAt: 1,
      email: { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } },
      authorName: 1, authorUrl: 1, company: 1, role: 1, location: 1, source: 1, postUrl: 1, postedAt: 1,
    } },
    // Same person across accounts: by address when there is one, else by the post
    // or profile URL (always set for the newer sources), else by name.
    { $addFields: { key: { $cond: [{ $gt: [{ $strLenCP: '$email' }, 0] }, { $concat: ['e:', '$email'] },
      { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$authorUrl', ''] } }, 0] }, { $concat: ['a:', '$authorUrl'] },
        { $concat: ['n:', { $toLower: { $ifNull: ['$authorName', ''] } }] }] }] } } },
    { $group: {
      _id: '$key',
      email: { $max: '$email' }, name: { $max: '$authorName' }, authorUrl: { $max: '$authorUrl' },
      company: { $max: '$company' }, role: { $max: '$role' }, location: { $max: '$location' },
      postUrl: { $max: '$postUrl' }, postedAt: { $max: '$postedAt' },
      sources: { $addToSet: '$source' },
      users: { $addToSet: '$userId' },
      firstAt: { $min: '$createdAt' }, lastAt: { $max: '$createdAt' },
    } },
  ];
}

const CONF_RANK = { high: 4, medium: 3, generic: 2, low: 1 };

function discoverStages(userIds, f) {
  const via = ['search', 'github', 'website'];
  return [
    { $match: and(
      { userId: { $in: userIds }, deleted: { $ne: true }, status: { $nin: ['discarded', 'error'] } },
      via.includes(f.source) ? { foundVia: f.source } : null,
      f.domain ? { domain: f.domain } : null,
      searchOn(['name', 'title', 'company', 'domain', 'email'], f.q),
    ) },
    { $project: {
      _id: 0, userId: 1, createdAt: 1,
      key: { $concat: [{ $toLower: '$domain' }, '|', '$nameKey'] },
      domain: { $toLower: '$domain' }, name: 1, title: 1, company: 1, linkedin: 1, foundVia: 1,
      email: { $toLower: { $ifNull: ['$email', ''] } },
      emailPattern: 1, emailConfidence: 1,
      rank: { $switch: { branches: Object.entries(CONF_RANK).map(([k, v]) => ({ case: { $eq: ['$emailConfidence', k] }, then: v })), default: 0 } },
    } },
    // Two accounts may have guessed different addresses for the same person: keep
    // the most confident guess (newest on a tie).
    { $sort: { rank: -1, createdAt: -1 } },
    { $group: {
      _id: '$key',
      domain: { $first: '$domain' }, name: { $max: '$name' }, title: { $max: '$title' },
      company: { $max: '$company' }, linkedin: { $max: '$linkedin' },
      email: { $first: '$email' }, emailPattern: { $first: '$emailPattern' }, emailConfidence: { $first: '$emailConfidence' },
      foundVia: { $push: '$foundVia' },
      users: { $addToSet: '$userId' },
      firstAt: { $min: '$createdAt' }, lastAt: { $max: '$createdAt' },
    } },
    { $addFields: { foundVia: { $reduce: { input: '$foundVia', initialValue: [], in: { $setUnion: ['$$value', { $ifNull: ['$$this', []] }] } } } } },
  ];
}

function companyStages(userIds, f) {
  const live = { userId: { $in: userIds }, deleted: { $ne: true } };
  const fromEmail = (kind) => [
    { $project: { _id: 0, userId: 1, createdAt: 1, company: 1, kind: { $literal: kind },
      person: { $toLower: '$email' } } },
    { $addFields: { domain: { $arrayElemAt: [{ $split: ['$person', '@'] }, 1] } } },
  ];
  return [
    { $match: { ...live, email: { $type: 'string', $ne: '' } } },
    ...fromEmail('contact'),
    { $unionWith: { coll: Lead.collection.name, pipeline: [
      { $match: { ...live, email: { $type: 'string', $ne: '' } } }, ...fromEmail('lead'),
    ] } },
    { $unionWith: { coll: Prospect.collection.name, pipeline: [
      { $match: { ...live, status: { $nin: ['discarded', 'error'] } } },
      { $project: { _id: 0, userId: 1, createdAt: 1, company: 1, kind: { $literal: 'prospect' },
        domain: { $toLower: '$domain' }, person: { $concat: ['p:', { $toLower: '$domain' }, '|', '$nameKey'] } } },
    ] } },
    { $match: and(
      { domain: { $type: 'string', $nin: ['', ...FREE] } },
      f.domain ? { domain: f.domain } : null,
      searchOn(['domain', 'company'], f.q),
    ) },
    { $group: {
      _id: '$domain',
      company: { $max: '$company' },
      people: { $addToSet: '$person' },
      users: { $addToSet: '$userId' },
      contacts: { $sum: { $cond: [{ $eq: ['$kind', 'contact'] }, 1, 0] } },
      leads: { $sum: { $cond: [{ $eq: ['$kind', 'lead'] }, 1, 0] } },
      prospects: { $sum: { $cond: [{ $eq: ['$kind', 'prospect'] }, 1, 0] } },
      firstAt: { $min: '$createdAt' }, lastAt: { $max: '$createdAt' },
    } },
    { $addFields: { domain: '$_id', people: { $size: '$people' } } },
  ];
}

const STAGES = { people: peopleStages, leads: leadStages, discover: discoverStages, companies: companyStages };
const MODEL = { people: Contact, leads: Lead, discover: Prospect, companies: Contact };

// ── Rows out: the allowlist ─────────────────────────────────────────────────

const addedBy = (users, names, viewerId) => (users || [])
  .map(u => String(u))
  .filter(u => names.has(u))
  .map(u => ({ name: u === String(viewerId) ? 'You' : names.get(u), you: u === String(viewerId) }))
  .sort((a, b) => Number(b.you) - Number(a.you) || a.name.localeCompare(b.name));

const s = (v) => (typeof v === 'string' ? v : '');
const d = (v) => (v instanceof Date ? v.toISOString() : null);

/** The ONLY shape a row leaves this file in. Keep scripts/test-library.js in step. */
function shapeRow(tab, r, ctx) {
  const common = {
    key: String(r._id),
    addedBy: addedBy(r.users, ctx.names, ctx.viewerId),
    firstAt: d(r.firstAt), lastAt: d(r.lastAt),
  };
  const email = s(r.email);
  const flags = email ? { bounced: ctx.bounced.has(email), inMine: ctx.mine.has(email) } : { bounced: false, inMine: false };
  if (tab === 'people') {
    return { ...common, ...flags, email, name: s(r.name), company: s(r.company), role: s(r.role),
      jobTitle: s(r.jobTitle), linkedin: s(r.linkedin), sources: (r.sources || []).filter(Boolean).sort() };
  }
  if (tab === 'leads') {
    return { ...common, ...flags, email, name: s(r.name), company: s(r.company), role: s(r.role),
      location: s(r.location), authorUrl: s(r.authorUrl), postUrl: s(r.postUrl), postedAt: d(r.postedAt),
      sources: (r.sources || []).filter(Boolean).sort() };
  }
  if (tab === 'discover') {
    return { ...common, ...flags, email, name: s(r.name), title: s(r.title), company: s(r.company),
      domain: s(r.domain), linkedin: s(r.linkedin), emailPattern: s(r.emailPattern),
      emailConfidence: s(r.emailConfidence), foundVia: (r.foundVia || []).filter(Boolean).sort() };
  }
  const fmt = ctx.formats.get(r._id) || { patterns: [], genericEmails: [] };
  return { ...common, domain: s(r.domain), company: s(r.company), people: r.people || 0,
    contacts: r.contacts || 0, leads: r.leads || 0, prospects: r.prospects || 0,
    contributors: common.addedBy.length, formats: fmt.patterns, genericEmails: fmt.genericEmails };
}

/** Formats people SET for these domains (Discover → Set format / Test format), with how many accounts agree. */
async function formatsFor(domains, userIds) {
  if (!domains.length) return new Map();
  const rows = await CompanyPattern.find(
    { userId: { $in: userIds }, domain: { $in: domains } },
    { _id: 0, domain: 1, manualPattern: 1, manualFrom: 1, genericEmails: 1 },
  ).lean();
  const out = new Map();
  for (const r of rows) {
    const e = out.get(r.domain) || { counts: new Map(), generic: new Set() };
    if (r.manualPattern) {
      const c = e.counts.get(r.manualPattern) || { pattern: r.manualPattern, accounts: 0, tested: false };
      c.accounts += 1;
      if (r.manualFrom === 'test' || r.manualFrom === 'example') c.tested = true;
      e.counts.set(r.manualPattern, c);
    }
    for (const g of r.genericEmails || []) if (typeof g === 'string') e.generic.add(lc(g));
    out.set(r.domain, e);
  }
  return new Map([...out].map(([dom, e]) => [dom, {
    patterns: [...e.counts.values()].sort((a, b) => b.accounts - a.accounts),
    genericEmails: [...e.generic].sort().slice(0, 10),
  }]));
}

// ── Public API ──────────────────────────────────────────────────────────────

async function context(viewerId, tab) {
  const { ids, names } = await sharingUsers();
  // The viewer's own bounces count even if they opted out of sharing.
  const bounceIds = ids.some(i => String(i) === String(viewerId)) ? ids : [...ids, new mongoose.Types.ObjectId(String(viewerId))];
  const needEmails = tab !== 'companies';
  const [bounced, mine] = needEmails
    ? await Promise.all([bouncedEmails(bounceIds), myEmails(viewerId)])
    : [[], []];
  return { ids, names, viewerId, bounced: new Set(bounced), mine: new Set(mine), bouncedList: bounced, mineList: mine };
}

/** Matches on the merged rows: hide my own, hide bounced. */
function postFilters(tab, f, ctx) {
  if (tab === 'companies') return [];
  const out = [];
  if (f.hideMine && ctx.mineList.length) out.push({ $match: { email: { $nin: ctx.mineList } } });
  if (f.hideBounced && ctx.bouncedList.length) out.push({ $match: { email: { $nin: ctx.bouncedList } } });
  return out;
}

async function list(tab, viewerId, query) {
  if (!TABS.includes(tab)) throw Object.assign(new Error('Unknown tab'), { status: 400 });
  const f = parseFilters(query);
  const ctx = await context(viewerId, tab);
  if (!ctx.ids.length) return { rows: [], total: 0, page: 1, pages: 1, limit: f.limit, ...(f.ids ? { ids: [] } : {}) };

  const sort = tab === 'companies' && f.sort === 'people' ? { people: -1, _id: 1 } : { lastAt: -1, _id: 1 };
  const [res] = await MODEL[tab].aggregate([
    ...STAGES[tab](ctx.ids, f),
    ...postFilters(tab, f, ctx),
    { $sort: sort },
    { $facet: {
      rows: [{ $skip: (f.page - 1) * f.limit }, { $limit: f.limit }],
      total: [{ $count: 'n' }],
      ...(f.ids ? { ids: [{ $limit: MAX_IDS }, { $project: { _id: 1 } }] } : {}),
    } },
  ]).allowDiskUse(true);

  const total = (res.total[0] && res.total[0].n) || 0;
  if (tab === 'companies') ctx.formats = await formatsFor(res.rows.map(r => r._id), ctx.ids);
  return {
    rows: res.rows.map(r => shapeRow(tab, r, ctx)),
    total,
    page: f.page,
    pages: Math.max(1, Math.ceil(total / f.limit)),
    limit: f.limit,
    ...(f.ids ? { ids: res.ids.map(r => String(r._id)) } : {}),
  };
}

/** The merged rows behind these keys, built on the server — import never trusts client row data. */
async function resolve(tab, viewerId, keys) {
  if (!['people', 'leads', 'discover'].includes(tab)) throw Object.assign(new Error('Only people, leads and Discover rows can be added'), { status: 400 });
  const ctx = await context(viewerId, tab);
  if (!ctx.ids.length || !keys.length) return { rows: [], ctx };
  const rows = await MODEL[tab].aggregate([
    ...STAGES[tab](ctx.ids, parseFilters({})),
    { $match: { _id: { $in: keys } } },
  ]).allowDiskUse(true);
  return { rows: rows.map(r => shapeRow(tab, r, ctx)), ctx };
}

module.exports = { TABS, MAX_IDS, list, resolve, sharingUsers, parseFilters };
