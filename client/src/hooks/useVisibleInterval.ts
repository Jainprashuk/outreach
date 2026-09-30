import { useEffect, useRef } from 'react';

/**
 * setInterval that skips ticks while the browser tab is hidden, and fires once
 * the moment it becomes visible again — so what is on screen is never staler
 * than it would have been with a plain interval. Runs `fn` once on mount.
 *
 * A tab left open overnight on a 3s poll is ~29,000 requests nobody reads.
 */
export function useVisibleInterval(fn: () => unknown, ms: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const run = () => { fnRef.current(); };

    run();
    const timer = setInterval(() => { if (visible()) run(); }, ms);
    const onVisibility = () => { if (visible()) run(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, enabled]);
}
