// A small explanation panel that opens on hover, on keyboard focus, and on tap (for
// phones, where there is no hover). Used where a number needs its "why" — a score,
// an email format — without a page of text around it.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export default function HoverCard({ trigger, children, align = 'right', width = 320 }: {
  trigger: ReactNode;
  children: ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // A tap opens it; a tap anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
      <span tabIndex={0} role="button" aria-expanded={open} style={{ cursor: 'help', display: 'inline-flex' }}>{trigger}</span>
      {open && (
        <span role="tooltip" style={{
          position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 50,
          width: `min(${width}px, calc(100vw - 32px))`, padding: '10px 12px', borderRadius: 'var(--radius)',
          background: 'var(--bg)', border: '1px solid var(--border-md)', boxShadow: 'var(--shadow-lg)',
          color: 'var(--text)', fontSize: 12.5, fontWeight: 400, lineHeight: 1.45, textAlign: 'left', whiteSpace: 'normal',
          cursor: 'default',
        }} onClick={e => e.stopPropagation()}>
          {children}
        </span>
      )}
    </span>
  );
}
