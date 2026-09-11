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
  const max = Math.max(1, ...b.map((x) => Math.max(x.sent + x.scheduled, peakOf(x))));
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
          {/* Two fills plus a marker, so a legend is always present; the hatch
              and the tick mean nothing is identified by colour alone. */}
          <span className="tl-key"><span className="tl-sw tl-sw-a" /> Sent</span>
          <span className="tl-key"><span className="tl-sw tl-sw-b" /> Scheduled</span>
          <span className="tl-key"><span className="tl-sw tl-sw-r" /> Peak /hr</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setAsTable((v) => !v)}>
          <i className={`ti ti-${asTable ? 'chart-bar' : 'table'}`} /> {asTable ? 'Chart' : 'Table'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
        {totals.sent.toLocaleString()} sent · {totals.scheduled.toLocaleString()} still to come ·
        busiest hour <strong>{totals.peak}/hr</strong>
        {!hourly && <span style={{ color: 'var(--text3)' }}> · bars are emails per day, the tick is that day's busiest hour</span>}
        {hourly && <span style={{ color: 'var(--text3)' }}> · each bar is one hour, so its height is also the rate</span>}
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

            {!hourly && data.dailyCap <= max * 1.4 && (
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
              const peak = peakOf(x);
              return (
                <g key={x.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={PAD_L + i * slot} y={0} width={slot} height={H - PAD_B}
                    fill={hover === i ? 'var(--bg3)' : 'transparent'} />
                  {x.sent > 0 && (
                    <rect x={bx} y={base - h(x.sent)} width={barW} height={h(x.sent)} rx="3" fill="var(--tl-a)" />
                  )}
                  {x.scheduled > 0 && (
                    <rect x={bx} y={base - h(x.sent) - h(x.scheduled) - (x.sent > 0 ? 2 : 0)}
                      width={barW} height={h(x.scheduled)} rx="3"
                      fill="url(#tl-proj)" stroke="var(--tl-b)" strokeWidth="1" />
                  )}
                  {/* Same axis, same unit — a tick showing the busiest hour inside
                      this bucket. On an hourly bucket it coincides with the top. */}
                  {peak > 0 && !hourly && (
                    <line x1={bx - 1.5} y1={base - h(peak)} x2={bx + barW + 1.5} y2={base - h(peak)}
                      stroke="var(--tl-r)" strokeWidth="2" strokeLinecap="round" />
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
                {!hourly && peakOf(hb) > 0 && <> · busiest hour {peakOf(hb)}/hr</>}
                {!hb.past && <span style={{ color: 'var(--text3)' }}> · upcoming</span>}
              </>
            ) : <span>&nbsp;</span>}
          </div>
        </>
      )}
    </div>
  );
}
