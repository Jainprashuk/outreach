// The Needs you queue, loaded once and shared: the Mailbox tabs, the Mailbox badge in the
// sidebar and the Dashboard card all read this one copy, so they can't show different numbers.
//
// It reloads whenever the contacts list changes (a mailbox check, a category change, a
// reply marked read) and every few minutes, because an item can come back to Needs you
// just by time passing — a 7-day wait running out needs no event on the server.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import {
  bulkActionApi, loadActionQueueApi,
  type ActionBucket, type ActionItem, type ActionOp,
} from '../lib/api';
import { useApp } from './AppContext';
import { useSession } from './SessionContext';

const REFRESH_MS = 3 * 60 * 1000;
const EMPTY_COUNTS: Record<ActionBucket, number> = { 'needs-you': 0, waiting: 0, snoozed: 0, done: 0 };

interface ActionQueueStore {
  loaded: boolean;
  counts: Record<ActionBucket, number>;
  /** Server order: Needs you most-actionable first, the rest newest first. */
  items: ActionItem[];
  byId: Map<string, ActionItem>;
  reload: () => Promise<void>;
  act: (ids: string[], op: ActionOp, until?: Date) => Promise<number>;
}

const ActionQueueContext = createContext<ActionQueueStore | null>(null);

export function ActionQueueProvider({ children }: { children: ReactNode }) {
  const { owner, loading: sessionLoading } = useSession();
  const app = useApp();
  const [items, setItems] = useState<ActionItem[]>([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const q = await loadActionQueueApi();
    setItems(q.items);
    setCounts({ ...EMPTY_COUNTS, ...q.counts });
    setLoaded(true);
  }, []);

  const enabled = !sessionLoading && !!owner;

  // Share/unauthenticated visitors would just get a 401 here, so don't ask.
  useEffect(() => {
    if (!enabled) return;
    reload().catch(() => {});
    const t = setInterval(() => reload().catch(() => {}), REFRESH_MS);
    return () => clearInterval(t);
  }, [enabled, reload]);

  // Coalesced: marking several replies read in a row is one reload, not one each.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !app.loaded) return;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => reload().catch(() => {}), 400);
    return () => { if (pending.current) clearTimeout(pending.current); };
  }, [app.contacts, app.loaded, enabled, reload]);

  const store = useMemo<ActionQueueStore>(() => ({
    loaded, counts, items,
    byId: new Map(items.map(i => [i.id, i])),
    reload,
    async act(ids, op, until) {
      const { updated } = await bulkActionApi(ids, op, until?.toISOString());
      await reload();
      return updated;
    },
  }), [loaded, counts, items, reload]);

  return <ActionQueueContext.Provider value={store}>{children}</ActionQueueContext.Provider>;
}

export function useActionQueue() {
  const ctx = useContext(ActionQueueContext);
  if (!ctx) throw new Error('useActionQueue must be used within ActionQueueProvider');
  return ctx;
}
