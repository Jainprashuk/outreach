import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCampaignApi, type CampaignDetail } from '../lib/api';

// 10s, not the 3s SendJobWidget uses. A campaign changes state on a per-hour
// cadence; the only fast-moving thing is the in-flight SendJob, which the widget
// is already polling and already renders. There is no reason to triple the
// request rate for a progress bar that advances once every few minutes.
const BASE_MS = 10_000;
// A paused or between-batches campaign is nearly free to watch at this rate.
const IDLE_MS = 30_000;
const IDLE_AFTER_UNCHANGED = 5;

export function useCampaignPoll(id: string | null) {
  const [data, setData] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const unchangedRef = useRef(0);
  const lastStampRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    if (!id) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const next = await loadCampaignApi(id);
      if (ac.signal.aborted || !aliveRef.current) return;
      // Backoff is driven by whether anything actually moved, not by elapsed time.
      const stamp = `${next.campaign.updatedAt}|${next.campaign.stats?.released}`;
      unchangedRef.current = stamp === lastStampRef.current ? unchangedRef.current + 1 : 0;
      lastStampRef.current = stamp;
      setData(next);
      setError('');
      setLastUpdated(Date.now());
    } catch (err) {
      if (ac.signal.aborted || !aliveRef.current) return;
      // Keep the last good data on screen. Blanking the page on one dropped tick
      // is worse than showing slightly stale numbers with a note saying so.
      setError((err as Error).message || 'Could not refresh');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [id]);

  /** Force an immediate refresh — every mutation calls this rather than waiting. */
  const refresh = useCallback(async () => { await fetchOnce(); }, [fetchOnce]);

  useEffect(() => {
    aliveRef.current = true;
    if (!id) { setData(null); setLoading(false); return; }

    setLoading(true);
    unchangedRef.current = 0;
    lastStampRef.current = '';

    const tick = async () => {
      // A tab left open overnight would otherwise fire 8,640 pointless requests.
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        await fetchOnce();
      }
      if (!aliveRef.current) return;
      const delay = unchangedRef.current >= IDLE_AFTER_UNCHANGED ? IDLE_MS : BASE_MS;
      timerRef.current = setTimeout(tick, delay);
    };
    tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [id, fetchOnce]);

  return { data, loading, error, refresh, lastUpdated };
}
