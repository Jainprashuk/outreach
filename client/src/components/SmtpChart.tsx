// Port of renderChart from settings.html — hourly SMTP bars with hover tooltip.
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Bucket { hour: string; count: number; }

const IST = { timeZone: 'Asia/Kolkata' } as const;
const fmtShort = (d: Date) => d.toLocaleTimeString('en-IN', { ...IST, hour: 'numeric', hour12: true });
const fmtFull = (d: Date) => d.toLocaleTimeString('en-IN', { ...IST, hour: '2-digit', minute: '2-digit', hour12: true });

const W = 480, H = 145, padL = 28, padR = 6, padT = 10, padB = 28;
const cW = W - padL - padR, cH = H - padT - padB;

export default function SmtpChart({ buckets }: { buckets: Bucket[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const maxVal = Math.max(...buckets.map(b => b.count), 1);
  const slot = cW / 24;
  const gap = Math.max(2, slot * 0.13);
  const bw = slot - gap;

  const firstBusy = useMemo(() => buckets.findIndex(b => b.count > 0), [buckets]);

  if (!buckets.length) return <svg width="100%" style={{ display: 'block' }} viewBox={`0 0 ${W} ${H}`} />;

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.floor((svgX - padL) / slot);
    if (idx < 0 || idx >= 24) { setHover(null); return; }
    setHover({ idx, x: e.clientX, y: e.clientY });
  };

  const hb = hover ? buckets[hover.idx] : null;

  return (
    <>
      <svg ref={svgRef} width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* column highlight */}
        {hover && (
          <rect x={padL + hover.idx * slot + gap / 2} y={padT} width={bw} height={cH} rx={3}
            style={{ fill: 'var(--bg3)' }} />
        )}
        {[0.5, 1].map(frac => {
          const y = padT + cH * (1 - frac);
          return (
            <g key={frac}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} strokeDasharray="4 3" style={{ stroke: 'var(--border)', strokeWidth: 0.5 }} />
              <text x={padL - 5} y={y + 3.5} textAnchor="end" style={{ fontSize: 9, fill: 'var(--text3)' }}>{Math.round(maxVal * frac)}</text>
            </g>
          );
        })}
        <line x1={padL} y1={padT + cH} x2={W - padR} y2={padT + cH} style={{ stroke: 'var(--border-md)', strokeWidth: 0.5 }} />
        {buckets.map((b, i) => {
          const bx = padL + i * slot + gap / 2;
          const fh = (b.count / maxVal) * cH;
          const drawH = b.count > 0 ? Math.max(fh, 4) : 2;
          const by = padT + cH - drawH;
          const isNow = i === 23;
          const color = isNow ? 'var(--accent)' : 'var(--green)';
          const op = b.count === 0 ? 0.1 : isNow ? 0.9 : 0.65;
          return (
            <g key={i}>
              <rect x={bx} y={by} width={bw} height={drawH} rx={2} style={{ fill: color, opacity: op }} />
              {b.count > 0 && <rect x={bx} y={by} width={bw} height={2} rx={1} style={{ fill: color, opacity: 1 }} />}
            </g>
          );
        })}
        {[0, 6, 12, 18, 23].map(i => {
          const cx = padL + i * slot + slot / 2;
          const lbl = i === 23 ? 'now' : fmtShort(new Date(buckets[i].hour));
          return (
            <text key={i} x={cx} y={H - 5} textAnchor="middle"
              style={{ fontSize: 9, fill: i === 23 ? 'var(--accent)' : 'var(--text3)', fontWeight: i === 23 ? 600 : 400 }}>
              {lbl}
            </text>
          );
        })}
      </svg>

      {hover && hb && createPortal(
        <div id="chart-tooltip" style={{
          display: 'block',
          left: Math.max(4, Math.min(window.innerWidth - 164, hover.x - 80)),
          top: hover.y - 84,
        }}>
          <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 5, whiteSpace: 'nowrap' }}>
            {fmtFull(new Date(hb.hour))} – {fmtFull(new Date(+new Date(hb.hour) + 3_600_000))}
            {hover.idx === 23 ? <span style={{ color: 'var(--accent)', fontWeight: 600 }}> · now</span> : null}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: hb.count > 0 ? (hover.idx === 23 ? 'var(--accent)' : 'var(--green)') : 'var(--text3)' }}>
            {hb.count}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>email{hb.count !== 1 ? 's' : ''} sent</div>
        </div>,
        document.body,
      )}

      {firstBusy >= 0 && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-clock-hour-3" style={{ fontSize: 11, color: 'var(--green)' }} />
          <span style={{ color: 'var(--green)', fontWeight: 500 }}>
            {buckets[firstBusy].count} email{buckets[firstBusy].count !== 1 ? 's' : ''}
          </span>
          &nbsp;expire in ~{24 - firstBusy} hr{24 - firstBusy !== 1 ? 's' : ''} IST, freeing that capacity
        </div>
      )}
    </>
  );
}
