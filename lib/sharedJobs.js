// Jobs found by OTHER sharing accounts on their platforms (Naukri, Instahyre, Hirist),
// for the Jobs tab's "Others" view. Like lib/library.js: computed on read, no stored copy,
// an explicit allowlist, and only the accounts that have not opted out of sharing.
//
// What is public here is the JOB, as the platform showed it. Nothing about what
// anyone did with it (approval, applied, score, notes, recruiters found) ever
// leaves this file; scripts/test-shared-jobs.js asserts the exact keys.
// The one thing a viewer can do with a row is add it to THEIR OWN list.

const NaukriJob = require('../models/NaukriJob');
const { sharingUsers } = require('./library');
const { dupKeyOf } = require('./jobDupes');
const { scoreJob } = require('./naukriScore');
const { siteOf, labelOf, isPlatform } = require('./platforms');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A listing nobody's harvest has seen for a while has probably closed.
const FRESH_DAYS = 30;
const PAGE_MAX = 100;

/** The only fields a job row may carry out of this module. */
function shapeRow(r, mine) {
  return {
    key: r._id,                               // `<platform>:<site id>`, the same key a job has in every account
    platform: r.platform || 'naukri',
    title: r.title, company: r.company || '', location: r.location || '',
    experienceMin: r.experienceMin ?? null, experienceMax: r.experienceMax ?? null,
    salaryText: r.salaryText || '', tags: (r.tags || []).slice(0, 12),
    url: r.url || '', postedText: r.postedText || '', postedAt: r.postedAt || null,
    lastSeenAt: r.lastSeenAt, seenBy: r.seenBy,
    mine: mine ? { id: String(mine._id), approval: mine.approval, applyStatus: mine.applyStatus } : null,
  };
}

const KEYS_MAX = 2000;
const truthy = (v) => v === true || v === '1' || v === 'true' || v === 1;

/** The filter every shared-jobs read uses, so the list and "select all matching" cannot disagree. */
async function matchFor(viewerId, f) {
  const { ids } = await sharingUsers();
  // Other accounts only: the viewer's own jobs are the Mine view. A job the viewer
  // also has still appears (found by someone else too) and says so in `mine`.
  const pool = ids.filter(id => String(id) !== String(viewerId));
  const since = new Date(Date.now() - FRESH_DAYS * 86400_000);

  const match = { userId: { $in: pool }, deleted: { $ne: true }, lastSeenAt: { $gte: since } };
  // Hide the ones the viewer already has, before paging, so pages stay full.
  if (truthy(f.hideMine)) {
    const have = await NaukriJob.distinct('sourceKey', { userId: viewerId, deleted: { $ne: true } });
    if (have.length) match.sourceKey = { $nin: have };
  }
  if (f.platform && isPlatform(f.platform)) match.platform = f.platform === 'naukri' ? { $in: ['naukri', null] } : f.platform;
  const q = String(f.q || '').trim().slice(0, 80);
  if (q) {
    const re = new RegExp(escapeRe(q), 'i');
    match.$or = [{ title: re }, { company: re }, { tags: re }];
  }
  return match;
}

/**
 * @param {{q?: string, platform?: string, hideMine?: boolean|string, page?: number, limit?: number}} f
 * @returns {Promise<{jobs: object[], total: number, page: number, pages: number}>}
 */
