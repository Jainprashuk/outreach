// The notification feed, loaded once and shared: the bell badge and its dropdown read this
// one copy. Same polling rules as the action queue — every few minutes, never while the
// tab is hidden, and a catch-up load as soon as a tab that missed a tick comes back.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { loadNotificationsApi, markNotificationsReadApi, type AppNotification } from '../lib/api';
import { useSession } from './SessionContext';

const REFRESH_MS = 3 * 60 * 1000;

interface NotificationStore {
  items: AppNotification[];
  unread: number;
  /** An unread error is waiting — the bell turns red. */
  hasUnreadError: boolean;
  loaded: boolean;
  reload: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationStore | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { owner, loading: sessionLoading } = useSession();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadErrors, setUnreadErrors] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const lastLoadAt = useRef(0);
  const reload = useCallback(async () => {
    lastLoadAt.current = Date.now();
    const feed = await loadNotificationsApi();
    setItems(feed.items);
    setUnread(feed.unread);
    setUnreadErrors(feed.unreadErrors);
    setLoaded(true);
  }, []);

  const enabled = !sessionLoading && !!owner;

  useEffect(() => {
    if (!enabled) return;
    const visible = () => document.visibilityState === 'visible';
    reload().catch(() => {});
    const t = setInterval(() => { if (visible()) reload().catch(() => {}); }, REFRESH_MS);
    const onVisibility = () => {
      if (visible() && Date.now() - lastLoadAt.current >= REFRESH_MS) reload().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, reload]);

  const markRead = useCallback(async (ids: string[]) => {
    const fresh = items.filter(n => ids.includes(n.id) && !n.read);
    if (fresh.length === 0) return;
    // Optimistic: the dot goes away on click; a failed request just reappears on the next load.
    setItems(prev => prev.map(n => (ids.includes(n.id) ? { ...n, read: true } : n)));
    setUnread(u => Math.max(0, u - fresh.length));
    setUnreadErrors(u => Math.max(0, u - fresh.filter(n => n.severity === 'error').length));
    try { await markNotificationsReadApi({ ids }); } catch { reload().catch(() => {}); }
  }, [items, reload]);

  const markAllRead = useCallback(async () => {
    setItems(prev => prev.map(n => ({ ...n, read: true })));
    setUnread(0);
    setUnreadErrors(0);
    try { await markNotificationsReadApi({ all: true }); } catch { reload().catch(() => {}); }
  }, [reload]);

  const store = useMemo<NotificationStore>(() => ({
    items, unread, hasUnreadError: unreadErrors > 0, loaded, reload, markRead, markAllRead,
  }), [items, unread, unreadErrors, loaded, reload, markRead, markAllRead]);

  return <NotificationContext.Provider value={store}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
