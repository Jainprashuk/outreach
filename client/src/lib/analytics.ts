// Port of the event-based analytics derivations from analytics.html.
// All metrics count what contacts EVER passed through (statusHistory), not just
// their current resting status.
import type { Contact } from './api';

export const STATUS_META: Record<string, { label: string; c: string }> = {
  queued: { label: 'Queued', c: '--blue' },
  sent: { label: 'Sent', c: '--green' },
  'follow-up-sent': { label: 'Follow-up Sent', c: '--amber' },
  replied: { label: 'Replied', c: '--teal' },
  'follow-up-replied': { label: 'Replied after Follow-up', c: '--teal' },
  bounced: { label: 'Bounced', c: '--red' },
  failed: { label: 'Failed', c: '--red' },
  closed: { label: 'Closed', c: '--slate' },
  'no-openings': { label: 'No Openings', c: '--purple' },
  'in-review': { label: 'In Review', c: '--indigo' },
};

export const EMAILED = new Set(['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'closed', 'no-openings', 'in-review']);

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
export const dayKey = (d: string | number | Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
export const fmtDur = (hrs: number) => {
  if (hrs < 1) return `${Math.max(1, Math.round(hrs * 60))} min`;
  if (hrs < 48) return `${Math.round(hrs * 10) / 10} hr${hrs >= 1.05 ? 's' : ''}`;
  return `${(hrs / 24).toFixed(1)} days`;
};

export interface Analyzed {
  c: Contact;
  ever: Set<string>;
  sends: Array<{ s: string; t: number }>;
  replies: Array<{ s: string; t: number }>;
  pairs: number[];
  everSent: boolean;
  everReplied: boolean;
  everFollowUp: boolean;
  everBounced: boolean;
  repliedAfterFu: boolean;
  outcome: string;
}

export function analyze(c: Contact): Analyzed {
  const hist = (c.statusHistory || [])
    .map(h => ({ s: h.status, t: new Date(h.changedAt).getTime() }))
    .filter(h => Number.isFinite(h.t)).sort((a, b) => a.t - b.t);
  const ever = new Set(hist.map(h => h.s)); ever.add(c.status);

  const sends = hist.filter(h => h.s === 'sent' || h.s === 'follow-up-sent');
  const replies = hist.filter(h => h.s === 'replied' || h.s === 'follow-up-replied');
  if (!sends.length && c.lastSentAt) sends.push({ s: 'sent', t: new Date(c.lastSentAt).getTime() });
  if (!replies.length && c.repliedAt) replies.push({ s: 'replied', t: new Date(c.repliedAt).getTime() });

  const fuSends = sends.filter(s => s.s === 'follow-up-sent');
  const firstFuT = fuSends.length ? fuSends[0].t : (c.followUpSentAt ? new Date(c.followUpSentAt).getTime() : null);

  // Pair each reply with the latest send before it; skip corrupt orderings, cap 90d.
  const pairs: number[] = [];
  replies.forEach(r => {
    let sendT: number | null = null;
    sends.forEach(s => { if (s.t <= r.t && (sendT === null || s.t > sendT)) sendT = s.t; });
    if (sendT !== null) {
      const hrs = (r.t - sendT) / 3600000;
      if (hrs >= 0 && hrs < 24 * 90) pairs.push(hrs);
    }
  });

  const firstReplyT = replies.length ? replies[0].t : null;
  const repliedAfterFu = ever.has('follow-up-replied') ||
    (firstFuT !== null && firstReplyT !== null && firstReplyT > firstFuT);

  return {
    c, ever, sends, replies, pairs,
    everSent: sends.length > 0 || EMAILED.has(c.status) || ever.has('sent'),
    everReplied: replies.length > 0,
    everFollowUp: firstFuT !== null || ever.has('follow-up-sent') || ever.has('follow-up-replied'),
    everBounced: ever.has('bounced'),
    repliedAfterFu,
    outcome: c.status,
  };
}

export interface Metrics {
  total: number; sentCount: number; repliedCount: number;
  fuCount: number; bouncedCount: number;
  afterFuCount: number; beforeFuCount: number;
  inReviewEver: number; closedEver: number; queuedNow: number;
  replyRate: number; bounceRate: number;
}

export function computeMetrics(A: Analyzed[]): Metrics {
  const sent = A.filter(a => a.everSent);
  const replied = A.filter(a => a.everReplied);
  const fu = A.filter(a => a.everFollowUp);
  const bounced = A.filter(a => a.everBounced);
  const afterFu = A.filter(a => a.repliedAfterFu);
  return {
    total: A.length,
    sentCount: sent.length,
    repliedCount: replied.length,
    fuCount: fu.length,
    bouncedCount: bounced.length,
    afterFuCount: afterFu.length,
    beforeFuCount: replied.length - afterFu.length,
    inReviewEver: A.filter(a => a.ever.has('in-review')).length,
    closedEver: A.filter(a => a.ever.has('closed')).length,
    queuedNow: A.filter(a => a.c.status === 'queued').length,
    replyRate: pct(replied.length, sent.length),
    bounceRate: pct(bounced.length, sent.length),
  };
}

export function buildDailySeries(A: Analyzed[], days: number) {
  const today = dayKey(Date.now());
  const start = today - (days - 1) * 86400000;
  const sent = new Map<number, number>(), rep = new Map<number, number>();
  A.forEach(a => {
    a.sends.forEach(s => { const k = dayKey(s.t); if (k >= start && k <= today) sent.set(k, (sent.get(k) || 0) + 1); });
    a.replies.forEach(r => { const k = dayKey(r.t); if (k >= start && k <= today) rep.set(k, (rep.get(k) || 0) + 1); });
  });
  const out: Array<{ day: number; sent: number; replied: number }> = [];
  for (let k = start; k <= today; k += 86400000) out.push({ day: k, sent: sent.get(k) || 0, replied: rep.get(k) || 0 });
  return out;
}

export const cvar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ── Recent activity ──────────────────────────────────────────────────────────
// Every dated thing that happened to a contact, flattened into one event stream
// so we can count "what happened in the last hour / 6h / day / week / month".

export const ACTIVITY_WINDOWS = [
  { key: '1h', label: '1 hour', ms: 3600000 },
  { key: '6h', label: '6 hours', ms: 6 * 3600000 },
  { key: '24h', label: '24 hours', ms: 24 * 3600000 },
  { key: '7d', label: '7 days', ms: 7 * 86400000 },
  { key: '30d', label: '30 days', ms: 30 * 86400000 },
] as const;

export type ActivityWindowKey = typeof ACTIVITY_WINDOWS[number]['key'];

// 'added' is synthetic (contact creation); the rest mirror contact statuses.
export const ACTIVITY_META: Array<{ type: string; label: string; c: string; icon: string; derived?: boolean }> = [
  { type: 'added', label: 'Contacts added', c: '--blue', icon: 'ti-user-plus' },
  { type: 'sent', label: 'Emails sent', c: '--green', icon: 'ti-send' },
  { type: 'delivered', label: 'Successfully delivered (no bounce)', c: '--green', icon: 'ti-mail-check', derived: true },
  { type: 'follow-up-sent', label: 'Follow-ups sent', c: '--amber', icon: 'ti-repeat' },
  { type: 'replied', label: 'Replies received', c: '--teal', icon: 'ti-message-reply' },
  { type: 'follow-up-replied', label: 'Replies after follow-up', c: '--teal', icon: 'ti-message-2-share' },
  { type: 'bounced', label: 'Bounced', c: '--red', icon: 'ti-mail-x' },
  { type: 'failed', label: 'Failed', c: '--red', icon: 'ti-alert-triangle' },
  { type: 'in-review', label: 'Moved to in review', c: '--indigo', icon: 'ti-eye' },
  { type: 'closed', label: 'Closed', c: '--slate', icon: 'ti-circle-check' },
  { type: 'no-openings', label: 'No openings', c: '--purple', icon: 'ti-door-off' },
  { type: 'queued', label: 'Queued for sending', c: '--blue', icon: 'ti-clock' },
];

export interface ActivityEvent {
  t: number; type: string; c: Contact; note?: string;
  /** Derived tally (e.g. `delivered`) — counted in the matrix, hidden from the event log. */
  countOnly?: boolean;
}

export function buildActivityEvents(A: Analyzed[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  A.forEach(a => {
    const c = a.c;
    const created = new Date(c.createdAt).getTime();
    if (Number.isFinite(created)) out.push({ t: created, type: 'added', c });

    const hist = (c.statusHistory || [])
      .map(h => ({ t: new Date(h.changedAt).getTime(), s: h.status, note: h.note }))
      .filter(h => Number.isFinite(h.t));

    if (hist.length) {
      hist.forEach(h => out.push({ t: h.t, type: h.s, c, note: h.note }));
    } else if (c.status !== 'queued') {
      // No history recorded (older contacts) — fall back to the timestamps we have.
      const fallback = c.status === 'replied' || c.status === 'follow-up-replied'
        ? c.repliedAt
        : c.status === 'follow-up-sent' ? c.followUpSentAt : (c.lastSentAt || c.updatedAt);
      const t = new Date(fallback || c.updatedAt).getTime();
      if (Number.isFinite(t)) out.push({ t, type: c.status, c });
    }

    // Every send that never came back as a bounce counts as delivered. Bounces
    // land minutes-to-hours later, so a very recent send can still flip.
    if (!a.everBounced) {
      a.sends.forEach(s => out.push({ t: s.t, type: 'delivered', c, countOnly: true }));
    }
  });
  return out.sort((x, y) => y.t - x.t);
}

/** Counts per activity type inside `ms` before `now` (only known types are kept). */
export function countActivity(events: ActivityEvent[], ms: number, now = Date.now()) {
  const from = now - ms;
  const counts: Record<string, number> = {};
  ACTIVITY_META.forEach(m => { counts[m.type] = 0; });
  events.forEach(e => {
    if (e.t >= from && e.t <= now && e.type in counts) counts[e.type]++;
  });
  return counts;
}

export const fmtAgo = (t: number, now = Date.now()) => {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
