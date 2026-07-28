import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Layout from '../components/Layout';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import {
  ACTIVITY_META, ACTIVITY_WINDOWS, analyze, buildActivityEvents, buildDailySeries,
  computeMetrics, countActivity, cvar, dayKey, fmtAgo, fmtDur, pct,
  STATUS_META, type ActivityWindowKey, type Analyzed, type Metrics,
} from '../lib/analytics';

// ── Small building blocks ────────────────────────────────────────────────────
function HBar({ label, dotColor, n, d, extra, fill, opacity = 0.85 }: {
  label: string; dotColor?: string; n: number; d: number; extra?: string; fill: string; opacity?: number;
}) {
  return (
    <div className="hbar-row">
      <div className="hbar-top">
        <span className="hbar-label">{dotColor ? <span className="dot" style={{ background: dotColor }} /> : null}{label}</span>
        <span className="hbar-val"><b>{n.toLocaleString()}</b> <span style={{ color: 'var(--text3)' }}>{pct(n, d)}%{extra || ''}</span></span>
      </div>
      <div className="hbar-track"><div className="hbar-fill" style={{ width: `${Math.max(2, pct(n, d))}%`, background: fill, opacity }} /></div>
    </div>
  );
}

function Card({ title, icon, sub, right, children, delay }: {
  title: string; icon: string; sub: string; right?: React.ReactNode; children: React.ReactNode; delay?: string;
}) {
  return (
    <div className="an-card" style={delay ? { animationDelay: delay } : undefined}>
      <div className="an-card-head" style={right ? { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } : undefined}>
        <div>
          <div className="an-card-title"><i className={`ti ${icon}`} /> {title}</div>
          <div className="an-card-sub">{sub}</div>
        </div>
        {right}
      </div>
      <div className="an-card-body">{children}</div>
    </div>
  );
}

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
      <svg ref={svgRef} width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}
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
function WeekdayChart({ A }: { A: Analyzed[] }) {
  const c1 = cvar('--chart-1') || '#4f46e5';
  const c2 = cvar('--chart-2') || '#0d9488';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sends = [0, 0, 0, 0, 0, 0, 0], reps = [0, 0, 0, 0, 0, 0, 0];
  const idx = (t: number) => (new Date(t).getDay() + 6) % 7;
  A.forEach(a => {
    a.sends.forEach(s => sends[idx(s.t)]++);
    a.replies.forEach(r => reps[idx(r.t)]++);
  });
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
function ActivitySection({ A }: { A: Analyzed[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [win, setWin] = useState<ActivityWindowKey>('24h');

  // Windows are relative to "now", so keep it ticking while the page is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const events = useMemo(() => buildActivityEvents(A), [A]);
  const cols = useMemo(
    () => ACTIVITY_WINDOWS.map(w => ({ ...w, counts: countActivity(events, w.ms, now) })),
    [events, now],
  );

  const activeWin = ACTIVITY_WINDOWS.find(w => w.key === win)!;
  const feed = useMemo(() => {
    const from = now - activeWin.ms;
    const known = new Set(ACTIVITY_META.map(m => m.type));
    return events.filter(e => !e.countOnly && e.t >= from && e.t <= now && known.has(e.type)).slice(0, 40);
  }, [events, now, activeWin]);

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
            What happened in the last hour, 6 hours, day, week and month — added, sent, replied, bounced and every other status change
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

function buildInsights(A: Analyzed[], m: Metrics, templates: Record<string, { name: string }>): Insight[] {
  const items: Insight[] = [];

  const tmap: Record<string, { s: number; r: number }> = {};
  A.forEach(a => { if (!a.everSent) return; const k = a.c.template || '—'; tmap[k] = tmap[k] || { s: 0, r: 0 }; tmap[k].s++; if (a.everReplied) tmap[k].r++; });
  const ranked = Object.entries(tmap).filter(([, v]) => v.s >= 20)
    .map(([k, v]) => ({ name: templates[k]?.name || k, rate: pct(v.r, v.s), s: v.s }))
    .sort((a, b) => b.rate - a.rate);
  if (ranked.length >= 2) {
    items.push({ i: 'ti-trophy', c: '--green', t: 'Best template',
      x: <><b>{ranked[0].name}</b> ({ranked[0].rate}%) out-performs <b>{ranked[ranked.length - 1].name}</b> ({ranked[ranked.length - 1].rate}%) — consider shifting volume to it.</> });
  } else if (ranked.length === 1) {
    items.push({ i: 'ti-trophy', c: '--green', t: 'Template baseline', x: <><b>{ranked[0].name}</b> converts at {ranked[0].rate}% over {ranked[0].s} sends.</> });
  }

  const allPairs = A.flatMap(a => a.pairs).sort((a, b) => a - b);
  if (allPairs.length >= 5) {
    const med = allPairs[Math.floor(allPairs.length / 2)];
    const within24 = pct(allPairs.filter(h => h <= 24).length, allPairs.length);
    items.push({ i: 'ti-clock-bolt', c: '--indigo', t: 'Response speed',
      x: <>Median reply lands in <b>{fmtDur(med)}</b>; {within24}% arrive within 24 hours. If no reply after ~3 days, it likely isn't coming — follow up then.</> });
  }

  const wd = [0, 0, 0, 0, 0, 0, 0], hr = new Array(24).fill(0);
  A.forEach(a => a.replies.forEach(r => { const d = new Date(r.t); wd[d.getDay()]++; hr[d.getHours()]++; }));
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

  const now = Date.now(), wk = 7 * 86400000;
  const inWin = (t: number, from: number, to: number) => t >= from && t < to;
  let s1 = 0, s2 = 0, r1 = 0, r2 = 0;
  A.forEach(a => {
    a.sends.forEach(s => { if (inWin(s.t, now - wk, now)) s1++; else if (inWin(s.t, now - 2 * wk, now - wk)) s2++; });
    a.replies.forEach(r => { if (inWin(r.t, now - wk, now)) r1++; else if (inWin(r.t, now - 2 * wk, now - wk)) r2++; });
  });
  if (s1 + s2 > 0) {
    const dir = s1 > s2 ? 'up' : s1 < s2 ? 'down' : 'flat';
    items.push({
      i: dir === 'up' ? 'ti-trending-up' : dir === 'down' ? 'ti-trending-down' : 'ti-minus',
      c: dir === 'down' ? '--amber' : '--green', t: 'This week vs last',
      x: <>Sends: <b>{s1}</b> vs {s2} · replies: <b>{r1}</b> vs {r2}. {dir === 'down' ? 'Volume is dropping — queued contacts are waiting.' : dir === 'up' ? 'Volume is growing — keep the cadence.' : 'Steady cadence.'}</>,
    });
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

  if (m.repliedCount >= 5) {
    const adv = A.filter(a => a.everReplied && (a.ever.has('in-review') || a.ever.has('closed'))).length;
    items.push({ i: 'ti-target-arrow', c: '--indigo', t: 'Reply → pipeline conversion',
      x: <><b>{adv}</b> of {m.repliedCount} repliers ({pct(adv, m.repliedCount)}%) progressed to review or closed.{m.repliedCount - adv > 0 ? ` ${m.repliedCount - adv} replies may still need a next step.` : ''}</> });
  }

  const due = A.filter(a => (a.c.status === 'sent' || a.c.status === 'replied') && !a.c.followUpSentAt && a.c.lastSentAt && (now - new Date(a.c.lastSentAt).getTime()) > 3 * 86400000).length;
  if (due > 0 || m.queuedNow > 0) {
    items.push({ i: 'ti-hourglass-high', c: '--amber', t: 'Waiting on you',
      x: <>{due > 0 ? <><b>{due}</b> contacts are due a follow-up</> : null}{due > 0 && m.queuedNow > 0 ? ' · ' : ''}{m.queuedNow > 0 ? <><b>{m.queuedNow}</b> are queued and never emailed</> : null}.</> });
  }

  const verdict = m.replyRate >= 15 ? 'well above' : m.replyRate >= 5 ? 'around' : 'below';
  items.push({ i: 'ti-gauge', c: m.replyRate >= 5 ? '--green' : '--red', t: 'Overall reply rate',
    x: <><b>{m.replyRate}%</b> of emailed contacts have ever replied — {verdict} the ~5% cold-email benchmark.{m.replyRate < 5 ? ' Tighter targeting and shorter emails usually move this most.' : ''}</> });

  return items;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Analytics() {
  const app = useApp();
  const toast = useToast();
  const [range, setRange] = useState(30);
  const [statusMode, setStatusMode] = useState<'current' | 'ever'>('current');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      await Promise.all([app.loadContacts(), app.loadTemplates()]);
    } catch (err: any) {
      toast('Could not load analytics: ' + err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  const A = useMemo(() => app.contacts.map(analyze), [app.contacts]);
  const m = useMemo(() => computeMetrics(A), [A]);
  const series = useMemo(() => buildDailySeries(A, range), [A, range]);
  const allPairs = useMemo(() => A.flatMap(a => a.pairs), [A]);
  const insights = useMemo(() => buildInsights(A, m, app.templates), [A, m, app.templates]);

  const sortedPairs = [...allPairs].sort((a, b) => a - b);
  const median = sortedPairs.length ? sortedPairs[Math.floor(sortedPairs.length / 2)] : null;

  const kpis = [
    { label: 'Total contacts', value: m.total.toLocaleString(), sub: `${m.queuedNow} still queued`, cls: '' },
    { label: 'Contacts emailed', value: m.sentCount.toLocaleString(), sub: `${m.fuCount} got a follow-up`, cls: '' },
    { label: 'Ever replied', value: String(m.repliedCount), sub: `${m.replyRate}% of emailed`, cls: 'green' },
    { label: 'Bounce rate', value: `${m.bounceRate}%`, sub: `${m.bouncedCount} ever bounced`, cls: m.bounceRate > 10 ? 'red' : '' },
    { label: 'Advanced', value: String(m.inReviewEver + m.closedEver), sub: `${m.inReviewEver} in review · ${m.closedEver} closed`, cls: 'teal' },
  ];

  // Funnel
  const funnelSteps = [
    { label: 'Contacts added', n: m.total },
    { label: 'Emailed', n: m.sentCount },
    { label: 'Replied (ever)', n: m.repliedCount },
    { label: 'Moved to review', n: m.inReviewEver },
    { label: 'Closed', n: m.closedEver },
  ];
  const funnelMax = funnelSteps[0].n || 1;
  const accent = cvar('--accent') || '#4f46e5';

  // Status breakdown
  const statusRows = statusMode === 'current'
    ? Object.entries(A.reduce<Record<string, number>>((acc, a) => { acc[a.c.status] = (acc[a.c.status] || 0) + 1; return acc; }, {}))
        .map(([s, n]) => ({ s, n }))
    : Object.keys(STATUS_META).map(s => ({ s, n: A.filter(a => a.ever.has(s)).length })).filter(r => r.n > 0);
  statusRows.sort((a, b) => b.n - a.n);

  // Reply journey
  const repliers = A.filter(a => a.everReplied);
  const journeyRows = Object.entries(repliers.reduce<Record<string, number>>((acc, a) => {
    acc[a.outcome] = (acc[a.outcome] || 0) + 1; return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  // Templates
  const tplRows = Object.entries(A.reduce<Record<string, { sent: number; replied: number }>>((acc, a) => {
    if (!a.everSent) return acc;
    const k = a.c.template || '—';
    acc[k] = acc[k] || { sent: 0, replied: 0 };
    acc[k].sent++;
    if (a.everReplied) acc[k].replied++;
    return acc;
  }, {})).map(([k, v]) => ({ name: app.templates[k]?.name || k, ...v, rate: pct(v.replied, v.sent) }))
    .sort((a, b) => b.rate - a.rate);

  // Companies
  const coRows = Object.entries(A.reduce<Record<string, { total: number; replied: number }>>((acc, a) => {
    const co = (a.c.company || '').trim(); if (!co) return acc;
    acc[co] = acc[co] || { total: 0, replied: 0 };
    acc[co].total++;
    if (a.everReplied) acc[co].replied++;
    return acc;
  }, {})).map(([co, v]) => ({ co, ...v, rate: pct(v.replied, v.total) }))
    .sort((a, b) => b.total - a.total).slice(0, 8);

  const teal = cvar('--teal') || '#085041';
  const amber = cvar('--amber') || '#8a5c00';
  const fuShare = m.repliedCount ? pct(m.afterFuCount, m.repliedCount) : 0;

  return (
    <Layout title="Analytics"
      subtitle={`${m.total.toLocaleString()} contacts · ${m.sentCount.toLocaleString()} emailed · ${m.repliedCount.toLocaleString()} ever replied`}
      actions={
        <button className="btn btn-sm" onClick={load} disabled={refreshing} type="button">
          <i className={`ti ${refreshing ? 'ti-loader-2' : 'ti-refresh'}`} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
        </button>
      }>
      <div className="stat-grid" style={{ padding: '0 0 4px', marginBottom: 14 }}>
        {kpis.map(k => (
          <div className="stat-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className={`kpi-value stat-value ${k.cls}`}>{k.value}</div>
            <div className="stat-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <ActivitySection A={A} />

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Outreach funnel" icon="ti-filter" sub="Every stage a contact has ever reached (history-based)" delay=".04s">
          {funnelSteps.map((s, i) => (
            <HBar key={s.label} label={s.label} n={s.n} d={funnelMax} fill={accent} opacity={1 - i * 0.15}
              extra={i > 0 ? ` · ${pct(s.n, funnelSteps[i - 1].n)}% of prev` : ''} />
          ))}
        </Card>
        <Card title="Status breakdown" icon="ti-chart-pie" delay=".08s"
          sub={statusMode === 'current' ? 'Where every contact sits right now' : 'Contacts that ever passed through each status — one contact can count in several'}
          right={
            <div className="seg-toggle">
              <button className={`btn btn-xs${statusMode === 'current' ? ' active' : ''}`} onClick={() => setStatusMode('current')} type="button">Current</button>
              <button className={`btn btn-xs${statusMode === 'ever' ? ' active' : ''}`} onClick={() => setStatusMode('ever')} type="button">Ever reached</button>
            </div>
          }>
          {statusRows.length === 0 ? <div className="an-empty"><i className="ti ti-inbox" />No contacts yet</div>
            : statusRows.map(({ s, n }) => {
              const meta = STATUS_META[s] || { label: s, c: '--slate' };
              const nowN = statusMode === 'ever' ? A.filter(a => a.c.status === s).length : null;
              return (
                <HBar key={s} label={meta.label} dotColor={cvar(meta.c)} n={n} d={A.length || 1} fill={cvar(meta.c)}
                  extra={nowN !== null && nowN !== n ? ` · now: ${nowN}` : ''} />
              );
            })}
        </Card>
      </div>

      <div className="an-card" style={{ marginBottom: 14, animationDelay: '.12s' }}>
        <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="an-card-title"><i className="ti ti-timeline" /> Activity over time</div>
            <div className="an-card-sub">Send events vs. replies received (from status history)</div>
          </div>
          <div className="seg-toggle">
            <button className={`btn btn-xs${range === 30 ? ' active' : ''}`} onClick={() => setRange(30)} type="button">30d</button>
            <button className={`btn btn-xs${range === 90 ? ' active' : ''}`} onClick={() => setRange(90)} type="button">90d</button>
          </div>
        </div>
        <div className="an-card-body">
          <TimeSeriesChart series={series} />
        </div>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Response speed" icon="ti-clock-hour-4" delay=".16s"
          sub={median !== null ? `Median ${fmtDur(median)} across ${allPairs.length} measurable replies` : 'Time from a send to the reply it earned'}>
          <ReplyTimeChart pairs={allPairs} />
        </Card>
        <Card title="Template performance" icon="ti-template" sub="Reply rate by template (counts contacts that ever replied)" delay=".2s">
          {tplRows.length === 0 ? <div className="an-empty"><i className="ti ti-template-off" />No sends yet</div> : (
            <table className="an-table">
              <thead><tr><th>Template</th><th className="num">Contacts</th><th className="num">Replied</th><th className="num" style={{ width: 120 }}>Reply rate</th></tr></thead>
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
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Reply journey" icon="ti-route" sub="What happened to contacts after they replied" delay=".24s">
          {repliers.length === 0 ? <div className="an-empty"><i className="ti ti-route-off" />No replies yet</div> : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
                {repliers.length} contacts have replied at least once. They currently sit at:
              </div>
              {journeyRows.map(([s, n]) => {
                const meta = STATUS_META[s] || { label: s, c: '--slate' };
                return <HBar key={s} label={meta.label} dotColor={cvar(meta.c)} n={n} d={repliers.length} fill={cvar(meta.c)} />;
              })}
            </>
          )}
        </Card>
        <Card title="Weekly rhythm" icon="ti-calendar-week" sub="Sends vs. replies by day of week" delay=".28s">
          <WeekdayChart A={A} />
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Top companies" icon="ti-building" sub="Most-contacted organisations & their reply rate" delay=".32s">
          {coRows.length === 0 ? <div className="an-empty"><i className="ti ti-building-off" />No company data</div> : (
            <table className="an-table">
              <thead><tr><th>Company</th><th className="num">Contacts</th><th className="num">Replied</th><th className="num">Rate</th></tr></thead>
              <tbody>
                {coRows.map(r => (
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
        <Card title="Follow-up effectiveness" icon="ti-repeat" sub="Replies earned before vs. after a follow-up" delay=".36s">
          {!m.fuCount ? <div className="an-empty"><i className="ti ti-repeat-off" />No follow-ups sent yet</div> : (
            <>
              <HBar label="Replied to first email" dotColor={teal} n={m.beforeFuCount} d={m.sentCount} fill={teal}
                extra={` of ${m.sentCount.toLocaleString()}`} />
              <HBar label="Replied after a follow-up" dotColor={amber} n={m.afterFuCount} d={m.fuCount} fill={amber}
                extra={` of ${m.fuCount.toLocaleString()}`} />
              <div style={{ marginTop: 14, padding: '11px 13px', borderRadius: 'var(--radius)', background: 'var(--bg2)', border: '0.5px solid var(--border)', fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>
                <b style={{ color: 'var(--text)' }}>{m.afterFuCount}</b> of your <b style={{ color: 'var(--text)' }}>{m.repliedCount}</b> total replies ({fuShare}%) only came after a follow-up —{' '}
                {m.afterFuCount > 0 ? 'these are replies you would have missed without following up.' : "follow-ups haven't converted anyone yet."}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="an-card" style={{ marginBottom: 14, animationDelay: '.4s' }}>
        <div className="an-card-head">
          <div className="an-card-title"><i className="ti ti-bulb" /> Insights</div>
          <div className="an-card-sub">Automatically surfaced from your full status history</div>
        </div>
        <div className="an-card-body an-grid an-cards-2" style={{ gap: 10 }}>
          {insights.map(it => (
            <div className="insight" key={it.t}>
              <i className={`ti ${it.i}`} style={{ color: `var(${it.c})` }} />
              <div>
                <div className="in-title">{it.t}</div>
                <div className="in-text">{it.x}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
}
