// One cheap "has anything changed?" poll (GET /api/pulse) for the parts of the app
// that are on every page all day: the send-job widget, the notification bell and the
// action queue. Each used to poll its own endpoint on its own timer; now they refetch
// only when their stamp here moves, plus a slow safety refetch of their own.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/api';
import { useSession } from './SessionContext';
import { useVisibleInterval } from '../hooks/useVisibleInterval';

const PULSE_MS = 30_000;

/** Opaque stamps (routes/pulse.js): compare for equality, never parse for meaning. */
export interface Pulse {
  /** "<active count>:<latest updatedAt>" of the in-flight send jobs. */
  jobs: string;
  notifications: string;
  mailbox: string;
  /** Worker runs (LinkedIn harvest, job platforms): active ones and the newest finish. */
  runs?: string;
}

const PulseContext = createContext<Pulse | null>(null);

export function PulseProvider({ children }: { children: ReactNode }) {
  const { owner, loading: sessionLoading } = useSession();
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const load = () => apiFetch<Pulse>('/api/pulse').then(setPulse).catch(() => { /* next tick */ });
  useVisibleInterval(load, PULSE_MS, !sessionLoading && !!owner);
  return <PulseContext.Provider value={pulse}>{children}</PulseContext.Provider>;
}

/**
 * Calls `fn` when `select(pulse)` changes. Not on the first pulse: every consumer
 * already loads on mount, so the first stamp is only the baseline.
 */
export function usePulseChange(select: (p: Pulse) => string, fn: () => unknown, enabled = true) {
  const pulse = useContext(PulseContext);
  const value = pulse ? select(pulse) : null;
  const prev = useRef<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (value === null) return;
    if (enabled && prev.current !== null && prev.current !== value) fnRef.current();
    prev.current = value;
  }, [value, enabled]);
}
