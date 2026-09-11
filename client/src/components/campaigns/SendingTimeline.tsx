import { useEffect, useMemo, useState } from 'react';
import { loadTimelineApi, type Timeline, type TimelineBucket } from '../../lib/api';

/**
 * Sending volume and rate, past and projected, on one shared time axis.
 *
 * Volume and rate are different measures on different scales, so they get two
 * stacked charts sharing an x-axis rather than one chart with two y-axes.
 */
export default function SendingTimeline() {
  const [granularity, setGranularity] = useState<'day' | 'hour'>('day');
  const [data, setData] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadTimelineApi(granularity)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [granularity]);

  const fmtBucket = (b: TimelineBucket, long = false) => {
    const d = new Date(b.t + 5.5 * 3_600_000);
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    if (granularity === 'hour') {
      const h = d.getUTCHours();
      const s = `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
      return long ? `${d.getUTCDate()} ${mon}, ${s}` : s;
    }
    return long ? `${d.getUTCDate()} ${mon}` : `${d.getUTCDate()}`;
  };

  const totals = useMemo(() => {
    if (!data) return { sent: 0, scheduled: 0, peak: 0 };
    return {
      sent: data.buckets.reduce((a, b) => a + b.sent, 0),
      scheduled: data.buckets.reduce((a, b) => a + b.scheduled, 0),
      peak: data.buckets.reduce((a, b) => Math.max(a, b.peakSent, b.peakScheduled), 0),
    };
  }, [data]);

  if (loading && !data) {
    return <div className="empty-state"><i className="ti ti-loader-2" /> Building the timeline…</div>;
  }
  if (error || !data) {
    return <div className="empty-state"><i className="ti ti-alert-triangle" /> {error || 'No timeline'}</div>;
  }

  const b = data.buckets;
  const W = 900;
  const H = 150;
  const PAD_L = 34;
  const PAD_B = 20;
  const plotW = W - PAD_L - 8;
  const slot = plotW / Math.max(1, b.length);
  const barW = Math.max(2, Math.min(18, slot - 2));   // 2px surface gap between bars

  const volMax = Math.max(1, ...b.map((x) => x.sent + x.scheduled));
  const rateMax = Math.max(1, ...b.map((x) => Math.max(x.peakSent, x.peakScheduled)));
  const nowX = PAD_L + ((data.now - data.from) / (data.to - data.from)) * plotW;

  const xOf = (i: number) => PAD_L + i * slot + (slot - barW) / 2;
  const ticks = (max: number) => [0, Math.round(max / 2), max];

  // Every Nth label, so an hour axis does not collide with itself.
  const labelEvery = granularity === 'hour' ? 6 : Math.ceil(b.length / 15);

  const chart = (
    kind: 'volume' | 'rate',
    title: string,
    sub: string,
    valueOf: (x: TimelineBucket) => { sent: number; scheduled: number },
    max: number,
    capLine?: number,
  ) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h4>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{sub}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        role="img" aria-label={title}>
        <defs>
          {/* Texture, not just a lighter colour: projected volume must stay
              distinguishable in greyscale and for colour-vision deficiency. */}
          <pattern id="tl-proj" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="5" height="5" fill="var(--tl-b)" opacity="0.35" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--tl-b)" strokeWidth="2.4" />
          </pattern>
        </defs>

        {ticks(max).map((v) => {
          const y = H - PAD_B - (v / max) * (H - PAD_B - 8);
          return (
            <g key={v}>
              <line x1={PAD_L} y1={y} x2={W - 8} y2={y} stroke="var(--border)" strokeWidth="1" opacity={v === 0 ? 0.9 : 0.4} />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text3)">{v}</text>
            </g>
          );
        })}

        {capLine && capLine < max * 3 && (
          <g>
            <line x1={PAD_L} y1={H - PAD_B - (capLine / max) * (H - PAD_B - 8)}
              x2={W - 8} y2={H - PAD_B - (capLine / max) * (H - PAD_B - 8)}
              stroke="var(--amber)" strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={W - 10} y={H - PAD_B - (capLine / max) * (H - PAD_B - 8) - 4}
              textAnchor="end" fontSize="9" fill="var(--amber)">cap {capLine}</text>
          </g>
        )}

        <line x1={nowX} y1={4} x2={nowX} y2={H - PAD_B} stroke="var(--text3)" strokeWidth="1" strokeDasharray="3 3" />
        <text x={nowX + 4} y={11} fontSize="9" fill="var(--text3)">now</text>

        {b.map((x, i) => {
          const v = valueOf(x);
          const h1 = (v.sent / max) * (H - PAD_B - 8);
          const h2 = (v.scheduled / max) * (H - PAD_B - 8);
          const base = H - PAD_B;
          return (
            <g key={x.key}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit target spans the full column height, not just the bar. */}
              <rect x={PAD_L + i * slot} y={0} width={slot} height={H - PAD_B}
                fill={hover === i ? 'var(--bg3)' : 'transparent'} />
              {v.sent > 0 && (
                <rect x={xOf(i)} y={base - h1} width={barW} height={h1} rx="3" fill="var(--tl-a)" />
              )}
              {v.scheduled > 0 && (
                <rect x={xOf(i)} y={base - h1 - h2 - (v.sent > 0 ? 2 : 0)} width={barW} height={h2}
                  rx="3" fill="url(#tl-proj)" stroke="var(--tl-b)" strokeWidth="1" />
              )}
              {i % labelEvery === 0 && (
                <text x={PAD_L + i * slot + slot / 2} y={H - 6} textAnchor="middle"
                  fontSize="9" fill="var(--text3)">{fmtBucket(x)}</text>
              )}
            </g>
          );
        })}
      </svg>

      {hover !== null && b[hover] && (
        <div style={{
          fontSize: 12, marginTop: 4, color: 'var(--text2)',
          background: 'var(--bg3)', borderRadius: 6, padding: '6px 10px', display: 'inline-block',
        }}>
          <strong>{fmtBucket(b[hover], true)}</strong>
          {' · '}{valueOf(b[hover]).sent} sent
          {' · '}{valueOf(b[hover]).scheduled} {kind === 'rate' ? 'peak scheduled' : 'scheduled'}
        </div>
      )}
    </div>
  );

  return (
    <div className="tl-root">
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={`btn btn-sm${granularity === 'day' ? ' btn-primary' : ''}`}
            onClick={() => setGranularity('day')}>Day</button>
          <button type="button" className={`btn btn-sm${granularity === 'hour' ? ' btn-primary' : ''}`}
            onClick={() => setGranularity('hour')}>Hour</button>
          {/* Legend is always present for two series, and both are also encoded
              by fill texture so identity is never colour-alone. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, fontSize: 12, color: 'var(--text2)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--tl-a)' }} /> Sent
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, border: '1px solid var(--tl-b)', background: 'repeating-linear-gradient(45deg, var(--tl-b) 0 2px, transparent 2px 5px)' }} /> Scheduled
          </span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setAsTable((v) => !v)}>
          <i className={`ti ti-${asTable ? 'chart-bar' : 'table'}`} /> {asTable ? 'Chart' : 'Table'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
        {totals.sent.toLocaleString()} sent in this window · {totals.scheduled.toLocaleString()} still to come ·
        busiest hour {totals.peak}/hr
      </div>

      {asTable ? (
        <div className="table-card" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Sent</th><th>Scheduled</th><th>Peak /hr</th></tr></thead>
            <tbody>
              {b.filter((x) => x.sent || x.scheduled).map((x) => (
                <tr key={x.key}>
                  <td>{fmtBucket(x, true)}{!x.past && <span style={{ color: 'var(--text3)' }}> · upcoming</span>}</td>
                  <td>{x.sent || '—'}</td>
                  <td>{x.scheduled || '—'}</td>
                  <td>{Math.max(x.peakSent, x.peakScheduled) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {chart('volume', 'Volume',
            granularity === 'day' ? 'emails per day' : 'emails per hour',
            (x) => ({ sent: x.sent, scheduled: x.scheduled }), volMax,
            granularity === 'day' ? data.dailyCap : undefined)}
          {chart('rate', 'Rate',
            granularity === 'day' ? 'busiest hour of each day, emails/hour' : 'emails in that hour',
            (x) => ({ sent: x.peakSent, scheduled: x.peakScheduled }), rateMax)}
        </>
      )}
    </div>
  );
}
