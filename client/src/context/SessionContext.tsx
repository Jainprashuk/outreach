import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_BASE } from '../lib/api';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Can see the fleet-wide admin dashboard. A DISPLAY gate only — routes/admin.js
   *  re-checks this server-side, and that is the real boundary. */
  isAdmin: boolean;
  /** Has finished first-run setup. */
  onboarded: boolean;
}

interface Session {
  /** Signed in as a real account. Named `owner` for continuity with the
   *  single-owner era, when it meant "knows the shared password". */
  owner: boolean;
  share: boolean;
  user: SessionUser | null;
  isAdmin: boolean;
  /** Whether to send someone to the wizard. Defaults to TRUE when the field is
   *  missing, so a session payload that predates onboarding (or a partial
   *  failure) does not trap every user in a wizard they do not need. The server
   *  send-guard is what actually protects anything. */
  onboarded: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState(false);
  const [share, setShare] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/share/session`);
      const data = await res.json();
      setOwner(!!data.owner);
      setShare(!!data.share);
      setUser(data.user ?? null);
    } catch {
      setOwner(false);
      setShare(false);
      setUser(null);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
    } finally {
      // Per-viewer UI state is not namespaced by account, so it must not survive
      // a sign-out into the next person's session on a shared browser.
      try { localStorage.removeItem('activeJobId'); } catch { /* blocked storage */ }
      window.location.href = '/login';
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<Session>(
    () => ({
      owner,
      share,
      user,
      isAdmin: user?.isAdmin === true,
      onboarded: user ? user.onboarded !== false : true,
      loading,
      refresh,
      logout,
    }),
    [owner, share, user, loading, refresh, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
