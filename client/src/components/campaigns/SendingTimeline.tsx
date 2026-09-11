import { useEffect, useState } from 'react';
import { loadTimelineApi, type Timeline, type TimelineBucket, type TimelineRange } from '../../lib/api';

const IST = 5.5 * 3_600_000;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const RANGES: [TimelineRange, string][] = [
  ['24h', 'Hourly'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];

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

/**
 * One chart carrying both measures.
 *
 * Volume and peak rate are both counts of emails, so they share a SINGLE y-axis
 * — what must never happen is two y-scales, not two series. On a daily bucket
 * the rate marker sits inside its bar ("of these 75, the busiest hour did 40");
 * on an hourly bucket the two coincide by definition and the marker rides the
 * bar top, which is the honest picture rather than a second invented series.
 */
export default function SendingTimeline() {
  const [range, setRange] = useState<TimelineRange>('7d');
  // Both measures as bars, one at a time. Overlaying the rate as a tick inside
  // the volume bar was legible in principle and not in practice.
  const [measure, setMeasure] = useState<'volume' | 'rate'>('volume');
  const [data, setData] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const run = (tries: number) => {
      loadTimelineApi(range)
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
  }, [range, attempt]);

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

  const b = data.buckets;
  const hourly = data.granularity === 'hour';
  const W = 900, H = 190, PAD_L = 34, PAD_B = 22;
  const plotW = W - PAD_L - 10;
  const slot = plotW / Math.max(1, b.length);
  const barW = Math.max(2, Math.min(20, slot - 2));   // 2px surface gap
  const peakOf = (x: TimelineBucket) => Math.max(x.peakSent, x.peakScheduled);
  // Derived rather than corrected with setState during render: an hourly bar is
  // already a per-hour rate, so the rate view collapses into the volume view.
  // Keeping `measure` untouched means switching back to a daily range restores
  // the choice instead of silently resetting it.
  const rate = measure === 'rate' && !hourly;
  const valOf = (x: TimelineBucket) => rate
    ? { sent: x.peakSent, scheduled: x.peakScheduled }
    : { sent: x.sent, scheduled: x.scheduled };
  // The cap belongs to daily volume only — it is meaningless against an hourly
  // bucket or a per-hour rate.
  const showCap = !rate && !hourly;
  const dataMax = Math.max(1, ...b.map((x) => valOf(x).sent + valOf(x).scheduled));
  // Fold the cap into the scale. Without this the line is drawn above the plot
  // whenever the cap exceeds the data, where it strikes through the text above.
  const max = showCap ? Math.max(dataMax, data.dailyCap) : dataMax;
  const h = (v: number) => (v / max) * (H - PAD_B - 12);
  const nowX = PAD_L + ((data.now - data.from) / (data.to - data.from)) * plotW;
  const every = Math.max(1, Math.ceil(b.length / 12));
  const totals = {
    sent: b.reduce((a, x) => a + x.sent, 0),
    scheduled: b.reduce((a, x) => a + x.scheduled, 0),
    peak: b.reduce((a, x) => Math.max(a, peakOf(x)), 0),
  };
  const hb = hover !== null ? b[hover] : null;

  return (
    <div className="tl-root">
      <div className="section-head" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {RANGES.map(([r, lbl]) => (
            <button key={r} type="button"
              className={`btn btn-sm${range === r ? ' btn-primary' : ''}`}
              onClick={() => setRange(r)}>{lbl}</button>
          ))}
          <span className="tl-sep" />
          <button type="button" className={`btn btn-sm${measure === 'volume' ? ' btn-primary' : ''}`}
            onClick={() => setMeasure('volume')}>Volume</button>
          <button type="button" className={`btn btn-sm${measure === 'rate' ? ' btn-primary' : ''}`}
            onClick={() => setMeasure('rate')} disabled={hourly}
            title={hourly ? 'An hourly bar is already a per-hour rate' : 'Busiest hour of each day'}>
            Peak /hr
          </button>
          <span className="tl-sep" />
          {/* Legend follows the measure, so the swatch always matches the bars. */}
          <span className="tl-key">
            <span className={`tl-sw ${rate ? 'tl-sw-r' : 'tl-sw-a'}`} /> Sent
          </span>
          <span className="tl-key"><span className="tl-sw tl-sw-b" /> Scheduled</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setAsTable((v) => !v)}>
          <i className={`ti ti-${asTable ? 'chart-bar' : 'table'}`} /> {asTable ? 'Chart' : 'Table'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
        {totals.sent.toLocaleString()} sent · {totals.scheduled.toLocaleString()} still to come ·
        busiest hour <strong>{totals.peak}/hr</strong>
        <span style={{ color: 'var(--text3)' }}>
          {rate
            ? ' · bars are the busiest hour of each day'
            : hourly
              ? ' · each bar is one hour, so its height is also the rate'
              : ' · bars are emails per day'}
        </span>
      </div>

      {asTable ? (
        <div className="table-card" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Sent</th><th>Scheduled</th><th>Peak /hr</th></tr></thead>
            <tbody>
              {b.filter((x) => x.sent || x.scheduled).map((x) => (
                <tr key={x.key}>
                  <td>{label(x.t, data.granularity, true)}{!x.past && <span style={{ color: 'var(--text3)' }}> · upcoming</span>}</td>
                  <td>{x.sent || '—'}</td>
                  <td>{x.scheduled || '—'}</td>
                  <td>{peakOf(x) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="tl-svg" role="img"
            aria-label={`Emails sent and scheduled, ${range}`}>
            <defs>
              <pattern id="tl-proj" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="5" height="5" fill="var(--tl-b)" opacity="0.35" />
                <line x1="0" y1="0" x2="0" y2="5" stroke="var(--tl-b)" strokeWidth="2.4" />
              </pattern>
            </defs>

            {[0, Math.round(max / 2), max].map((v, i) => {
              const y = H - PAD_B - h(v);
              return (
                <g key={i}>
                  <line x1={PAD_L} y1={y} x2={W - 10} y2={y} stroke="var(--border)"
                    strokeWidth="1" opacity={v === 0 ? 0.9 : 0.35} />
                  <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text3)">{v}</text>
                </g>
              );
            })}

            {showCap && (
              <>
                <line x1={PAD_L} y1={H - PAD_B - h(data.dailyCap)} x2={W - 10} y2={H - PAD_B - h(data.dailyCap)}
                  stroke="var(--amber)" strokeWidth="1.5" strokeDasharray="4 3" />
                <text x={W - 11} y={H - PAD_B - h(data.dailyCap) - 4} textAnchor="end" fontSize="9"
                  fill="var(--amber)">cap {data.dailyCap}/day</text>
              </>
            )}

            <line x1={nowX} y1={6} x2={nowX} y2={H - PAD_B} stroke="var(--text3)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={nowX + 4} y={13} fontSize="9" fill="var(--text3)">now</text>

            {b.map((x, i) => {
              const bx = PAD_L + i * slot + (slot - barW) / 2;
              const base = H - PAD_B;
              const v = valOf(x);
              return (
                <g key={x.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={PAD_L + i * slot} y={0} width={slot} height={H - PAD_B}
                    fill="var(--text)" opacity={hover === i ? 0.06 : 0} />
                  {v.sent > 0 && (
                    <rect x={bx} y={base - h(v.sent)} width={barW} height={h(v.sent)} rx="3"
                      fill={rate ? 'var(--tl-r)' : 'var(--tl-a)'} />
                  )}
                  {v.scheduled > 0 && (
                    <rect x={bx} y={base - h(v.sent) - h(v.scheduled) - (v.sent > 0 ? 2 : 0)}
                      width={barW} height={h(v.scheduled)} rx="3"
                      fill="url(#tl-proj)" stroke="var(--tl-b)" strokeWidth="1" />
                  )}
                  {i % every === 0 && (
                    <text x={PAD_L + i * slot + slot / 2} y={H - 7} textAnchor="middle"
                      fontSize="9" fill="var(--text3)">{label(x.t, data.granularity)}</text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Height reserved so the layout does not jump as the pointer moves. */}
          <div className="tl-tip">
            {hb ? (
              <>
                <strong>{label(hb.t, data.granularity, true)}</strong>
                {' · '}{hb.sent} sent{' · '}{hb.scheduled} scheduled
                {/* The measure not currently plotted still shows here, so
                    switching is never needed just to read a number. */}
                {!hourly && (rate
                  ? <> · {hb.sent + hb.scheduled} that day in total</>
                  : peakOf(hb) > 0 && <> · busiest hour {peakOf(hb)}/hr</>)}
                {!hb.past && <span style={{ color: 'var(--text3)' }}> · upcoming</span>}
              </>
            ) : <span>&nbsp;</span>}
          </div>
        </>
      )}
    </div>
  );
}
