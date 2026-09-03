// Shared building blocks for the analytics views (outreach + leads), so both
// read as one page rather than two designs.
import { pct } from '../lib/analytics';

export function HBar({ label, dotColor, n, d, extra, fill, opacity = 0.85 }: {
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

export function Card({ title, icon, sub, right, children, delay }: {
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