async function list(viewerId, f = {}) {
  const match = await matchFor(viewerId, f);
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 40, 1), PAGE_MAX);
  const page = Math.max(parseInt(f.page, 10) || 1, 1);

  const [out] = await NaukriJob.aggregate([
    { $match: match },
    { $sort: { lastSeenAt: -1 } },
    { $group: {
      _id: '$sourceKey',
      title: { $first: '$title' }, company: { $first: '$company' }, location: { $first: '$location' },
      experienceMin: { $first: '$experienceMin' }, experienceMax: { $first: '$experienceMax' },
      salaryText: { $first: '$salaryText' }, tags: { $first: '$tags' }, url: { $first: '$url' },
      platform: { $first: '$platform' }, postedText: { $first: '$postedText' }, postedAt: { $first: '$postedAt' },
      lastSeenAt: { $max: '$lastSeenAt' }, users: { $addToSet: '$userId' },
    } },
    { $addFields: { seenBy: { $size: '$users' } } },
    { $project: { users: 0 } },
    { $sort: { lastSeenAt: -1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);

  const rows = out.rows;
  const mineDocs = rows.length
    ? await NaukriJob.find({ userId: viewerId, sourceKey: { $in: rows.map(r => r._id) }, deleted: { $ne: true } },
      { sourceKey: 1, approval: 1, applyStatus: 1 }).lean()
    : [];
  const mineBy = new Map(mineDocs.map(d => [d.sourceKey, d]));
  const total = (out.total[0] && out.total[0].n) || 0;
  return { jobs: rows.map(r => shapeRow(r, mineBy.get(r._id))), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Every job key matching the filter that the viewer does not already have, for "select all N". */
async function matchingKeys(viewerId, f = {}) {
  const match = await matchFor(viewerId, f);
  const keys = await NaukriJob.distinct('sourceKey', match);
  const have = new Set(await NaukriJob.distinct('sourceKey', { userId: viewerId, sourceKey: { $in: keys }, deleted: { $ne: true } }));
  const addable = keys.filter(k => !have.has(k));
  return { keys: addable.slice(0, KEYS_MAX), total: addable.length, capped: addable.length > KEYS_MAX };
}

/**
 * Add shared jobs to the viewer's own list, pending, scored against THEIR profile —
 * what a harvest would have done. Never approves, never applies. Idempotent.
 */
async function addToMine(viewerId, keys) {
  const NaukriConfig = require('../models/NaukriConfig');
  const { ids } = await sharingUsers();
  const wanted = [...new Set((keys || []).map(String))].slice(0, 100);
  const sources = await NaukriJob.aggregate([
    { $match: { userId: { $in: ids }, sourceKey: { $in: wanted }, deleted: { $ne: true } } },
    { $sort: { lastSeenAt: -1 } },
    { $group: { _id: '$sourceKey', doc: { $first: '$$ROOT' } } },
  ]);
  const cfg = await NaukriConfig.getForUser(viewerId);
  const now = new Date();
  let added = 0, existed = 0;
  for (const { _id: sourceKey, doc: d } of sources) {
    const platform = d.platform || 'naukri';
    const site = siteOf(cfg, platform);
    const config = platform === 'naukri' ? cfg : { searches: site.searches, filters: site.filters, profile: cfg.profile };
    const fit = scoreJob({
      title: d.title, tags: d.tags, description: d.description, experienceMin: d.experienceMin, experienceMax: d.experienceMax,
      salaryText: d.salaryText, postedText: d.postedText, likelyExternal: false, origins: ['search'],
      ...(platform !== 'naukri' ? { platformLabel: labelOf(platform) } : {}),
    }, config);
    const r = await NaukriJob.updateOne({ userId: viewerId, sourceKey }, { $setOnInsert: {
      userId: viewerId, platform, sourceId: d.sourceId, sourceKey,
      title: d.title, company: d.company || '', location: d.location || '',
      experienceMin: d.experienceMin ?? null, experienceMax: d.experienceMax ?? null,
      salaryText: d.salaryText || '', tags: d.tags || [], url: d.url || '', description: d.description || '',
      postedText: d.postedText || '', ...(d.postedAt ? { postedAt: d.postedAt } : {}),
      firstSeenAt: now, lastSeenAt: now, seenCount: 1,
      score: fit.score, scoreReasons: fit.reasons, dupKey: dupKeyOf({ company: d.company, title: d.title }),
      queries: [], origins: ['search'],
      approval: 'pending', applyStatus: 'none', applyHistory: [],
    } }, { upsert: true });
    if (r.upsertedCount) added++; else existed++;
  }
  return { added, existed, missing: wanted.length - sources.length };
}

module.exports = { list, matchingKeys, addToMine, shapeRow, FRESH_DAYS };
