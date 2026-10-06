import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The ⓘ beside a sidebar tab: what that tab is for, on hover (or tap / keyboard
// focus). Rendered into <body> with fixed positioning beside the sidebar — the
// sidebar scrolls, so a tooltip positioned inside it would be clipped at its edge.
export default function NavTip({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const WIDTH = 250;

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // To the right of the sidebar when there's room (desktop); on a narrow screen,
    // where the sidebar is a full-width drawer, just under the icon instead.
    const right = r.right + 14;
    const fits = right + WIDTH + 8 <= window.innerWidth;
    setPos(fits
      ? { top: r.top + r.height / 2, left: right }
      : { top: r.bottom + 30, left: Math.max(8, window.innerWidth - WIDTH - 8) });
  };
  const hide = () => setPos(null);

  return (
    <>
      <span ref={ref} className="nav-tip" tabIndex={0} role="button" aria-label={text}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        // Inside a NavLink: a tap on the ⓘ explains the tab, it doesn't open it.
        onClick={e => { e.preventDefault(); e.stopPropagation(); if (pos) hide(); else show(); }}>
        <i className="ti ti-info-circle" />
      </span>
      {pos && createPortal(
        <div className="nav-tip-body" role="tooltip" style={{ top: pos.top, left: pos.left, width: WIDTH }}>{text}</div>,
        document.body,
      )}
    </>
  );
}
