const SendJob = require('../models/SendJob');
const Campaign = require('../models/Campaign');
const Notification = require('../models/Notification');
const Interview = require('../models/Interview');
const { TERMINAL_STATUSES } = Interview;
const { notify } = require('./notify');

const DAY_MS = 24 * 60 * 60 * 1000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const who = (r) => (r.name || r.email || 'Someone') + (r.company ? ` at ${r.company}` : '');
const names = (list) => {
  const shown = list.slice(0, 3).map(who).join(', ');
  return list.length > 3 ? `${shown} and ${list.length - 3} more` : shown;
};

/**
 * In-app notifications for what one mailbox scan found. `replied` / `bounced` are the
 * scan's own result arrays (server.js checkMailboxForUser). Keyed by the newest reply's
 * message-id, so an Inngest/cron retry of the same scan raises nothing twice while the
 * next scan, with different mail, does. Best-effort: never throws.
 */
async function notifyMailboxScan(userId, { replied = [], bounced = [], contacts = [] }) {
  try {
    if (replied.length) {
      const key = replied.map(r => r.messageId).filter(Boolean).sort().pop()
        || String(new Date(Math.max(...replied.map(r => +new Date(r.repliedAt)))).getTime());

      // S2 — one grouped note per scan.
      await notify(userId, {
        type: 'replies.new',
        title: replied.length === 1 ? '1 new reply' : `${replied.length} new replies`,
        body: names(replied),
        link: '/mailbox',
        dedupeKey: `replies.new:${userId}:${key}`,
      });

      // I1 — only the replies that actually wait on an answer.
      const needs = replied.filter(r => r.needsYou);
      if (needs.length === 1) {
        const r = needs[0];
        await notify(userId, {
          type: 'reply.needs_you',
          title: `${who(r)} is waiting for your reply`,
          body: r.snippet ? String(r.snippet).slice(0, 140) : '',
          link: '/mailbox',
          dedupeKey: `reply.needs_you:${r.contactId}:${r.messageId || new Date(r.repliedAt).getTime()}`,
        });
      } else if (needs.length > 1) {
        await notify(userId, {
          type: 'reply.needs_you',
          title: `${needs.length} replies need your answer`,
          body: names(needs),
          link: '/mailbox',
          dedupeKey: `reply.needs_you:${userId}:${key}`,
        });
      }

      // I3 — an unsubscribe / do-not-contact reply (classifier rule OTHER-2).
      for (const r of replied.filter(x => x.unsubscribed)) {
        await notify(userId, {
          type: 'contact.unsubscribed',
          title: `${who(r)} asked to stop receiving emails`,
          body: 'Their reply was filed as done. Consider adding them to your blocklist.',
          link: '/contacts',
          dedupeKey: `contact.unsubscribed:${r.contactId}`,
        });
      }
    }

    if (bounced.length) await notifyHighBounce(userId, contacts);
  } catch (err) {
    console.error('notifyMailboxScan failed:', err.message);
  }
}

/**
 * P8 — a bounce can't be tied to a job by message-id (the DSN carries only the address),
 * so after a scan that found new bounces, look at this user's jobs finished in the last
 * 3 days and count items whose contact is now bounced. A job with >= 5 sent and >= 10%
 * bounced qualifies, and is reported ONCE: jobs already named by an earlier notification
 * (meta.jobIds, or the old per-job key) are left out. Several new ones in one scan become
 * a single grouped notification, each batch named by its campaign or its send time.
 */
const istWhen = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

