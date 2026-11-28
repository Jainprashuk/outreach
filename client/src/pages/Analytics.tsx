import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { Card, HBar } from '../components/AnalyticsCards';
import LeadsAnalytics from '../components/LeadsAnalytics';
import DiscoverAnalytics from '../components/DiscoverAnalytics';
import NaukriAnalytics from '../components/NaukriAnalytics';
import ReportsPanel from '../components/ReportsPanel';
import AdminUserAnalytics from '../components/AdminUserAnalytics';
import { useSession } from '../context/SessionContext';
import { Skeleton } from '../components/Skeleton';
import { CampaignsCard, NeedsYouCard } from '../components/OutreachExtraCards';
import OverviewSection, { type AnSec } from '../components/analytics/OverviewSection';
import InterviewsSection from '../components/analytics/InterviewsSection';
import { CATEGORY_LABELS } from '../lib/format';
import '../styles/admin-redesign.css';
import '../styles/analytics-redesign.css';
import { useInterviews } from '../context/InterviewContext';
import {
  EMPTY_FUNNEL, indexInterviews, interviewFunnel, type InterviewFunnel,
} from '../lib/interviewAnalytics';
import {
  ACTIVITY_META, ACTIVITY_WINDOWS, cvar, fmtAgo, fmtDur, mergeActivity, pct,
  STATUS_META, type ActivityWindowKey, type Metrics,
} from '../lib/analytics';
import {
  adminOverviewApi, loadAnalyticsActivityApi, loadAnalyticsSummaryApi,
  type AnalyticsActivity, type AnalyticsSummary, type Interview,
} from '../lib/api';

// ── Time-series chart (2-series, hover crosshair) ────────────────────────────
const TS = { W: 720, H: 210, padL: 32, padR: 12, padT: 12, padB: 26 };

