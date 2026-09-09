import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import {
  createInterviewApi, deleteInterviewApi, deleteInterviewFileApi, loadInterviewsApi,
  markInterviewFollowedUpApi, updateInterviewApi, uploadInterviewFileApi,
  type Interview, type InterviewFileKind, type InterviewPatch, type InterviewSource,
} from '../lib/api';
import { collectReminders, type ReminderSet } from '../lib/interviews';
import { useSession } from './SessionContext';

interface InterviewStore {
  interviews: Interview[];
  loaded: boolean;
  error: string;
  reload: () => Promise<Interview[]>;
  create: (body: InterviewPatch & { sourceType: InterviewSource; sourceId?: string | null }) => Promise<Interview>;
  update: (id: string, patch: InterviewPatch) => Promise<Interview>;
  markFollowedUp: (id: string, note?: string) => Promise<Interview>;
  remove: (id: string) => Promise<void>;
  uploadFile: (id: string, kind: InterviewFileKind, file: File) => Promise<Interview>;
  removeFile: (id: string, kind: InterviewFileKind) => Promise<Interview>;
  /** The record tracking this contact/lead row, if any — drives the source badges. */
  forSource: (sourceType: InterviewSource, sourceId: string) => Interview | null;
  reminders: ReminderSet;
  /** The popup is showing right now. */
  remindersOpen: boolean;
  dismissReminders: () => void;
  openReminders: () => void;
}

const InterviewContext = createContext<InterviewStore | null>(null);

export function InterviewProvider({ children }: { children: ReactNode }) {
  const { owner, loading: sessionLoading } = useSession();
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // Reset only by a fresh document load, never by client-side navigation — which
  // is exactly "shows on every page load until acted on" in a single-page app.
  const [dismissed, setDismissed] = useState(false);

  const reload = useCallback(async () => {
    const rows = await loadInterviewsApi();
    setInterviews(rows);
    return rows;
  }, []);

  // Share/unauthenticated visitors would just get a 401 here, so don't ask.
  useEffect(() => {
    if (sessionLoading || !owner) return;
    reload()
      .catch(err => setError(err.message))
      .finally(() => setLoaded(true));
  }, [owner, sessionLoading, reload]);

  // Merge one server response back into the list without a refetch.
  const upsert = useCallback((iv: Interview) => {
    setInterviews(prev => {
      const idx = prev.findIndex(x => x.id === iv.id);
      if (idx === -1) return [iv, ...prev];
      const next = [...prev];
      next[idx] = iv;
      return next;
    });
    return iv;
  }, []);

  // The clock keeps moving while the tab is open, so an interview can become due
  // mid-session. Re-derive every 5 minutes rather than freezing the reminder set
  // at mount time.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const reminders = useMemo(
    () => collectReminders(interviews, new Date(tick)),
    [interviews, tick],
  );

  // Once a reminder pops and you dismiss it, a newly-due interview shouldn't
  // silently re-open the modal mid-task — it waits for the next load.
  const remindersOpen = loaded && !dismissed && (reminders.soon.length > 0 || reminders.stale.length > 0);

  const store = useMemo<InterviewStore>(() => ({
    interviews, loaded, error, reload, reminders, remindersOpen,
    dismissReminders: () => setDismissed(true),
    openReminders: () => setDismissed(false),

    async create(body) {
      const created = await createInterviewApi(body);
      return upsert(created);
    },
    async update(id, patch) {
      return upsert(await updateInterviewApi(id, patch));
    },
    async markFollowedUp(id, note) {
      return upsert(await markInterviewFollowedUpApi(id, note));
    },
    async remove(id) {
      await deleteInterviewApi(id);
      setInterviews(prev => prev.filter(x => x.id !== id));
    },
    async uploadFile(id, kind, file) {
      return upsert(await uploadInterviewFileApi(id, kind, file));
    },
    async removeFile(id, kind) {
      return upsert(await deleteInterviewFileApi(id, kind));
    },
    forSource(sourceType, sourceId) {
      return interviews.find(iv => iv.sourceType === sourceType && iv.sourceId === sourceId) || null;
    },
  }), [interviews, loaded, error, reload, reminders, remindersOpen, upsert]);

  return <InterviewContext.Provider value={store}>{children}</InterviewContext.Provider>;
}

export function useInterviews(): InterviewStore {
  const ctx = useContext(InterviewContext);
  if (!ctx) throw new Error('useInterviews must be used inside InterviewProvider');
  return ctx;
}
