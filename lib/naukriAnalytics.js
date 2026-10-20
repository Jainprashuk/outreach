// Numbers for Analytics → Naukri, for ONE account. Reads only what the Naukri flow
// already stores — nothing is logged for analytics' sake:
//   NaukriJob     state of every harvested job (approval, apply status, fit score,
//                 recruiter stage, tidy) and applyHistory, one entry per attempt
//                 with the worker's reason
//   NaukriRun     one row per worker run, with its stats
//   NaukriConfig  limits, the answer bank and the Needs answer drafts
//
// "State" figures (funnel, scores, stages) are all-time; "flow" figures (applies
// per day, outcome reasons, runs, AI) cover the last `days` days.

const mongoose = require('mongoose');
const NaukriJob = require('../models/NaukriJob');
const NaukriRun = require('../models/NaukriRun');
const NaukriConfig = require('../models/NaukriConfig');
const { reasonGroup, REASON_LABELS } = require('./naukriReasons');
const { startOfDayIn } = require('./naukriSchedule');

const DAY = 864e5;
// An application left (routes/naukri.js SENT_STATUSES).
const SENT = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];
const STAGES = ['applied', 'viewed', 'shortlisted', 'contacted', 'not-shortlisted'];
// A recruiter did something with it.
const RESPONDED = ['viewed', 'shortlisted', 'contacted', 'not-shortlisted'];
const TIDY = [['stale', /^posted/i], ['low-fit', /^fit /i], ['company-site', /company site/i]];

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const inList = (f, list) => ({ $in: [f, list] });
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// `platform` scopes it to one job platform (lib/platforms.js); left out, it
// covers every platform, as it did when Naukri was the only one.
async function naukriAnalytics(userIdRaw, { days = 30, now = new Date(), platform = null } = {}) {
  const { platformQuery } = require('./platforms');
  const userId = oid(userIdRaw);
  const scope = { userId, ...platformQuery(platform), deleted: { $ne: true } };
  const raw = await NaukriConfig.findOne({ userId }, {
    'schedule.timezone': 1, apply: 1, inboxTidy: 1, answers: 1, drafts: 1, platforms: 1, enabled: 1,
  }).lean();
  // That platform's own apply limits and tidy rules; the answer bank is shared.
  const own = raw && platform && platform !== 'naukri' && platform !== 'all' ? ((raw.platforms || {})[platform] || {}) : null;
  const cfg = raw && own ? { ...raw, schedule: own.schedule || raw.schedule, apply: own.apply || {}, inboxTidy: own.inboxTidy || {} } : raw;
  const tz = (cfg && cfg.schedule && cfg.schedule.timezone) || 'Asia/Kolkata';
  const apply = (cfg && cfg.apply) || {};
  const since = new Date(now.getTime() - days * DAY);
  let today;
  try { today = startOfDayIn(tz, now); } catch (_) { today = new Date(now); today.setHours(0, 0, 0, 0); }

  const [[f], attempts, runs] = await Promise.all([
    NaukriJob.aggregate([
      { $match: scope },
      { $facet: {
        t: [{ $group: {
          _id: null,
          found: { $sum: 1 },
          scored: sum({ $ne: [{ $ifNull: ['$score', null] }, null] }),
          pending: sum({ $eq: ['$approval', 'pending'] }),
          approved: sum({ $eq: ['$approval', 'approved'] }),
          approvedAuto: sum({ $and: [{ $eq: ['$approval', 'approved'] }, { $eq: ['$approvedBy', 'auto'] }] }),
          tidied: sum({ $and: [{ $eq: ['$approval', 'rejected'] }, { $ne: [{ $ifNull: ['$tidiedAt', null] }, null] }] }),
          rejected: sum({ $and: [{ $eq: ['$approval', 'rejected'] }, { $eq: [{ $ifNull: ['$tidiedAt', null] }, null] }] }),
          waiting: sum({ $and: [{ $eq: ['$approval', 'approved'] }, { $eq: ['$applyStatus', 'none'] }] }),
          applied: sum(inList('$applyStatus', SENT)),
          appliedToday: sum({ $gte: ['$appliedAt', today] }),
          interviewing: sum(inList('$applyStatus', ['interviewing', 'offer'])),
          offer: sum({ $eq: ['$applyStatus', 'offer'] }),
          employerRejected: sum({ $eq: ['$applyStatus', 'rejected'] }),
          skipped: sum({ $eq: ['$applyStatus', 'skipped'] }),
          failed: sum({ $eq: ['$applyStatus', 'failed'] }),
          dismissed: sum({ $eq: ['$applyStatus', 'dismissed'] }),
          responded: sum({ $and: [inList('$applyStatus', SENT), inList('$naukriStage', RESPONDED)] }),
          shortlisted: sum({ $and: [inList('$applyStatus', SENT), inList('$naukriStage', ['shortlisted', 'contacted'])] }),
          tracked: sum({ $and: [inList('$applyStatus', SENT), { $ne: [{ $ifNull: ['$trackedAt', null] }, null] }] }),
        } }],
        scores: [{ $group: {
          _id: { $cond: [{ $isNumber: '$score' }, { $min: [90, { $multiply: [{ $floor: { $divide: ['$score', 10] } }, 10] }] }, null] },
          n: { $sum: 1 },
          applied: sum(inList('$applyStatus', SENT)),
        } }],
        stages: [{ $match: { applyStatus: { $in: SENT } } }, { $group: { _id: { $ifNull: ['$naukriStage', 'unknown'] }, n: { $sum: 1 } } }],
        responseHours: [
          { $match: { applyStatus: { $in: SENT }, naukriStage: { $in: RESPONDED }, appliedAt: { $ne: null }, naukriStageAt: { $ne: null } } },
          { $project: { _id: 0, h: { $divide: [{ $subtract: ['$naukriStageAt', '$appliedAt'] }, 3600000] } } },
          { $match: { h: { $gte: 0 } } },
        ],
        tidy: [{ $match: { tidiedAt: { $ne: null }, approval: 'rejected' } }, { $group: { _id: '$tidyReason', n: { $sum: 1 } } }],
        origins: [{ $group: {
          _id: null,
          search: sum(inList('search', { $ifNull: ['$origins', []] })),
          recommended: sum(inList('recommended', { $ifNull: ['$origins', []] })),
          searchApplied: sum({ $and: [inList('search', { $ifNull: ['$origins', []] }), inList('$applyStatus', SENT)] }),
          recommendedApplied: sum({ $and: [inList('recommended', { $ifNull: ['$origins', []] }), inList('$applyStatus', SENT)] }),
        } }],
        // One row per job platform, so the All view can compare them.
        byPlatform: [{ $group: {
          _id: { $ifNull: ['$platform', 'naukri'] },
          found: { $sum: 1 },
          approved: sum({ $eq: ['$approval', 'approved'] }),
          applied: sum(inList('$applyStatus', SENT)),
          appliedToday: sum({ $gte: ['$appliedAt', today] }),
          responded: sum({ $and: [inList('$applyStatus', SENT), inList('$naukriStage', RESPONDED)] }),
          shortlisted: sum({ $and: [inList('$applyStatus', SENT), inList('$naukriStage', ['shortlisted', 'contacted'])] }),
          interviewing: sum(inList('$applyStatus', ['interviewing', 'offer'])),
        } }],
        queries: [{ $unwind: '$queries' }, { $group: {
          _id: '$queries', found: { $sum: 1 }, applied: sum(inList('$applyStatus', SENT)),
          responded: sum({ $and: [inList('$applyStatus', SENT), inList('$naukriStage', RESPONDED)] }),
        } }, { $sort: { applied: -1, found: -1, _id: 1 } }, { $limit: 10 }],
      } },
    ]),
    // Every apply attempt in the window, with the worker's reason.
    NaukriJob.aggregate([
      { $match: { ...scope, 'applyHistory.at': { $gte: since } } },
      { $unwind: '$applyHistory' },
      { $match: { 'applyHistory.at': { $gte: since }, 'applyHistory.to': { $in: ['applied', 'skipped', 'failed'] } } },
      { $project: {
        _id: 0, to: '$applyHistory.to', note: '$applyHistory.note',
        day: { $dateToString: { format: '%Y-%m-%d', date: '$applyHistory.at', timezone: tz } },
      } },
    ]),
    NaukriRun.find({ ...scope, createdAt: { $gte: since } },
      { kind: 1, status: 1, trigger: 1, exitCode: 1, stats: 1, createdAt: 1, platform: 1 }).lean(),
  ]);

  const t = f.t[0] || {};
  const n = (k) => t[k] || 0;

  // ── by platform ─────────────────────────────────────────────────────────
  // Every platform that has jobs or runs here, in registry order.
  const { PLATFORM_IDS, labelOf, platformOfDoc, siteOf, isEnabled } = require('./platforms');
  const runsBy = new Map();
  for (const r of runs) {
    const id = platformOfDoc(r);
    const x = runsBy.get(id) || { runs: 0, failedRuns: 0, blockedRuns: 0 };
    x.runs++;
    if (r.status === 'failed') x.failedRuns++;
    if (r.status === 'blocked') x.blockedRuns++;
    runsBy.set(id, x);
  }
  const byPlatform = PLATFORM_IDS.map(id => {
    const j = f.byPlatform.find(x => x._id === id) || {};
    const r = runsBy.get(id) || { runs: 0, failedRuns: 0, blockedRuns: 0 };
    return {
      platform: id, label: labelOf(id),
      found: j.found || 0, approved: j.approved || 0, applied: j.applied || 0, appliedToday: j.appliedToday || 0,
      responded: j.responded || 0, shortlisted: j.shortlisted || 0, interviewing: j.interviewing || 0,
      ...r,
    };
  }).filter(x => x.found || x.runs);
  // All platforms: the daily limit is every switched-on platform's limit added up.
  const allScope = !platform || platform === 'all';
  const allCap = allScope && raw
    ? PLATFORM_IDS.filter(id => isEnabled(siteOf(raw, id), id))
      .reduce((sumCap, id) => sumCap + (((siteOf(raw, id) || {}).apply || {}).maxPerDay || 0), 0)
    : 0;

  // ── applies per day, in the schedule's timezone ─────────────────────────
  const perDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY).toLocaleDateString('en-CA', { timeZone: tz });
    perDay.set(d, { day: d, applied: 0, skipped: 0, failed: 0 });
  }
  const reasons = new Map();
  for (const a of attempts) {
    const row = perDay.get(a.day);
    if (row) row[a.to]++;
    if (a.to === 'applied') continue;
    const key = reasonGroup(a.note);
    const r = reasons.get(key) || { key, label: REASON_LABELS[key], skipped: 0, failed: 0 };
    r[a.to]++;
    reasons.set(key, r);
  }

  // ── runs ────────────────────────────────────────────────────────────────
  const runRows = new Map();
  const ai = { asked: 0, answered: 0 };
  let autoApproved = 0, blocked = 0, lastBlockedAt = null;
  for (const r of runs) {
    const row = runRows.get(r.kind) || { kind: r.kind, total: 0, done: 0, failed: 0, blocked: 0, cancelled: 0, scheduled: 0 };
    row.total++;
    if (row[r.status] != null) row[r.status]++;
    if (r.trigger === 'scheduled') row.scheduled++;
    runRows.set(r.kind, row);
    const s = r.stats || {};
    ai.asked += s.aiAsked || 0;
    ai.answered += s.aiAnswered || 0;
    autoApproved += s.autoApproved || 0;
    if (r.status === 'blocked' || r.exitCode === 2) {
      blocked++;
      if (!lastBlockedAt || r.createdAt > lastBlockedAt) lastBlockedAt = r.createdAt;
    }
  }

  // ── answer bank and Needs answer drafts ─────────────────────────────────
  const drafts = { ready: 0, unknown: 0, error: 0, ignored: 0 };
  for (const d of (cfg && cfg.drafts) || []) if (drafts[d.status] != null) drafts[d.status]++;
  const answers = { you: 0, auto: 0 };
  for (const a of (cfg && cfg.answers) || []) answers[a.origin === 'auto' ? 'auto' : 'you']++;

  // ── tidy ────────────────────────────────────────────────────────────────
  const tidy = { stale: 0, 'low-fit': 0, 'company-site': 0, other: 0 };
  for (const r of f.tidy) {
    const hit = TIDY.find(([, re]) => re.test(r._id || ''));
    tidy[hit ? hit[0] : 'other'] += r.n;
  }

  const stageBy = Object.fromEntries(f.stages.map(r => [r._id, r.n]));
  const o = f.origins[0] || {};
  const hours = f.responseHours.map(r => r.h);

  return {
    days,
    timezone: tz,
    totals: {
      found: n('found'), scored: n('scored'), pending: n('pending'),
      approved: n('approved'), approvedAuto: n('approvedAuto'), rejected: n('rejected'), tidied: n('tidied'),
      waiting: n('waiting'), applied: n('applied'), appliedToday: n('appliedToday'),
      responded: n('responded'), shortlisted: n('shortlisted'), tracked: n('tracked'),
      interviewing: n('interviewing'), offer: n('offer'), employerRejected: n('employerRejected'),
      skipped: n('skipped'), failed: n('failed'), dismissed: n('dismissed'),
    },
    limits: {
      maxPerDay: allCap || apply.maxPerDay || 40,
      autoApproveEnabled: apply.autoApproveEnabled === true,
      autoApproveMinScore: apply.autoApproveMinScore != null ? apply.autoApproveMinScore : 80,
      tidyEnabled: !!(cfg && cfg.inboxTidy && cfg.inboxTidy.enabled),
    },
    scores: [...Array(10)].map((_, i) => {
      const r = f.scores.find(x => x._id === i * 10);
      return { from: i * 10, to: i === 9 ? 100 : i * 10 + 9, n: r ? r.n : 0, applied: r ? r.applied : 0 };
    }),
    unscored: (f.scores.find(x => x._id === null) || {}).n || 0,
    stages: [...STAGES, 'unknown'].map(s => ({ stage: s, n: stageBy[s] || 0 })),
    responseMedianHours: median(hours),
    perDay: [...perDay.values()],
    reasons: [...reasons.values()].sort((a, b) => (b.skipped + b.failed) - (a.skipped + a.failed) || a.key.localeCompare(b.key)),
    origins: {
      search: o.search || 0, recommended: o.recommended || 0,
      searchApplied: o.searchApplied || 0, recommendedApplied: o.recommendedApplied || 0,
    },
    queries: f.queries.map(q => ({ query: q._id, found: q.found, applied: q.applied, responded: q.responded })),
    runs: [...runRows.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind)),
    blocked: { runs: blocked, lastAt: lastBlockedAt },
    autoApproved,
    ai: { ...ai, drafts, answers },
    tidy,
    byPlatform,
  };
}

module.exports = { naukriAnalytics };
