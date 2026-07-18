import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_BASE } from '../lib/api';

interface Session {
  owner: boolean;
  share: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState(false);
  const [share, setShare] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/share/session`);
      const data = await res.json();
      setOwner(!!data.owner);
      setShare(!!data.share);
    } catch {
      setOwner(false);
      setShare(false);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<Session>(() => ({ owner, share, loading, refresh }), [owner, share, loading, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