function TimeSeriesChart({ series }: { series: Array<{ day: number; sent: number; replied: number }> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const c1 = cvar('--chart-1') || '#4f46e5';
  const c2 = cvar('--chart-2') || '#0d9488';
  const { W, H, padL, padR, padT, padB } = TS;
  const cW = W - padL - padR, cH = H - padT - padB;
  const n = series.length;
  const maxV = Math.max(1, ...series.map(d => Math.max(d.sent, d.replied)));
  const x = (i: number) => padL + (n <= 1 ? cW / 2 : (i / (n - 1)) * cW);
  const y = (v: number) => padT + cH - (v / maxV) * cH;
  const fmtDay = (k: number) => new Date(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const line = (key: 'sent' | 'replied') => series.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = (key: 'sent' | 'replied') =>
    `M${x(0).toFixed(1)},${(padT + cH).toFixed(1)} ` +
    series.map((d, i) => `L${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ') +
    ` L${x(n - 1).toFixed(1)},${(padT + cH).toFixed(1)} Z`;

  const onMove = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (W / r.width);
    let i = Math.round((sx - padL) / (cW / (n - 1 || 1)));
    i = Math.max(0, Math.min(n - 1, i));
    setHover({ i, x: e.clientX, y: e.clientY });
  };

  const ticks = Math.min(n, 5);
  const hd = hover ? series[hover.i] : null;

  return (
    <>
      <svg ref={svgRef} className="an-ts" width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c1} stopOpacity={0.22} /><stop offset="100%" stopColor={c1} stopOpacity={0} /></linearGradient>
          <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c2} stopOpacity={0.2} /><stop offset="100%" stopColor={c2} stopOpacity={0} /></linearGradient>
        </defs>
        {[0, 0.5, 1].map(f => {
          const yy = padT + cH * (1 - f);
          return (
            <g key={f}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} style={{ stroke: 'var(--chart-grid)', strokeWidth: 1 }} />
              <text x={padL - 6} y={yy + 3.5} textAnchor="end" style={{ fontSize: 9, fill: 'var(--text3)' }}>{Math.round(maxV * f)}</text>
            </g>
          );
        })}
        <path d={area('sent')} fill="url(#g1)" />
        <path d={area('replied')} fill="url(#g2)" />
        <path d={line('sent')} fill="none" stroke={c1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={line('replied')} fill="none" stroke={c2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {Array.from({ length: ticks }, (_, t) => {
          const i = Math.round(t * (n - 1) / (ticks - 1 || 1));
          return <text key={t} x={x(i)} y={H - 6} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text3)' }}>{fmtDay(series[i].day)}</text>;
        })}
        {hover && hd && (
          <g>
            <line x1={x(hover.i)} y1={padT} x2={x(hover.i)} y2={padT + cH} style={{ stroke: 'var(--border-md)', strokeWidth: 1 }} />
            <circle cx={x(hover.i)} cy={y(hd.sent)} r={4} fill={c1} stroke="var(--bg)" strokeWidth={2} />
            <circle cx={x(hover.i)} cy={y(hd.replied)} r={4} fill={c2} stroke="var(--bg)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover && hd && createPortal(
        <div id="chart-tooltip" style={{ display: 'block', left: Math.max(4, Math.min(window.innerWidth - 164, hover.x - 80)), top: hover.y - 90 }}>
          <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 5 }}>
            {new Date(hd.day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: c1 }} />Sends <b style={{ marginLeft: 'auto' }}>{hd.sent}</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: c2 }} />Replies <b style={{ marginLeft: 'auto' }}>{hd.replied}</b>
          </div>
        </div>,
        document.body,
      )}
      <div className="an-legend">
        <span className="lg"><span className="sw" style={{ background: c1 }} />Send events (incl. follow-ups)</span>
        <span className="lg"><span className="sw" style={{ background: c2 }} />Replies received</span>
      </div>
    </>
  );
}

// ── Response-speed histogram ─────────────────────────────────────────────────
function ReplyTimeChart({ pairs }: { pairs: number[] }) {
  if (!pairs.length) return <div className="an-empty"><i className="ti ti-clock-off" />No measurable replies yet</div>;
  const accent = cvar('--accent') || '#4f46e5';
  const buckets = [
    { label: '< 1h', min: 0, max: 1 }, { label: '1–6h', min: 1, max: 6 },
    { label: '6–24h', min: 6, max: 24 }, { label: '1–3d', min: 24, max: 72 },
    { label: '3–7d', min: 72, max: 168 }, { label: '> 7d', min: 168, max: Infinity },
  ].map(b => ({ ...b, n: pairs.filter(h => h >= b.min && h < b.max).length }));

  const W = 340, H = 190, padL = 8, padR = 8, padT = 16, padB = 26;
  const cW = W - padL - padR, cH = H - padT - padB;
  const maxV = Math.max(1, ...buckets.map(b => b.n));
  const slot = cW / buckets.length, bw = slot * 0.62;

  return (
    <svg width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}>
      {buckets.map((b, i) => {
        const h = b.n > 0 ? Math.max(3, (b.n / maxV) * cH) : 2;
        const bx = padL + i * slot + (slot - bw) / 2, by = padT + cH - h;
        return (
          <g key={b.label}>
            <rect x={bx} y={by} width={bw} height={h} rx={4} style={{ fill: accent, opacity: b.n ? 0.85 : 0.15 }} />
            {b.n > 0 && <text x={bx + bw / 2} y={by - 5} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: 'var(--text)' }}>{b.n}</text>}
            <text x={bx + bw / 2} y={H - 8} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text3)' }}>{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Weekly rhythm ────────────────────────────────────────────────────────────
// Sends and replies per weekday, Monday first (counted on the server, in your timezone).
function WeekdayChart({ sends, reps }: { sends: number[]; reps: number[] }) {
  const c1 = cvar('--chart-1') || '#4f46e5';
  const c2 = cvar('--chart-2') || '#0d9488';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const maxS = Math.max(1, ...sends), maxR = Math.max(1, ...reps);
  const W = 340, H = 190, padL = 8, padR = 8, padT = 16, padB = 26;
  const cW = W - padL - padR, cH = H - padT - padB;
  const slot = cW / 7, bw = slot * 0.3;

  return (
    <>
      <svg width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}>
        {days.map((d, i) => {
          const hS = sends[i] > 0 ? Math.max(3, (sends[i] / maxS) * cH) : 2;
          const hR = reps[i] > 0 ? Math.max(3, (reps[i] / maxR) * cH) : 2;
          const x0 = padL + i * slot + (slot - bw * 2 - 2) / 2;
          return (
            <g key={d}>
              <rect x={x0} y={padT + cH - hS} width={bw} height={hS} rx={3} style={{ fill: c1, opacity: sends[i] ? 0.85 : 0.15 }} />
              <rect x={x0 + bw + 2} y={padT + cH - hR} width={bw} height={hR} rx={3} style={{ fill: c2, opacity: reps[i] ? 0.85 : 0.15 }} />
              {reps[i] > 0 && <text x={x0 + bw + 2 + bw / 2} y={padT + cH - hR - 4} textAnchor="middle" style={{ fontSize: 9, fontWeight: 600, fill: 'var(--text)' }}>{reps[i]}</text>}
              <text x={padL + i * slot + slot / 2} y={H - 8} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text3)' }}>{d}</text>
            </g>
          );
        })}
      </svg>
      <div className="an-legend">
        <span className="lg"><span className="sw" style={{ background: c1 }} />Sends (scaled to own max)</span>
        <span className="lg"><span className="sw" style={{ background: c2 }} />Replies (labeled)</span>
      </div>
    </>
  );
}

// ── Recent activity (counts per event type across time windows) ──────────────
function ActivitySection({ initial, interviews }: { initial: AnalyticsActivity; interviews: Interview[] }) {
  const [activity, setActivity] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [win, setWin] = useState<ActivityWindowKey>('24h');
  useEffect(() => { setActivity(initial); }, [initial]);

  // Windows are relative to "now", so keep it ticking while the page is open: the
  // contact side is counted on the server, so each tick asks it again (not while hidden).
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadAnalyticsActivityApi()
        .then(a => { setActivity(a); setNow(Date.now()); })
        .catch(() => setNow(Date.now()));
    }, 60000);
    return () => clearInterval(id);
  }, []);

  const cols = useMemo(() => mergeActivity(activity, interviews, now), [activity, interviews, now]);

  const activeWin = ACTIVITY_WINDOWS.find(w => w.key === win)!;
  const feed = cols.find(c => c.key === win)!.feed;

  const rows = ACTIVITY_META.filter(m => cols.some(col => col.counts[m.type] > 0));
  const totalIn = (key: ActivityWindowKey) => {
    const col = cols.find(c => c.key === key)!;
    return ACTIVITY_META.reduce((s, m) => s + (m.derived ? 0 : col.counts[m.type]), 0);
  };
  const label = (type: string) => ACTIVITY_META.find(m => m.type === type)!;

  return (
    <div className="an-card" style={{ marginBottom: 14, animationDelay: '.02s' }}>
      <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="an-card-title"><i className="ti ti-activity" /> Recent activity</div>
          <div className="an-card-sub">
            What happened in the last hour, 6 hours, day, week and month — added, sent, replied, bounced,
            every other status change, and every move in the interview pipeline
          </div>
        </div>
        <div className="seg-toggle">
          {ACTIVITY_WINDOWS.map(w => (
            <button key={w.key} className={`btn btn-xs${win === w.key ? ' active' : ''}`}
              onClick={() => setWin(w.key)} type="button" title={`Show the feed for the last ${w.label}`}>
              {w.key}
            </button>
          ))}
        </div>
      </div>

      <div className="an-card-body">
        {/* Window summary tiles */}
        <div className="stat-grid" style={{ padding: 0, marginBottom: 14 }}>
          {cols.map(col => (
            <div className="stat-card" key={col.key} style={{ cursor: 'pointer', outline: win === col.key ? '1.5px solid var(--accent)' : undefined }}
              onClick={() => setWin(col.key)}>
              <div className="stat-label">Last {col.label}</div>
              <div className="kpi-value stat-value">{totalIn(col.key).toLocaleString()}</div>
              <div className="stat-sub">
                {col.counts.added} added · {col.counts.sent + col.counts['follow-up-sent']} sent · {col.counts.delivered} delivered · {col.counts.replied + col.counts['follow-up-replied']} replied
              </div>
            </div>
          ))}
        </div>

        {/* Full matrix: event type × window */}
        <div style={{ overflowX: 'auto' }}>
          <table className="an-table">
            <thead>
              <tr>
                <th>Activity</th>
                {ACTIVITY_WINDOWS.map(w => (
                  <th key={w.key} className="num" style={win === w.key ? { color: 'var(--text)' } : undefined}>{w.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={ACTIVITY_WINDOWS.length + 1}><div className="an-empty"><i className="ti ti-zzz" />No activity in the last 30 days</div></td></tr>
              ) : rows.map(m => (
                <tr key={m.type}>
                  <td style={{ fontWeight: 500 }}>
                    <span className="dot" style={{ background: cvar(m.c), marginRight: 7 }} />{m.label}
                  </td>
                  {cols.map(col => (
                    <td key={col.key} className="num"
                      style={{ color: col.counts[m.type] ? 'var(--text)' : 'var(--text3)', fontWeight: win === col.key && col.counts[m.type] ? 600 : 400 }}>
                      {col.counts[m.type] || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Event feed for the selected window */}
        <div style={{ marginTop: 16 }}>
          <div className="an-card-sub" style={{ marginBottom: 8 }}>
            Event log — last {activeWin.label}{feed.length === 40 ? ' (most recent 40)' : ''}
          </div>
          {feed.length === 0 ? (
            <div className="an-empty"><i className="ti ti-history-off" />Nothing happened in the last {activeWin.label}</div>
          ) : (
            <div className="activity-feed">
              {feed.map((e, i) => {
                const meta = label(e.type);
                return (
                  <div className="af-row" key={`${e.c.id}-${e.type}-${e.t}-${i}`}>
                    <i className={`ti ${meta.icon}`} style={{ color: cvar(meta.c) }} />
                    <span className="af-what">{meta.label}</span>
                    <span className="af-who">{e.c.name}{e.c.company ? ` · ${e.c.company}` : ''}</span>
                    <span className="af-when">{fmtAgo(e.t, now)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Insights builder (pure port of renderInsights) ───────────────────────────
interface Insight { i: string; c: string; t: string; x: React.ReactNode; }

function buildInsights(
  S: AnalyticsSummary, m: Metrics, templates: Record<string, { name: string }>, iv: InterviewFunnel,
): Insight[] {
  const items: Insight[] = [];

  const ranked = S.templates.map(([k, v]) => [k, { s: v.sent, r: v.replied }] as const).filter(([, v]) => v.s >= 20)
    .map(([k, v]) => ({ name: templates[k]?.name || k, rate: pct(v.r, v.s), s: v.s }))
    .sort((a, b) => b.rate - a.rate);
  if (ranked.length >= 2) {
    items.push({ i: 'ti-trophy', c: '--green', t: 'Best template',
      x: <><b>{ranked[0].name}</b> ({ranked[0].rate}%) out-performs <b>{ranked[ranked.length - 1].name}</b> ({ranked[ranked.length - 1].rate}%) — consider shifting volume to it.</> });
  } else if (ranked.length === 1) {
    items.push({ i: 'ti-trophy', c: '--green', t: 'Template baseline', x: <><b>{ranked[0].name}</b> converts at {ranked[0].rate}% over {ranked[0].s} sends.</> });
  }

  const allPairs = [...S.pairs].sort((a, b) => a - b);
  if (allPairs.length >= 5) {
    const med = allPairs[Math.floor(allPairs.length / 2)];
    const within24 = pct(allPairs.filter(h => h <= 24).length, allPairs.length);
    items.push({ i: 'ti-clock-bolt', c: '--indigo', t: 'Response speed',
      x: <>Median reply lands in <b>{fmtDur(med)}</b>; {within24}% arrive within 24 hours. If no reply after ~3 days, it likely isn't coming — follow up then.</> });
  }

  const wd = S.replyWd, hr = S.replyHr;
  const wdMax = Math.max(...wd);
  if (wdMax > 2) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const hMax = hr.indexOf(Math.max(...hr));
    const hLabel = `${((hMax + 11) % 12) + 1}${hMax < 12 ? 'am' : 'pm'}`;
    items.push({ i: 'ti-calendar-star', c: '--amber', t: 'When replies come',
      x: <><b>{names[wd.indexOf(wdMax)]}</b> is your biggest reply day, peaking around <b>{hLabel}</b>. Time sends so you land near the top of inboxes.</> });
  }

  if (m.fuCount >= 10) {
    const share = m.repliedCount ? pct(m.afterFuCount, m.repliedCount) : 0;
    items.push({ i: 'ti-repeat', c: '--teal', t: 'Follow-up impact',
      x: <>Follow-ups recovered <b>{m.afterFuCount}</b> replies ({share}% of all replies) that the first email didn't get. Reply rate on follow-ups: {pct(m.afterFuCount, m.fuCount)}%.</> });
  }

  if (m.sentCount >= 50) {
    const level = m.bounceRate > 20 ? 'critical' : m.bounceRate > 10 ? 'high' : 'healthy';
    items.push({
      i: level === 'healthy' ? 'ti-shield-check' : 'ti-alert-triangle',
      c: level === 'healthy' ? '--green' : '--red', t: 'List quality',
      x: level === 'healthy'
        ? <>Bounce rate is <b>{m.bounceRate}%</b> — your list quality is fine.</>
        : <>Bounce rate is <b>{m.bounceRate}%</b> ({m.bouncedCount} addresses) — that's {level}. Verify emails before sending; high bounces hurt Gmail deliverability for ALL your mail.</>,
    });
  }

  // What the classifier made of the replies — automatic, unlike the In review /
  // Closed statuses, which only move when you set them by hand.
  const types = S.replyTypes || [];
  const classified = types.filter(r => r.k !== 'unclassified').reduce((n, r) => n + r.n, 0);
  if (classified >= 5) {
    const interested = types.filter(r => r.k === 'reviewing' || r.k === 'resume-requested').reduce((n, r) => n + r.n, 0);
    const no = types.find(r => r.k === 'no')?.n || 0;
    items.push({ i: 'ti-messages', c: interested ? '--green' : '--indigo', t: 'What replies say',
      x: <><b>{interested}</b> of {classified} classified replies ({pct(interested, classified)}%) show interest — reviewing your profile or asking for a resume; {no} said no.</> });
  }

  // The interview store is the only place that knows a reply turned into a real
  // conversation, so this is the one conversion number the status history can't give.
  if (iv.tracked > 0) {
    items.push({
      i: iv.selected > 0 ? 'ti-confetti' : 'ti-user-check',
      c: iv.selected > 0 ? '--green' : '--indigo',
      t: 'Reply \u2192 interview conversion',
      x: <>
        <b>{iv.tracked}</b> contact{iv.tracked !== 1 ? 's' : ''}{m.repliedCount > 0 ? <> of your {m.repliedCount} repliers ({pct(iv.tracked, m.repliedCount)}%)</> : null}{' '}
        reached the interview stage; <b>{iv.interviewed}</b> got a booked round.{' '}
        {iv.selected > 0 ? <><b>{iv.selected}</b> selected. </> : null}
        {iv.live > 0
          ? <>{iv.live} still in play{iv.upcoming > 0 ? <>, {iv.upcoming} with a date on the calendar</> : ' with no date booked yet'}.</>
          : 'Nothing is still in play.'}
      </>,
    });
  } else if (m.repliedCount >= 3) {
    items.push({ i: 'ti-user-off', c: '--amber', t: 'No interviews tracked',
      x: <>{m.repliedCount} contacts have replied but none are tracked in Interviews — flag the real conversations there so this page can measure what replies actually turn into.</> });
  }

  const verdict = m.replyRate >= 15 ? 'well above' : m.replyRate >= 5 ? 'around' : 'below';
  items.push({ i: 'ti-gauge', c: m.replyRate >= 5 ? '--green' : '--red', t: 'Overall reply rate',
    x: <><b>{m.replyRate}%</b> of emailed contacts have ever replied — {verdict} the ~5% cold-email benchmark.{m.replyRate < 5 ? ' Tighter targeting and shorter emails usually move this most.' : ''}</> });

  return items;
}

// Before the first load: every figure zero (the page shows skeletons until then).
const EMPTY_ACTIVITY: AnalyticsActivity = { now: 0, counts: {}, feeds: {} };
const EMPTY_SUMMARY: AnalyticsSummary = {
  now: 0, tz: 'UTC',
  metrics: { total: 0, sentCount: 0, repliedCount: 0, fuCount: 0, bouncedCount: 0, afterFuCount: 0,
    beforeFuCount: 0, inReviewEver: 0, closedEver: 0, queuedNow: 0, inCampaignNow: 0, replyRate: 0, bounceRate: 0 },
  statusCurrent: [], statusEver: [], journey: [], templates: [], companies: [], pairs: [],
  series: { 30: [], 90: [] }, weekday: { sends: [0, 0, 0, 0, 0, 0, 0], replies: [0, 0, 0, 0, 0, 0, 0] },
  replyWd: [0, 0, 0, 0, 0, 0, 0], replyHr: new Array(24).fill(0), week: { s1: 0, s2: 0, r1: 0, r2: 0 },
  adv: 0, due: 0, interviewRows: [], activity: EMPTY_ACTIVITY,
};

// ── Replies by hour ──────────────────────────────────────────────────────────
function HourChart({ hours }: { hours: number[] }) {
  const accent = cvar('--chart-2') || '#0d9488';
  const W = 340, H = 150, padL = 8, padR = 8, padT = 14, padB = 22;
  const cW = W - padL - padR, cH = H - padT - padB;
  const maxV = Math.max(1, ...hours);
  const slot = cW / 24, bw = slot * 0.7;
  if (!hours.some(Boolean)) return <div className="an-empty"><i className="ti ti-clock-off" />No replies yet</div>;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}
      role="img" aria-label="Replies by hour of day">
      {hours.map((n, h) => {
        const bh = n ? Math.max(3, (n / maxV) * cH) : 2;
        return (
          <g key={h}>
            <rect x={padL + h * slot + (slot - bw) / 2} y={padT + cH - bh} width={bw} height={bh} rx={2}
              style={{ fill: accent, opacity: n ? 0.85 : 0.15 }}><title>{`${h}:00 — ${n} repl${n === 1 ? 'y' : 'ies'}`}</title></rect>
            {h % 6 === 0 && <text x={padL + h * slot + slot / 2} y={H - 6} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text3)' }}>
              {h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────
type Sec = AnSec;
const SECS: Sec[] = ['overview', 'outreach', 'replies', 'activity', 'interviews', 'naukri', 'leads', 'discover', 'reports'];
const NAV: Array<{ group: string; items: Array<{ id: Sec; icon: string; label: string }> }> = [
  { group: 'Home', items: [{ id: 'overview', icon: 'ti-layout-dashboard', label: 'Overview' }] },
  { group: 'Email outreach', items: [
    { id: 'outreach', icon: 'ti-send', label: 'Outreach' },
    { id: 'replies', icon: 'ti-message-reply', label: 'Replies' },
    { id: 'activity', icon: 'ti-activity', label: 'Activity log' },
  ] },
  { group: 'Pipeline', items: [
    { id: 'interviews', icon: 'ti-user-check', label: 'Interviews' },
    { id: 'naukri', icon: 'ti-briefcase', label: 'Job platforms' },
    { id: 'leads', icon: 'ti-target-arrow', label: 'Leads' },
    { id: 'discover', icon: 'ti-compass', label: 'Discover' },
  ] },
  { group: 'Share', items: [{ id: 'reports', icon: 'ti-file-analytics', label: 'Reports' }] },
];
const SUBTITLE: Record<Sec, string> = {
  overview: 'Your whole search at a glance: what is waiting on you, and how each part is doing.',
  outreach: 'Who you emailed, how far they got, and which templates and companies work.',
  replies: 'What replies say, how fast they come, and when.',
  activity: 'Everything that happened in the last hour, day, week and month.',
  interviews: 'Every interview you track — from contacts, leads or added by hand.',
  naukri: 'Job platforms: what was applied to, why the rest stopped, and what recruiters did.',
  leads: 'Your staged lead pipeline, before it becomes outreach.',
  discover: 'People found with Discover, and how their guessed emails performed.',
  reports: 'Reports for any period — on screen, as a PDF, or emailed to you.',
};
// Sections built from the contact summary (the rest load their own data).
const USES_SUMMARY: Sec[] = ['overview', 'outreach', 'replies', 'activity', 'interviews'];
const secOf = (v: string | null): Sec => (SECS.includes(v as Sec) ? v as Sec : 'overview');

export default function Analytics() {
  const app = useApp();
  const toast = useToast();
  const { interviews, loaded: interviewsLoaded } = useInterviews();
  // ?view=reports is where the Monday email's "View in the app" button lands.
  const [search, setSearch] = useSearchParams();
  // Admins only: ?user=<id> shows another account's analytics, numbers only.
  const { isAdmin, user: me } = useSession();
  const viewUser = isAdmin ? search.get('user') : null;
  const [accounts, setAccounts] = useState<Array<{ id: string; email: string; status: string }>>([]);
  useEffect(() => {
    if (!isAdmin) return;
    adminOverviewApi(30)
      .then(o => setAccounts(o.users.filter(u => u.id).map(u => ({ id: u.id as string, email: u.email, status: u.status }))))
      .catch(() => {});
  }, [isAdmin]);
  const pickUser = (id: string) => {
    const next = new URLSearchParams(search);
    if (id) next.set('user', id); else next.delete('user');
    setSearch(next, { replace: true });
  };

  // The section lives in ?view=, so a link or a reload lands on it.
  const view = secOf(search.get('view'));
  const go = (s: Sec) => {
    const next = new URLSearchParams(search);
    if (s === 'overview') next.delete('view'); else next.set('view', s);
    setSearch(next, { replace: true });
    window.scrollTo({ top: 0 });
  };

  const [refreshToken, setRefreshToken] = useState(0);
  const [range, setRange] = useState(30);
  const [statusMode, setStatusMode] = useState<'current' | 'ever'>('current');
  const [refreshing, setRefreshing] = useState(false);
  // Everything derived from contacts, computed on the server
  // (GET /api/contacts/analytics-summary) — the contacts themselves never come down.
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);

  const loadSummary = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadAnalyticsSummaryApi().then(setSummary), app.loadTemplates()]);
    } catch (err: any) {
      toast('Could not load analytics: ' + err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };
  const refresh = () => {
    setRefreshToken(n => n + 1);
    if (USES_SUMMARY.includes(view)) loadSummary();
  };
  // First time a summary-based section is shown, wherever the page opened.
  useEffect(() => { if (!viewUser && USES_SUMMARY.includes(view) && !summary && !refreshing) loadSummary(); }, [view, viewUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const S = summary ?? EMPTY_SUMMARY;
  const m = S.metrics;
  // Interviews live in their own store keyed on (sourceType, sourceId), so the
  // join has to happen here — no contact field records that someone interviewed.
  const iv = useMemo(
    () => (interviewsLoaded ? interviewFunnel(S.interviewRows, indexInterviews(interviews), 'contact', c => c.email) : EMPTY_FUNNEL),
    [S, interviews, interviewsLoaded],
  );
  const insights = useMemo(() => buildInsights(S, m, app.templates, iv), [S, m, app.templates, iv]);
  const sortedPairs = S.pairs;
  const median = sortedPairs.length ? sortedPairs[Math.floor(sortedPairs.length / 2)] : null;
  const within24 = sortedPairs.length ? pct(sortedPairs.filter(h => h <= 24).length, sortedPairs.length) : 0;

  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const amber = cvar('--amber') || '#8a5c00';

  const picker = isAdmin && accounts.length > 0 && (
    <select value={viewUser || ''} onChange={e => pickUser(e.target.value)} aria-label="Whose analytics" style={{ maxWidth: 260 }}>
      <option value="">My analytics</option>
      {accounts.filter(a => a.id !== me?.id).map(a => (
        <option key={a.id} value={a.id}>{a.email}{a.status !== 'active' ? ` (${a.status})` : ''}</option>
      ))}
    </select>
  );

  if (viewUser) {
    const who = accounts.find(a => a.id === viewUser);
    return (
      <Layout title="Analytics" subtitle={`${who ? who.email : 'Another account'} — numbers only`} actions={picker || undefined}>
        <div className="info-box" style={{ marginBottom: 14 }}>
          <i className="ti ti-eye" /> You are viewing <strong>{who ? who.email : 'another account'}</strong> as an admin. Counts only: no contact names, companies or messages.
        </div>
        <AdminUserAnalytics userId={viewUser} />
      </Layout>
    );
  }

  const waiting = USES_SUMMARY.includes(view) && !(summary && interviewsLoaded);
  const needsYou = S.queue?.buckets['needs-you'] || 0;
  const badge = (id: Sec) => {
    if (id === 'replies' && needsYou) return <span className="adm-pill warn" aria-label={`${needsYou} waiting on you`}>{needsYou}</span>;
    if (id === 'interviews' && interviewsLoaded && interviews.length) return <span className="adm-count">{interviews.length}</span>;
    return null;
  };

  const kpiGrid = (tiles: Array<{ label: string; value: React.ReactNode; sub: string; cls?: string }>) => (
    <div className="stat-grid">
      {tiles.map(k => (
        <div className="stat-card" key={k.label}>
          <div className="stat-label">{k.label}</div>
          <div className={`kpi-value stat-value ${k.cls || ''}`}>{k.value}</div>
          <div className="stat-sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );

  const trendCard = (
    <div className="an-card">
      <div className="an-card-head adm-card-head">
        <div>
          <div className="an-card-title"><i className="ti ti-timeline" /> Sends and replies</div>
          <div className="an-card-sub">Per day, from each contact's status history (follow-ups count as sends)</div>
        </div>
        <div className="seg-toggle" role="group" aria-label="Range">
          {[30, 90].map(d => (
            <button key={d} className={`btn btn-xs${range === d ? ' active' : ''}`} onClick={() => setRange(d)} type="button">{d}d</button>
          ))}
        </div>
      </div>
      <div className="an-card-body"><TimeSeriesChart series={S.series[String(range) as '30' | '90'] || []} /></div>
    </div>
  );

  const insightsCard = (
    <div className="an-card">
      <div className="an-card-head">
        <div className="an-card-title"><i className="ti ti-bulb" /> Insights</div>
        <div className="an-card-sub">Worked out from your full history</div>
      </div>
      <div className="an-card-body an-grid an-cards-2" style={{ gap: 10 }}>
        {insights.map(it => (
          <div className="insight" key={it.t}>
            <i className={`ti ${it.i}`} style={{ color: `var(${it.c})` }} />
            <div><div className="in-title">{it.t}</div><div className="in-text">{it.x}</div></div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Outreach ──
  const funnelSteps = [
    { label: 'Contacts added', n: m.total },
    { label: 'Emailed', n: m.sentCount },
    { label: 'Replied', n: m.repliedCount },
    { label: 'Reached Interviews', n: iv.tracked },
    { label: 'Booked a round', n: iv.interviewed },
    { label: 'Selected', n: iv.selected },
  ];
  const statusRows = statusMode === 'current' ? S.statusCurrent : S.statusEver;
  const nowByStatus = new Map(S.statusCurrent.map(r => [r.s, r.n]));
  const tplRows = S.templates
    .map(([k, v]) => ({ name: app.templates[k]?.name || k, ...v, rate: pct(v.replied, v.sent) }))
    .sort((a, b) => b.rate - a.rate);
  const fuShare = m.repliedCount ? pct(m.afterFuCount, m.repliedCount) : 0;

  const outreach = (
    <>
      {kpiGrid([
        { label: 'Contacts', value: m.total.toLocaleString(), sub: m.inCampaignNow ? `${m.queuedNow} queued · ${m.inCampaignNow} in campaigns` : `${m.queuedNow} still queued` },
        { label: 'Emailed', value: m.sentCount.toLocaleString(), sub: `${pct(m.sentCount, m.total)}% of contacts` },
        { label: 'Replied', value: m.repliedCount.toLocaleString(), sub: `${m.replyRate}% of emailed`, cls: 'green' },
        { label: 'Followed up', value: m.fuCount.toLocaleString(), sub: `${m.afterFuCount} replied after one` },
        { label: 'Bounce rate', value: `${m.bounceRate}%`, sub: `${m.bouncedCount} ever bounced`, cls: m.bounceRate > 10 ? 'red' : '' },
      ])}
      <div className="an-grid an-cards-2">
        <Card title="Outreach funnel" icon="ti-filter" sub="Every stage a contact has ever reached — email history, then the interview it led to">
          {funnelSteps.map((s, i) => (
            <HBar key={s.label} label={s.label} n={s.n} d={funnelSteps[0].n || 1} fill={accent} opacity={1 - i * 0.13}
              extra={i > 0 ? ` · ${pct(s.n, funnelSteps[i - 1].n)}% of prev` : ''} />
          ))}
        </Card>
        <Card title="Status breakdown" icon="ti-chart-pie"
          sub={statusMode === 'current' ? 'Where every contact sits right now' : 'Contacts that ever passed through each status — one can count in several'}
          right={
            <div className="seg-toggle">
              <button className={`btn btn-xs${statusMode === 'current' ? ' active' : ''}`} onClick={() => setStatusMode('current')} type="button">Now</button>
              <button className={`btn btn-xs${statusMode === 'ever' ? ' active' : ''}`} onClick={() => setStatusMode('ever')} type="button">Ever</button>
            </div>
          }>
          {statusRows.length === 0 ? <div className="an-empty"><i className="ti ti-inbox" />No contacts yet</div>
            : statusRows.map(({ s, n }) => {
              const meta = STATUS_META[s] || { label: s, c: '--slate' };
              const nowN = statusMode === 'ever' ? (nowByStatus.get(s) || 0) : null;
              return <HBar key={s} label={meta.label} dotColor={cvar(meta.c)} n={n} d={m.total || 1} fill={cvar(meta.c)}
                extra={nowN !== null && nowN !== n ? ` · now: ${nowN}` : ''} />;
            })}
        </Card>
      </div>
      {trendCard}
      <div className="an-grid an-cards-2">
        <Card title="Templates" icon="ti-template" sub="Reply rate by the template each contact was last sent">
          {tplRows.length === 0 ? <div className="an-empty"><i className="ti ti-template-off" />No sends yet</div> : (
            <table className="an-table">
              <thead><tr><th>Template</th><th className="num">Emailed</th><th className="num">Replied</th><th className="num" style={{ width: 120 }}>Rate</th></tr></thead>
              <tbody>
                {tplRows.map(r => (
                  <tr key={r.name}>
                    <td style={{ fontWeight: 500 }}>{r.name}</td>
                    <td className="num" style={{ color: 'var(--text2)' }}>{r.sent}</td>
                    <td className="num" style={{ color: 'var(--text2)' }}>{r.replied}</td>
                    <td className="num">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <b>{r.rate}%</b>
                        <div className="mini-track"><div className="mini-fill" style={{ width: `${Math.min(100, r.rate)}%`, background: accent }} /></div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Top companies" icon="ti-building" sub="Your most-contacted companies and their reply rate">
          {S.companies.length === 0 ? <div className="an-empty"><i className="ti ti-building-off" />No company data</div> : (
            <table className="an-table">
              <thead><tr><th>Company</th><th className="num">Contacts</th><th className="num">Replied</th><th className="num">Rate</th></tr></thead>
              <tbody>
                {S.companies.map(r => (
                  <tr key={r.co}>
                    <td style={{ fontWeight: 500, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.co}</td>
                    <td className="num" style={{ color: 'var(--text2)' }}>{r.total}</td>
                    <td className="num" style={{ color: 'var(--text2)' }}>{r.replied}</td>
                    <td className="num"><b style={{ color: r.rate > 0 ? teal : 'var(--text3)' }}>{r.rate}%</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <div className="an-grid an-cards-2">
        <Card title="Follow-up effectiveness" icon="ti-repeat" sub="Replies earned before vs. after a follow-up">
          {!m.fuCount ? <div className="an-empty"><i className="ti ti-repeat-off" />No follow-ups sent yet</div> : (
            <>
              <HBar label="Replied to the first email" dotColor={teal} n={m.beforeFuCount} d={m.sentCount} fill={teal} extra={` of ${m.sentCount.toLocaleString()}`} />
              <HBar label="Replied after a follow-up" dotColor={amber} n={m.afterFuCount} d={m.fuCount} fill={amber} extra={` of ${m.fuCount.toLocaleString()}`} />
              <div className="an-note">
                <b>{m.afterFuCount}</b> of your <b>{m.repliedCount}</b> replies ({fuShare}%) only came after a follow-up
                {m.afterFuCount > 0 ? ' — replies you would have missed without it.' : '.'}
                {S.due > 0 && <> <b>{S.due}</b> contacts are due one now.</>}
              </div>
            </>
          )}
        </Card>
        <CampaignsCard refreshToken={refreshToken} />
      </div>
    </>
  );

  // ── Replies ──
  const types = S.replyTypes || [];
  const typeTotal = types.reduce((n, r) => n + r.n, 0);
  const TYPE_COLOR: Record<string, string> = {
    reviewing: '--green', 'resume-requested': '--teal', 'stay-in-touch': '--blue', 'needs-attention': '--amber',
    no: '--red', other: '--slate', unclassified: '--slate',
  };
  const replies = (
    <>
      {kpiGrid([
        { label: 'Replied', value: m.repliedCount.toLocaleString(), sub: `${m.replyRate}% of emailed`, cls: 'green' },
        { label: 'Waiting on you', value: needsYou, sub: 'in Mailbox → Needs you', cls: needsYou ? 'amber' : '' },
        { label: 'Median reply time', value: median !== null ? fmtDur(median) : '—', sub: `${sortedPairs.length} measurable replies` },
        { label: 'Within 24 hours', value: sortedPairs.length ? `${within24}%` : '—', sub: 'of measurable replies' },
      ])}
      <div className="an-grid an-cards-2">
        <Card title="What replies say" icon="ti-messages" sub="The AI's verdict on each replier's latest reply">
          {typeTotal === 0 ? <div className="an-empty"><i className="ti ti-message-off" />No replies yet</div>
            : types.map(r => (
              <HBar key={r.k} label={r.k === 'unclassified' ? 'Not classified yet' : (CATEGORY_LABELS[r.k] || r.k)}
                dotColor={cvar(TYPE_COLOR[r.k] || '--slate')} n={r.n} d={typeTotal} fill={cvar(TYPE_COLOR[r.k] || '--slate')} />
            ))}
        </Card>
        <Card title="Reply journey" icon="ti-route" sub="Where everyone who replied sits now">
          {m.repliedCount === 0 ? <div className="an-empty"><i className="ti ti-route-off" />No replies yet</div>
            : S.journey.map(([s, n]) => {
              const meta = STATUS_META[s] || { label: s, c: '--slate' };
              return <HBar key={s} label={meta.label} dotColor={cvar(meta.c)} n={n} d={m.repliedCount} fill={cvar(meta.c)} />;
            })}
        </Card>
      </div>
      <div className="an-grid an-cards-2">
        <Card title="Response speed" icon="ti-clock-hour-4"
          sub={median !== null ? `Median ${fmtDur(median)} across ${sortedPairs.length} replies` : 'Time from a send to the reply it earned'}>
          <ReplyTimeChart pairs={sortedPairs} />
        </Card>
        <Card title="When replies come" icon="ti-calendar-week" sub="Sends vs. replies by weekday, and replies by hour (your timezone)">
          <WeekdayChart sends={S.weekday.sends} reps={S.weekday.replies} />
          <div style={{ marginTop: 14 }}><HourChart hours={S.replyHr} /></div>
        </Card>
      </div>
      <NeedsYouCard queue={S.queue} />
    </>
  );

  let content: React.ReactNode;
  if (waiting) {
    content = (
      <>
        <div className="stat-grid" aria-busy="true">
          {[0, 1, 2, 3, 4].map(i => (
            <div className="stat-card" key={i}><Skeleton w="50%" h={11} /><Skeleton w="45%" h={28} style={{ marginTop: 8 }} /><Skeleton w="70%" h={10} style={{ marginTop: 10 }} /></div>
          ))}
        </div>
        <div className="an-grid an-cards-2">
          {[0, 1].map(i => (
            <div className="an-card" key={i} style={{ padding: 18 }}>
              <Skeleton w="40%" h={13} style={{ marginBottom: 16 }} />
              {[0, 1, 2, 3, 4].map(r => <Skeleton key={r} w={`${88 - r * 11}%`} h={10} style={{ marginBottom: 10 }} />)}
            </div>
          ))}
        </div>
      </>
    );
  } else if (view === 'overview') {
    content = <OverviewSection S={S} interviews={interviews} go={go} refreshToken={refreshToken} chart={trendCard} insights={insightsCard} />;
  } else if (view === 'outreach') content = outreach;
  else if (view === 'replies') content = replies;
  else if (view === 'activity') content = <ActivitySection initial={S.activity} interviews={interviews} />;
  else if (view === 'interviews') content = <InterviewsSection interviews={interviews} funnel={iv} repliedCount={m.repliedCount} />;
  else if (view === 'naukri') content = <NaukriAnalytics refreshToken={refreshToken} />;
  else if (view === 'leads') content = <LeadsAnalytics refreshToken={refreshToken} />;
  else if (view === 'discover') content = <DiscoverAnalytics refreshToken={refreshToken} />;
  else content = <ReportsPanel />;

  return (
    <Layout title="Analytics" subtitle={SUBTITLE[view]} wide
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {picker}
          {view !== 'reports' && (
            <button className="btn btn-sm" onClick={refresh} disabled={refreshing} type="button">
              <i className={`ti ${refreshing ? 'ti-loader-2' : 'ti-refresh'}`} /> Refresh
            </button>
          )}
        </div>
      }>
      <div className="section" style={{ flex: 1 }}>
        <div className="adm-layout">
          <nav className="adm-nav" aria-label="Analytics sections">
            {NAV.map(g => (
              <div key={g.group} style={{ display: 'contents' }}>
                <div className="adm-nav-group">{g.group}</div>
                {g.items.map(n => (
                  <button key={n.id} type="button" className={'adm-nav-item' + (view === n.id ? ' on' : '')}
                    title={n.label} aria-label={n.label}
                    aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                    <i className={'ti ' + n.icon} aria-hidden="true" />
                    <span className="adm-nav-label">{n.label}</span>
                    {badge(n.id)}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <main className="adm-main an-main">{content}</main>
        </div>
      </div>
    </Layout>
  );
}
