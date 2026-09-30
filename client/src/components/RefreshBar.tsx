import { useEffect, useState, type ReactNode } from 'react';

/**
 * True only once `active` has stayed true for `delayMs` — so a fast response
 * never flashes a loader, and a slow one always gets one.
 */
export function useDelayedFlag(active: boolean, delayMs = 150) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return shown;
}

/**
 * The loading treatment for a list that already has rows on screen and is
 * fetching new ones (a filter, sort, tab or page change): a thin sweep along
 * the top, and the stale rows dimmed until the new ones land. First loads use
 * skeletons instead — this is for REfreshes.
 *
 * The bar always takes its 2px, so starting and stopping never shifts layout.
 */
export function RefreshBar({ active }: { active: boolean }) {
  const shown = useDelayedFlag(active);
  return (
    <div className={`refresh-bar${shown ? ' on' : ''}`} role="progressbar" aria-hidden={!shown} aria-label="Loading">
      <div className="refresh-bar-fill" />
    </div>
  );
}

/** Wraps a list: dims it and marks it busy while `active` (after the same delay). */
export function Refreshing({ active, children, className = '', style }: {
  active: boolean; children: ReactNode; className?: string; style?: React.CSSProperties;
}) {
  const shown = useDelayedFlag(active);
  return (
    <div className={`refreshing-wrap${shown ? ' is-refreshing' : ''}${className ? ` ${className}` : ''}`}
      aria-busy={active} style={style}>
      {children}
    </div>
  );
}

/** A count badge's number, or a small spinner while it is being recounted. */
export function CountOrSpinner({ loading, children }: { loading: boolean; children: ReactNode }) {
  const shown = useDelayedFlag(loading);
  return shown ? <><i className="ti ti-loader" aria-hidden="true" /> {children}</> : <>{children}</>;
}
