import { useEffect, useMemo, useState } from 'react';
import { loadTimelinesApi, type Timeline, type TimelineBucket } from '../../lib/api';

const IST = 5.5 * 3_600_000;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

type Series = (x: TimelineBucket) => { sent: number; scheduled: number };

const VOLUME: Series = (x) => ({ sent: x.sent, scheduled: x.scheduled });
const RATE: Series = (x) => ({ sent: x.peakSent, scheduled: x.peakScheduled });

function label(t: number, granularity: 'day' | 'hour', long = false) {
  const d = new Date(t + IST);
  const mon = MON[d.getUTCMonth()];
  if (granularity === 'hour') {
    const h = d.getUTCHours();
    const s = `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
    return long ? `${d.getUTCDate()} ${mon}, ${s}` : s;
  }
  return long ? `${d.getUTCDate()} ${mon}` : String(d.getUTCDate());
}

/** One small multiple: a single measure, a single y-scale. */
function Plot({ tl, series, title, sub, capLine }: {
  tl: Timeline;
  series: Series;
  title: string;
  sub: string;
  capLine?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const b = tl.buckets;
  const W = 440, H = 128, PAD_L = 30, PAD_B = 18;
  const plotW = W - PAD_L - 8;
  const slot = plotW / Math.max(1, b.length);
  const barW = Math.max(1.5, Math.min(14, slot - 2));   // 2px surface gap
  const max = Math.max(1, ...b.map((x) => series(x).sent + series(x).scheduled));
  const nowX = PAD_L + ((tl.now - tl.from) / (tl.to - tl.from)) * plotW;
  const h = (v: number) => (v / max) * (H - PAD_B - 10);
  const every = Math.max(1, Math.ceil(b.length / 8));

  return (
    <div className="tl-plot">
      <div className="tl-plot-head">
        <h4>{title}</h4><span>{sub}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${sub}`}>
        {[0, Math.round(max / 2), max].map((v, i) => {
          const y = H - PAD_B - h(v);
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={W - 8} y2={y} stroke="var(--border)"
                strokeWidth="1" opacity={v === 0 ? 0.9 : 0.35} />
              <text x={PAD_L - 5} y={y + 3} textAnchor="end" fontSize="8.5" fill="var(--text3)">{v}</text>
            </g>
          );
        })}

        {capLine !== undefined && capLine <= max * 1.4 && (
          <>
            <line x1={PAD_L} y1={H - PAD_B - h(capLine)} x2={W - 8} y2={H - PAD_B - h(capLine)}
              stroke="var(--amber)" strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={W - 9} y={H - PAD_B - h(capLine) - 3} textAnchor="end" fontSize="8.5"
              fill="var(--amber)">cap {capLine}</text>
          </>
        )}

        <line x1={nowX} y1={4} x2={nowX} y2={H - PAD_B} stroke="var(--text3)"
          strokeWidth="1" strokeDasharray="3 3" />

        {b.map((x, i) => {
          const v = series(x);
          const bx = PAD_L + i * slot + (slot - barW) / 2;
          const base = H - PAD_B;
          return (
            <g key={x.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD_L + i * slot} y={0} width={slot} height={H - PAD_B}
                fill={hover === i ? 'var(--bg3)' : 'transparent'} />
              {v.sent > 0 && (
                <rect x={bx} y={base - h(v.sent)} width={barW} height={h(v.sent)} rx="2.5" fill="var(--tl-a)" />
              )}
              {v.scheduled > 0 && (
                <rect x={bx} y={base - h(v.sent) - h(v.scheduled) - (v.sent > 0 ? 2 : 0)}
                  width={barW} height={h(v.scheduled)} rx="2.5"
                  fill="url(#tl-proj)" stroke="var(--tl-b)" strokeWidth="1" />
              )}
              {i % every === 0 && (
                <text x={PAD_L + i * slot + slot / 2} y={H - 5} textAnchor="middle"
                  fontSize="8.5" fill="var(--text3)">{label(x.t, tl.granularity)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="tl-tip">
        {hover !== null && b[hover] ? (
          <>
            <strong>{label(b[hover].t, tl.granularity, true)}</strong>
            {' · '}{series(b[hover]).sent} sent{' · '}{series(b[hover]).scheduled} scheduled
          </>
        ) : <span>&nbsp;</span>}
      </div>
    </div>
  );
}

export default function SendingTimeline() {
  const [data, setData] = useState<{ day: Timeline; hour: Timeline } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [asTable, setAsTable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const run = (tries: number) => {
      loadTimelinesApi()
        .then((d) => { if (alive) { setData(d); setError(''); setLoading(false); } })
        .catch((e) => {
          if (!alive) return;
          const msg = (e as Error).message || '';
          // A cold lambda runs the seed and three backfill scans before serving.
          if (/not available|ECONN|timed out|before initial connection/i.test(msg) && tries < 2) {
            retry = setTimeout(() => run(tries + 1), 1200 * (tries + 1));
            return;
          }
          setError(msg); setLoading(false);
        });
    };
    const start = setTimeout(() => run(0), attempt === 0 ? 350 : 0);
    return () => { alive = false; clearTimeout(start); if (retry) clearTimeout(retry); };
  }, [attempt]);

  const totals = useMemo(() => {
    if (!data) return { sent: 0, scheduled: 0, peak: 0 };
    const d = data.day.buckets;
    return {
      sent: d.reduce((a, x) => a + x.sent, 0),
      scheduled: d.reduce((a, x) => a + x.scheduled, 0),
      peak: d.reduce((a, x) => Math.max(a, x.peakSent, x.peakScheduled), 0),
    };
  }, [data]);

  if (loading && !data) {
    return <div className="empty-state"><i className="ti ti-loader-2" /> Building the timeline…</div>;
  }
  if (error || !data) {
    const transient = /not available|before initial connection|timed out/i.test(error);
    return (
      <div className="empty-state">
        <i className="ti ti-chart-bar-off" />
        <div style={{ marginBottom: 10, maxWidth: 520 }}>
          {transient
            ? "Couldn't load the timeline — the database was still waking up. Nothing is wrong with your campaigns."
            : `Couldn't load the timeline — ${error}`}
        </div>
        <button className="btn btn-sm" type="button" onClick={() => setAttempt((a) => a + 1)}>
          <i className="ti ti-refresh" /> Try again
        </button>
      </div>
    );
  }

  const rows = [...data.day.buckets.map((x) => ({ ...x, g: 'day' as const })),
                ...data.hour.buckets.map((x) => ({ ...x, g: 'hour' as const }))]
    .filter((x) => x.sent || x.scheduled);

  return (
    <div className="tl-root">
      {/* One pattern definition shared by every plot. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <pattern id="tl-proj" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="5" height="5" fill="var(--tl-b)" opacity="0.35" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--tl-b)" strokeWidth="2.4" />
          </pattern>
        </defs>
      </svg>

      <div className="section-head" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--text2)' }}>
          {/* Legend is always present for two series; the hatch means neither is
              identified by colour alone. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--tl-a)' }} /> Sent
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, border: '1px solid var(--tl-b)',
              background: 'repeating-linear-gradient(45deg, var(--tl-b) 0 2px, transparent 2px 5px)' }} /> Scheduled
          </span>
          <span style={{ color: 'var(--text3)' }}>
            {totals.sent.toLocaleString()} sent · {totals.scheduled.toLocaleString()} to come · busiest hour {totals.peak}/hr
          </span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setAsTable((v) => !v)}>
          <i className={`ti ti-${asTable ? 'chart-bar' : 'table'}`} /> {asTable ? 'Charts' : 'Table'}
        </button>
      </div>

      {asTable ? (
        <div className="table-card" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Scale</th><th>When</th><th>Sent</th><th>Scheduled</th><th>Peak /hr</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={`${x.g}-${x.key}`}>
                  <td style={{ color: 'var(--text3)' }}>{x.g}</td>
                  <td>{label(x.t, x.g, true)}{!x.past && <span style={{ color: 'var(--text3)' }}> · upcoming</span>}</td>
                  <td>{x.sent || '—'}</td>
                  <td>{x.scheduled || '—'}</td>
                  <td>{Math.max(x.peakSent, x.peakScheduled) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tl-grid">
          <Plot tl={data.day} series={VOLUME} title="Volume · by day"
            sub="emails per day, 14 days back / 30 ahead" capLine={data.day.dailyCap} />
          <Plot tl={data.hour} series={VOLUME} title="Volume · by hour"
            sub="emails per hour, 24h back / 48h ahead" />
          <Plot tl={data.day} series={RATE} title="Rate · by day"
            sub="busiest hour of each day, emails/hour" />
          {/* Deliberately not a fourth chart: at hourly resolution the count in a
              bucket IS the rate, so it would repeat the plot above it. */}
          <div className="tl-plot tl-note">
            <div className="tl-plot-head"><h4>Rate · by hour</h4></div>
            <p>
              At hourly resolution the volume chart above <em>is</em> the rate — each bar is already
              emails per hour, so repeating it here would say nothing new.
            </p>
            <p style={{ marginTop: 8 }}>
              Use <strong>Rate · by day</strong> to see how hard any single day pushed, and the
              dashed line on <strong>Volume · by day</strong> for the {data.day.dailyCap}/day ceiling.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
