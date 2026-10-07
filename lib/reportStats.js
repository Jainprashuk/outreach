/**
 * The numbers behind a report, for ONE account and ONE period.
 *
 * Shared by the Monday email, the in-app Reports card, the PDF and the preview
 * script, so every one of them shows the same figures. Every query is scoped with
 * an explicit `userId` (the codebase convention — never a plugin).
 *
 * Sends and replies are counted from Contact.statusHistory, like the Analytics
 * page (client/src/lib/analytics.ts), rather than from lastSentAt: a follow-up
 * overwrites lastSentAt, so the scalar undercounts first sends.
 */
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const SendJob = require('../models/SendJob');
const Lead = require('../models/Lead');
const NaukriJob = require('../models/NaukriJob');
const Interview = require('../models/Interview');
const { previousPeriod, istDateString, DAY_MS } = require('./reportPeriod');
const { NEEDS_YOU_FILTER, sortNeedsYou, effectiveReason } = require('./actionQueue');

const APPLIED = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];
const TERMINAL_INTERVIEW = ['selected', 'rejected'];
// Most actionable first, for "Top replies".
const CATEGORY_RANK = ['needs-attention', 'resume-requested', 'reviewing', 'stay-in-touch', 'other', 'no'];
const CATEGORY_LABELS = {
  'needs-attention': 'Needs attention', 'resume-requested': 'Resume requested', reviewing: 'Interested / reviewing',
  'stay-in-touch': 'Stay in touch', no: 'Not interested', other: 'Other', unclassified: 'Not yet sorted',
};

// Why an item is waiting on you, when that isn't simply its category.
const WAITING_LABELS = {
  'no-response': 'No reply in a week — follow up', reconnect: 'Time to reconnect',
  manual: 'Reopened by you', unclassified: 'Not yet sorted',
};

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** statusHistory events in the window, bucketed by status and IST day. */
async function contactEvents(userId, from, to) {
  const rows = await Contact.aggregate([
    { $match: { userId, deleted: { $ne: true }, statusHistory: { $elemMatch: { changedAt: { $gte: from, $lt: to } } } } },
    { $unwind: '$statusHistory' },
    { $match: { 'statusHistory.changedAt': { $gte: from, $lt: to } } },
    { $group: {
      _id: {
        s: '$statusHistory.status',
        d: { $dateToString: { format: '%Y-%m-%d', date: '$statusHistory.changedAt', timezone: 'Asia/Kolkata' } },
      },
      n: { $sum: 1 },
    } },
  ]);
  const by = (statuses) => rows.filter(r => statuses.includes(r._id.s)).reduce((a, r) => a + r.n, 0);
  const daily = new Map();
  for (const r of rows) {
    const day = daily.get(r._id.d) || { sent: 0, replies: 0 };
    if (r._id.s === 'sent' || r._id.s === 'follow-up-sent') day.sent += r.n;
    if (r._id.s === 'replied' || r._id.s === 'follow-up-replied') day.replies += r.n;
    daily.set(r._id.d, day);
  }
  return {
    firstSends: by(['sent']),
    followUps: by(['follow-up-sent']),
    sent: by(['sent', 'follow-up-sent']),
    replies: by(['replied', 'follow-up-replied']),
    bounced: by(['bounced']),
    failed: by(['failed']),
    daily,
  };
}

/** Only the headline numbers — what "vs previous period" is computed from. */
async function headline(userId, p) {
  const [ev, interviews] = await Promise.all([
    contactEvents(userId, p.from, p.to),
    Interview.countDocuments({ userId, deleted: { $ne: true }, interviewAt: { $gte: p.from, $lt: p.to } }),
  ]);
  return { sent: ev.sent, replies: ev.replies, replyRate: rate(ev.replies, ev.sent), interviews, _ev: ev };
}

