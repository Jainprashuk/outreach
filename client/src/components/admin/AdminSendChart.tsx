// Admin → Overview: emails sent (bars) and replies (line) per day, fleet-wide.
// Same pattern as SmtpChart: one SVG, a column hover and a portalled tooltip.
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Day { day: string; sent: number; replied: number }

const W = 640, H = 170, padL = 32, padR = 8, padT = 10, padB = 24;
const cW = W - padL - padR, cH = H - padT - padB;

// The server buckets days in IST; fill the gaps so a quiet day reads as zero.
const istDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function AdminSendChart({ series, days }: { series: Day[]; days: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const filled = useMemo(() => {
    const byDay = new Map(series.map(s => [s.day, s]));
    const out: Day[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = istDay(Date.now() - i * 86_400_000);
      out.push(byDay.get(d) || { day: d, sent: 0, replied: 0 });
    }
    return out;
  }, [series, days]);

  const totals = filled.reduce((t, d) => ({ sent: t.sent + d.sent, replied: t.replied + d.replied }), { sent: 0, replied: 0 });
  const max = Math.max(1, ...filled.map(d => Math.max(d.sent, d.replied)));
  const slot = cW / filled.length;
  const gap = Math.max(1, slot * 0.18);
  const bw = Math.max(1, slot - gap);
  const yOf = (v: number) => padT + cH - (v / max) * cH;
  const linePts = filled.map((d, i) => `${padL + i * slot + slot / 2},${yOf(d.replied)}`).join(' ');
  const labelEvery = Math.ceil(filled.length / 6);

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const idx = Math.floor(((e.clientX - rect.left) * (W / rect.width) - padL) / slot);
    setHover(idx < 0 || idx >= filled.length ? null : { idx, x: e.clientX, y: e.clientY });
  };
  const hd = hover ? filled[hover.idx] : null;

  return (
    <>
      <div className="adm-chart-total">
        <div><strong>{totals.sent.toLocaleString()}</strong>sent in {days} days</div>
        <div><strong>{totals.replied.toLocaleString()}</strong>replies</div>
        <div><strong>{totals.sent ? `${Math.round((totals.replied / totals.sent) * 1000) / 10}%` : '—'}</strong>reply rate</div>
      </div>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}
        role="img" aria-label={`Emails sent and replies per day over the last ${days} days: ${totals.sent} sent, ${totals.replied} replies.`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {hover && <rect x={padL + hover.idx * slot} y={padT} width={slot} height={cH} rx={3} style={{ fill: 'var(--bg3)' }} />}
        {[0.5, 1].map(f => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={padT + cH * (1 - f)} y2={padT + cH * (1 - f)} strokeDasharray="4 3" style={{ stroke: 'var(--border-md)', strokeWidth: 0.5 }} />
            <text x={padL - 6} y={padT + cH * (1 - f) + 3.5} textAnchor="end" style={{ fontSize: 11, fill: 'var(--text3)' }}>{Math.round(max * f)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={padT + cH} y2={padT + cH} style={{ stroke: 'var(--border-md)', strokeWidth: 0.5 }} />
        {filled.map((d, i) => d.sent > 0 && (
          <rect key={d.day} x={padL + i * slot + gap / 2} width={bw} y={yOf(d.sent)} height={Math.max(2, cH - (yOf(d.sent) - padT))}
            rx={Math.min(3, bw / 2)} style={{ fill: 'var(--adm-sent)', opacity: hover && hover.idx !== i ? 0.55 : 0.9 }} />
        ))}
        <polyline points={linePts} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          style={{ stroke: 'var(--adm-replied)' }} />
        {hover && hd && (
          <circle cx={padL + hover.idx * slot + slot / 2} cy={yOf(hd.replied)} r={4}
            style={{ fill: 'var(--adm-replied)', stroke: 'var(--bg)', strokeWidth: 2 }} />
        )}
        {filled.map((d, i) => (i % labelEvery === 0 || i === filled.length - 1) && (
          <text key={d.day} x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text3)' }}>
            {i === filled.length - 1 ? 'today' : fmtDay(d.day)}
          </text>
        ))}
      </svg>
      <div className="adm-legend" style={{ marginTop: 8 }}>
        <span><i className="adm-sw-bar" aria-hidden="true" />Sent</span>
        <span><i className="adm-sw-line" aria-hidden="true" />Replies</span>
      </div>

      {hover && hd && createPortal(
        <div id="chart-tooltip" style={{
          display: 'block',
          left: Math.max(4, Math.min(window.innerWidth - 164, hover.x - 80)),
          top: hover.y - 96,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 6 }}>{fmtDay(hd.day)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12.5 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="adm-sw-bar" />Sent</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{hd.sent}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12.5, marginTop: 3 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="adm-sw-line" />Replies</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{hd.replied}</strong>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
