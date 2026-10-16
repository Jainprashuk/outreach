import { useVisibleInterval } from './useVisibleInterval';

/**
 * useVisibleInterval at one of two rates: `fastMs` while something is actually
 * moving (a run in progress), `slowMs` otherwise. A page left open on a 3s poll
 * with nothing running is ~1,200 requests an hour that change nothing.
 *
 * Switching rate fires once straight away (useVisibleInterval runs on (re)start),
 * so the page never waits a whole slow tick to notice it should speed up.
 */
export function useAdaptiveInterval(
  fn: () => unknown,
  { fastMs, slowMs, fast, enabled = true }: { fastMs: number; slowMs: number; fast: boolean; enabled?: boolean },
) {
  useVisibleInterval(fn, fast ? fastMs : slowMs, enabled);
}