function dailySeries(p, daily) {
  const out = [];
  for (let t = p.from.getTime(); t < p.to.getTime(); t += DAY_MS) {
    const day = istDateString(t);
    out.push({ day, ...(daily.get(day) || { sent: 0, replies: 0 }) });
  }
  // Past 14 days a daily chart is unreadable in a PDF: fold into weeks.
  if (out.length <= 14) return { unit: 'day', points: out };
  const weeks = [];
  for (let i = 0; i < out.length; i += 7) {
    const chunk = out.slice(i, i + 7);
    weeks.push({ day: chunk[0].day, sent: chunk.reduce((a, d) => a + d.sent, 0), replies: chunk.reduce((a, d) => a + d.replies, 0) });
  }
  return { unit: 'week', points: weeks };
}

/**
 * @param {string|ObjectId} userIdRaw
 * @param {{from: Date, to: Date, kind: string, days: number}} p
 * @param {{ now?: Date }} opts  `now` anchors the look-ahead ("this week").
 */
async function buildReportStats(userIdRaw, p, { now = new Date() } = {}) {
  const userId = oid(userIdRaw);
  const prev = previousPeriod(p);
  const ahead = new Date(now.getTime() + 7 * DAY_MS);

  const [cur, before, replyCats, topReplies, waitingCount, waitingList, jobs, campaigns,
    leadsAdded, leadsApplied, naukriApplied, interviewsNew, interviewMoves, upcoming] = await Promise.all([
    headline(userId, p),
    headline(userId, prev),
    Contact.aggregate([
      { $match: { userId, deleted: { $ne: true }, repliedAt: { $gte: p.from, $lt: p.to } } },
      { $group: { _id: { $ifNull: ['$replyCategory', 'unclassified'] }, n: { $sum: 1 } } },
    ]),
    Contact.find(
      { userId, deleted: { $ne: true }, repliedAt: { $gte: p.from, $lt: p.to } },
      { name: 1, company: 1, replyCategory: 1, repliedAt: 1 },
    ).sort({ repliedAt: -1 }).limit(50).lean(),
    // "Waiting on you" is the Mailbox's Needs you tab, as of `now` — the same filter, so
    // the email and the app never give two different numbers.
    Contact.countDocuments({ userId, deleted: { $ne: true }, ...NEEDS_YOU_FILTER(now) }),
    Contact.find(
      { userId, deleted: { $ne: true }, ...NEEDS_YOU_FILTER(now) },
      { name: 1, company: 1, replyCategory: 1, repliedAt: 1, action: 1 },
    ).lean(),
    // Emails actually SENT per campaign in the window (a release only queues).
    SendJob.aggregate([
      { $match: { userId, campaignId: { $ne: null }, updatedAt: { $gte: p.from } } },
      { $unwind: '$items' },
      { $match: { 'items.status': 'sent', 'items.processedAt': { $gte: p.from, $lt: p.to } } },
      { $group: { _id: '$campaignId', sent: { $sum: 1 } } },
    ]),
    Campaign.find(
      { userId, deleted: { $ne: true }, $or: [{ status: 'running' }, { completedAt: { $gte: p.from, $lt: p.to } }, { lastReleaseAt: { $gte: p.from, $lt: p.to } }] },
      { name: 1, status: 1, stats: 1, completedAt: 1 },
    ).lean(),
    Lead.countDocuments({ userId, deleted: { $ne: true }, createdAt: { $gte: p.from, $lt: p.to } }),
    Lead.countDocuments({ userId, deleted: { $ne: true }, applyStatus: { $in: APPLIED }, appliedAt: { $gte: p.from, $lt: p.to } }),
    NaukriJob.countDocuments({ userId, deleted: { $ne: true }, applyStatus: { $in: APPLIED }, appliedAt: { $gte: p.from, $lt: p.to } }),
    Interview.countDocuments({ userId, deleted: { $ne: true }, createdAt: { $gte: p.from, $lt: p.to } }),
    Interview.aggregate([
      { $match: { userId, deleted: { $ne: true }, statusHistory: { $elemMatch: { changedAt: { $gte: p.from, $lt: p.to } } } } },
      { $unwind: '$statusHistory' },
      { $match: { 'statusHistory.changedAt': { $gte: p.from, $lt: p.to } } },
      { $group: { _id: '$statusHistory.status', n: { $sum: 1 } } },
    ]),
    Interview.find(
      { userId, deleted: { $ne: true }, status: { $nin: TERMINAL_INTERVIEW }, interviewAt: { $gte: now, $lt: ahead } },
      { name: 1, company: 1, role: 1, round: 1, interviewAt: 1 },
    ).sort({ interviewAt: 1 }).limit(10).lean(),
  ]);

  const sentByCampaign = new Map(jobs.map(j => [String(j._id), j.sent]));
  const campaignRows = campaigns.map(c => ({
    name: c.name,
    status: c.status,
    sent: sentByCampaign.get(String(c._id)) || 0,
    remaining: (c.stats && c.stats.pending) || 0,
    finishedInPeriod: !!(c.completedAt && c.completedAt >= p.from && c.completedAt < p.to),
  })).sort((a, b) => b.sent - a.sent);

  const rank = (c) => { const i = CATEGORY_RANK.indexOf(c || ''); return i === -1 ? CATEGORY_RANK.length : i; };
  const top = [...topReplies]
    .sort((a, b) => rank(a.replyCategory) - rank(b.replyCategory) || b.repliedAt - a.repliedAt)
    .slice(0, 5)
    .map(c => ({ name: c.name || '', company: c.company || '', category: c.replyCategory || 'unclassified', repliedAt: c.repliedAt }));

  const change = (a, b) => ({ value: a, previous: b, delta: Math.round((a - b) * 10) / 10 });
  const ev = cur._ev;
  const pipeline = {
    leadsAdded, leadsApplied, naukriApplied, interviewsNew,
    interviewMoves: interviewMoves.map(r => ({ status: r._id, n: r.n })),
  };
  const quiet = ev.sent === 0 && ev.replies === 0 && ev.bounced === 0 && ev.failed === 0
    && leadsAdded === 0 && leadsApplied === 0 && naukriApplied === 0 && interviewsNew === 0
    && interviewMoves.length === 0 && cur.interviews === 0;

  return {
    period: { from: p.from, to: p.to, kind: p.kind, days: p.days },
    previous: { from: prev.from, to: prev.to },
    generatedAt: new Date(),
    quiet,
    headline: {
      sent: change(cur.sent, before.sent),
      replies: change(cur.replies, before.replies),
      replyRate: change(cur.replyRate, before.replyRate),
      interviews: change(cur.interviews, before.interviews),
    },
    outreach: { firstSends: ev.firstSends, followUps: ev.followUps, bounced: ev.bounced, failed: ev.failed },
    series: dailySeries(p, ev.daily),
    replyCategories: CATEGORY_RANK.concat('unclassified')
      .map(k => ({ key: k, label: CATEGORY_LABELS[k], n: (replyCats.find(r => r._id === k) || {}).n || 0 }))
      .filter(r => r.n > 0),
    campaigns: campaignRows,
    pipeline,
    topReplies: top.map(t => ({ ...t, categoryLabel: CATEGORY_LABELS[t.category] || t.category })),
    waiting: {
      count: waitingCount,
      items: sortNeedsYou(waitingList, now).slice(0, 5).map(c => ({
        name: c.name || '', company: c.company || '', category: c.replyCategory,
        categoryLabel: WAITING_LABELS[effectiveReason(c.action, now)] || CATEGORY_LABELS[c.replyCategory || 'unclassified'],
        repliedAt: c.repliedAt,
      })),
    },
    upcomingInterviews: upcoming.map(i => ({
      name: i.name || '', company: i.company || '', role: i.role || '', round: i.round || '', interviewAt: i.interviewAt,
    })),
  };
}

module.exports = { buildReportStats, contactEvents, CATEGORY_LABELS };
