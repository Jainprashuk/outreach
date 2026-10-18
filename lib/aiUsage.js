// One account's own AI usage, for Settings → AI keys: calls by feature and outcome,
// tokens, whose key paid for them, and the last failure. Counts only — never a
// prompt or an answer. Reads AiCall (lib/aiCallLog.js), whose live rows expire
// after 30 days, so that is as far back as this can see.

const mongoose = require('mongoose');
const AiCall = require('../models/AiCall');

const DAY = 864e5;
const FEATURE_LABELS = {
  classify: 'Sorting replies', draft: 'Reply drafts', discover: 'Discover', sources: 'Lead sources', naukri: 'Naukri answers', other: 'Other',
};
const OUTCOME_LABELS = {
  ok: 'Worked', 'rate-limited': 'Hit the free limit', auth: 'Key rejected', transient: 'Provider busy',
  'bad-output': 'Unusable answer', aborted: 'Stopped',
};

async function aiUsage(userIdRaw, { days = 30, now = new Date() } = {}) {
  const userId = new mongoose.Types.ObjectId(String(userIdRaw));
  const since = new Date(now.getTime() - Math.min(30, days) * DAY);
  const match = { userId, createdAt: { $gte: since }, source: { $ne: 'history' } };
  const [[f]] = await Promise.all([AiCall.aggregate([
    { $match: match },
    { $facet: {
      t: [{ $group: {
        _id: null, calls: { $sum: 1 },
        ok: { $sum: { $cond: [{ $eq: ['$outcome', 'ok'] }, 1, 0] } },
        tokens: { $sum: { $ifNull: ['$tokens.total', 0] } },
        yours: { $sum: { $cond: [{ $eq: ['$keySource', 'user'] }, 1, 0] } },
        fallback: { $sum: { $cond: [{ $eq: ['$keySource', 'owner'] }, 1, 0] } },
      } }],
      features: [{ $group: {
        _id: '$feature', calls: { $sum: 1 },
        ok: { $sum: { $cond: [{ $eq: ['$outcome', 'ok'] }, 1, 0] } },
        tokens: { $sum: { $ifNull: ['$tokens.total', 0] } },
      } }, { $sort: { calls: -1, _id: 1 } }],
      outcomes: [{ $group: { _id: '$outcome', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }],
      providers: [{ $group: { _id: '$provider', calls: { $sum: 1 }, ok: { $sum: { $cond: [{ $eq: ['$outcome', 'ok'] }, 1, 0] } } } }, { $sort: { calls: -1, _id: 1 } }],
      lastFailure: [{ $match: { outcome: { $ne: 'ok' } } }, { $sort: { createdAt: -1 } }, { $limit: 1 },
        { $project: { _id: 0, at: '$createdAt', provider: 1, outcome: 1 } }],
    } },
  ])]);
  const t = f.t[0] || { calls: 0, ok: 0, tokens: 0, yours: 0, fallback: 0 };
  const last = f.lastFailure[0];
  return {
    days: Math.min(30, days),
    totals: { calls: t.calls, ok: t.ok, tokens: t.tokens, yourKey: t.yours, adminKey: t.fallback },
    features: f.features.map(r => ({ key: r._id || 'other', label: FEATURE_LABELS[r._id] || r._id || 'Other', calls: r.calls, ok: r.ok, tokens: r.tokens })),
    outcomes: f.outcomes.map(r => ({ key: r._id, label: OUTCOME_LABELS[r._id] || r._id, n: r.n })),
    providers: f.providers.map(r => ({ provider: r._id, calls: r.calls, ok: r.ok })),
    lastFailure: last ? { at: last.at, provider: last.provider, outcome: last.outcome, label: OUTCOME_LABELS[last.outcome] || last.outcome } : null,
  };
}

module.exports = { aiUsage };
