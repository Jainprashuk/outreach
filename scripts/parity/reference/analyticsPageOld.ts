// Bundled by scripts/parity/analytics-summary.js. Everything the Outreach analytics
// page derived from the full contact download BEFORE it moved to the server
// (pages/Analytics.tsx at 240e3a5), copied verbatim — plus the new browser half
// (mergeActivity, interviewFunnel over the server's rows) to check end to end.
import {
  ACTIVITY_META, ACTIVITY_WINDOWS, analyze, buildActivityEvents, buildDailySeries,
  computeMetrics, countActivity, mergeActivity, STATUS_META,
} from '../../../client/src/lib/analytics';
import { indexInterviews, interviewFunnel } from '../../../client/src/lib/interviewAnalytics';

export { mergeActivity, interviewFunnel, indexInterviews };

export function oldPage(contacts: any[], interviews: any[]) {
  const A = contacts.map(analyze);
  const m = computeMetrics(A);
  const iv = interviewFunnel(contacts, indexInterviews(interviews), 'contact', (c: any) => c.email);

  // Status breakdown (both modes) and the "now" figure beside each.
  const statusCurrent = Object.entries(A.reduce<Record<string, number>>((acc, a) => { acc[a.c.status] = (acc[a.c.status] || 0) + 1; return acc; }, {}))
    .map(([s, n]) => ({ s, n }));
  statusCurrent.sort((a, b) => b.n - a.n);
  const statusEver = Object.keys(STATUS_META).map(s => ({ s, n: A.filter(a => a.ever.has(s)).length })).filter(r => r.n > 0);
  statusEver.sort((a, b) => b.n - a.n);
  const nowN = Object.fromEntries(Object.keys(STATUS_META).map(s => [s, A.filter(a => a.c.status === s).length]));

  // Reply journey
  const repliers = A.filter(a => a.everReplied);
  const journeyRows = Object.entries(repliers.reduce<Record<string, number>>((acc, a) => {
    acc[a.outcome] = (acc[a.outcome] || 0) + 1; return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  // Templates (before the page maps names and sorts by rate)
  const tplEntries = Object.entries(A.reduce<Record<string, { sent: number; replied: number }>>((acc, a) => {
    if (!a.everSent) return acc;
    const k = a.c.template || '—';
    acc[k] = acc[k] || { sent: 0, replied: 0 };
    acc[k].sent++;
    if (a.everReplied) acc[k].replied++;
    return acc;
  }, {}));

  // Companies
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const coRows = Object.entries(A.reduce<Record<string, { total: number; replied: number }>>((acc, a) => {
    const co = (a.c.company || '').trim(); if (!co) return acc;
    acc[co] = acc[co] || { total: 0, replied: 0 };
    acc[co].total++;
    if (a.everReplied) acc[co].replied++;
    return acc;
  }, {})).map(([co, v]) => ({ co, ...v, rate: pct(v.replied, v.total) }))
    .sort((a, b) => b.total - a.total).slice(0, 8);

  const series30 = buildDailySeries(A, 30);
  const series90 = buildDailySeries(A, 90);
  const allPairs = A.flatMap(a => a.pairs).sort((a, b) => a - b);

  // WeekdayChart
  const sends = [0, 0, 0, 0, 0, 0, 0], reps = [0, 0, 0, 0, 0, 0, 0];
  const idx = (t: number) => (new Date(t).getDay() + 6) % 7;
  A.forEach(a => {
    a.sends.forEach(s => sends[idx(s.t)]++);
    a.replies.forEach(r => reps[idx(r.t)]++);
  });

  // buildInsights' own inputs
  const wd = [0, 0, 0, 0, 0, 0, 0], hr = new Array(24).fill(0);
  A.forEach(a => a.replies.forEach(r => { const d = new Date(r.t); wd[d.getDay()]++; hr[d.getHours()]++; }));
  const now = Date.now(), wk = 7 * 86400000;
  const inWin = (t: number, from: number, to: number) => t >= from && t < to;
  let s1 = 0, s2 = 0, r1 = 0, r2 = 0;
  A.forEach(a => {
    a.sends.forEach(s => { if (inWin(s.t, now - wk, now)) s1++; else if (inWin(s.t, now - 2 * wk, now - wk)) s2++; });
    a.replies.forEach(r => { if (inWin(r.t, now - wk, now)) r1++; else if (inWin(r.t, now - 2 * wk, now - wk)) r2++; });
  });
  const adv = A.filter(a => a.everReplied && (a.ever.has('in-review') || a.ever.has('closed'))).length;
  const due = A.filter(a => (a.c.status === 'sent' || a.c.status === 'replied') && !a.c.followUpSentAt && a.c.lastSentAt && (now - new Date(a.c.lastSentAt).getTime()) > 3 * 86400000).length;

  // ActivitySection at `now`
  const events = buildActivityEvents(A, interviews);
  const known = new Set(ACTIVITY_META.map(mm => mm.type));
  const activity = ACTIVITY_WINDOWS.map(w => ({
    key: w.key,
    counts: countActivity(events, w.ms, now),
    feed: events.filter(e => !e.countOnly && e.t >= now - w.ms && e.t <= now && known.has(e.type)).slice(0, 40)
      .map(e => ({ t: e.t, type: e.type, id: e.c.id, name: e.c.name, company: e.c.company })),
  }));

  return {
    m, iv, statusCurrent, statusEver, nowN, journeyRows, tplEntries, coRows, series30, series90, allPairs,
    weekday: { sends, replies: reps }, wd, hr, week: { s1, s2, r1, r2 }, adv, due, activity,
  };
}