async function notifyHighBounce(userId, contacts) {
  const bouncedIds = new Set(contacts.filter(c => c.status === 'bounced').map(c => String(c._id)));
  if (!bouncedIds.size) return;
  const since = new Date(Date.now() - 3 * DAY_MS);
  const jobs = await SendJob.find(
    { userId, status: 'done', updatedAt: { $gte: since } },
    { campaignId: 1, createdAt: 1, 'items.contactId': 1, 'items.status': 1 },
  ).lean();

  const hits = [];
  for (const job of jobs) {
    const sent = (job.items || []).filter(i => i.status === 'sent');
    if (sent.length < 5) continue;
    const bad = sent.filter(i => bouncedIds.has(String(i.contactId))).length;
    const pct = Math.round((bad / sent.length) * 100);
    if (pct >= 10) hits.push({ job, sent: sent.length, bad, pct });
  }
  if (!hits.length) return;

  // Drop the jobs an earlier notification already covered.
  const earlier = await Notification.find(
    { userId, type: 'send.high_bounce', createdAt: { $gte: new Date(Date.now() - 5 * DAY_MS) } },
    { dedupeKey: 1, 'meta.jobIds': 1 },
  ).lean();
  const seen = new Set();
  for (const n of earlier) {
    (n.meta?.jobIds || []).forEach(id => seen.add(String(id)));
    const m = /^send\.high_bounce:([0-9a-f]{24})$/.exec(n.dedupeKey || '');
    if (m) seen.add(m[1]);
  }
  const fresh = hits.filter(h => !seen.has(String(h.job._id)));
  if (!fresh.length) return;

  const campaignIds = [...new Set(fresh.map(h => h.job.campaignId).filter(Boolean))];
  const names = new Map((await Campaign.find({ _id: { $in: campaignIds }, userId }, { name: 1 }).lean())
    .map(c => [String(c._id), c.name]));
  const label = (h) => (h.job.campaignId && names.get(String(h.job.campaignId)))
    ? `Campaign "${names.get(String(h.job.campaignId))}" (${istWhen(h.job.createdAt)})`
    : `Batch sent ${istWhen(h.job.createdAt)}`;

  fresh.sort((a, b) => b.pct - a.pct);
  const jobIds = fresh.map(h => String(h.job._id));
  if (fresh.length === 1) {
    const h = fresh[0];
    await notify(userId, {
      type: 'send.high_bounce',
      title: `${h.pct}% bounced — ${label(h)}`,
      body: `${h.bad} of ${h.sent} emails bounced. Check those addresses before sending more.`,
      link: h.job.campaignId ? `/campaigns/${h.job.campaignId}` : '/contacts?status=bounced',
      dedupeKey: `send.high_bounce:${h.job._id}`,
      meta: { jobIds },
    });
    return;
  }
  const shown = fresh.slice(0, 3).map(h => `${label(h)}: ${h.bad}/${h.sent} (${h.pct}%)`).join(' · ');
  await notify(userId, {
    type: 'send.high_bounce',
    title: `High bounce rate in ${fresh.length} recent batches`,
    body: fresh.length > 3 ? `${shown} · and ${fresh.length - 3} more` : shown,
    link: '/contacts?status=bounced',
    dedupeKey: `send.high_bounce:${jobIds.slice().sort().join(',')}`,
    meta: { jobIds },
  });
}

/**
 * P7 — interviews in the next 24h. Piggybacks on the 5-minute mailbox scan (the only
 * existing job that runs at least hourly for every user); deduped per interview per day.
 */
async function notifyInterviewsDue(userId) {
  try {
    const now = new Date();
    const rows = await Interview.find(
      {
        userId, deleted: { $ne: true }, status: { $nin: TERMINAL_STATUSES },
        interviewAt: { $gte: now, $lte: new Date(now.getTime() + DAY_MS) },
      },
      { name: 1, company: 1, interviewAt: 1 },
    ).lean();
    const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // yyyy-mm-dd
    for (const iv of rows) {
      const when = day(iv.interviewAt) === day(now) ? 'today' : 'tomorrow';
      await notify(userId, {
        type: 'interview.due',
        title: `Interview with ${iv.name} ${when}`,
        body: [iv.company, new Date(iv.interviewAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · '),
        link: '/interviews',
        dedupeKey: `interview.due:${iv._id}:${day(iv.interviewAt)}`,
      });
    }
  } catch (err) {
    console.error('notifyInterviewsDue failed:', err.message);
  }
}

module.exports = { notifyMailboxScan, notifyInterviewsDue };
