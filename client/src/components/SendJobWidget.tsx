// Port of the send-job widget (_sjw*) from js/app.js.
// Floats bottom-right on every page except the step3 send screen (which has its own log).
// Tracks EVERY in-flight job, not just the newest: overlapping drips/batches run
// concurrently, and a single-job widget silently hid all but the most recent one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { API_BASE, type SendJob } from '../lib/api';
import { useToast } from '../context/ToastContext';

const MAX_CARDS = 4;      // beyond this, collapse the rest into a "+N more" line
const DISMISS_MS = 8000;  // how long a finished job stays visible

const fmtTime = (ms: number) => {
  if (ms <= 0) return 'finishing…';
  const totalMins = Math.round(ms / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hrs > 0 ? `~${hrs}h ${mins}m` : `~${mins}m`;
};

const isEffectivelyDone = (j: SendJob) => {
  const allItemsDone = j.items.length > 0 && j.items.every(i => i.status !== 'pending');
  return j.status === 'done' || j.status === 'cancelled' || (j.status === 'processing' && allItemsDone);
};

export default function SendJobWidget() {
  const location = useLocation();
  const toast = useToast();
  const [jobs, setJobs] = useState<SendJob[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const dismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isStep3 = location.pathname.startsWith('/send/step3');

  const forget = useCallback((id: string) => {
    const t = dismissTimers.current.get(id);
    if (t) { clearTimeout(t); dismissTimers.current.delete(id); }
    setJobs(prev => prev.filter(j => j.id !== id));
  }, []);

  // A job that dropped off /active-all has finished (or was cancelled). Fetch its
  // final state once so the card can show the outcome, then retire it.
  const finalize = useCallback(async (id: string) => {
    if (dismissTimers.current.has(id)) return; // already retiring
    dismissTimers.current.set(id, setTimeout(() => forget(id), DISMISS_MS));
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${id}`);
      if (!res.ok) return;
      const j: SendJob = await res.json();
      setJobs(prev => prev.map(p => (p.id === id ? j : p)));
      if (j.status === 'processing' && j.items.every(i => i.status !== 'pending')) {
        fetch(`${API_BASE}/api/jobs/${id}/repair`, { method: 'POST' }).catch(() => {});
      }
    } catch { /* transient — the dismiss timer still fires */ }
  }, [forget]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/jobs/active-all`);
      if (!res.ok) return;
      const active: SendJob[] = await res.json();
      const activeIds = new Set(active.map(j => j.id));

      setJobs(prev => {
        // Keep cards for jobs that just finished so their result stays on screen.
        const retiring = prev.filter(p => !activeIds.has(p.id));
        retiring.forEach(p => finalize(p.id));
        const merged = [...active, ...retiring.filter(p => !activeIds.has(p.id))];
        return merged.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      });
    } catch { /* transient */ }
  }, [finalize]);

  useEffect(() => {
    if (isStep3) return;
    poll();
    timerRef.current = setInterval(poll, 3000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [isStep3, poll]);

  useEffect(() => {
    const timers = dismissTimers.current;
    return () => { timers.forEach(t => clearTimeout(t)); timers.clear(); };
  }, []);

  const close = async (id: string) => {
    forget(id);
    try { await fetch(`${API_BASE}/api/jobs/${id}/cancel`, { method: 'POST' }); } catch { /* best-effort */ }
  };

  const togglePause = async (job: SendJob) => {
    const action = job.status === 'paused' ? 'resume' : 'pause';
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${job.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        if (err.error === 'credentials_missing') {
          forget(job.id);
          toast('Gmail credentials expired for this job. Use the "Resume sending" button on the dashboard.', 'error', 7000);
          return;
        }
      }
      poll();
    } catch { /* transient */ }
  };

  if (isStep3 || jobs.length === 0) return null;

  const visible = jobs.slice(0, MAX_CARDS);
  const hidden = jobs.length - visible.length;

  return (
    <div id="send-job-widget">
      {hidden > 0 && <div className="sjw-more">+{hidden} more job{hidden > 1 ? 's' : ''} running</div>}
      {visible.map(job => {
        const total = job.items.length;
        const sent = job.items.filter(i => i.status === 'sent').length;
        const failed = job.items.filter(i => i.status === 'failed').length;
        const skipped = job.items.filter(i => i.status === 'skipped').length;
        const done = sent + failed + skipped;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        let title: React.ReactNode;
        let showPause = false;
        let pauseIcon = 'ti-player-pause';
        if (isEffectivelyDone(job)) {
          title = <><i className="ti ti-circle-check" /> {sent} sent{failed ? `, ${failed} failed` : ''}{skipped ? `, ${skipped} skipped` : ''}</>;
        } else if (job.sendMode === 'drip') {
          const remaining = job.items.filter(i => i.status === 'pending').length;
          const delayMs = Math.round(3_600_000 / (job.ratePerHour || 5));
          title = <><i className="ti ti-clock" /> Drip {total} · {fmtTime(Math.max(0, (remaining - 1) * delayMs))} left</>;
        } else if (job.status === 'paused') {
          title = <><i className="ti ti-player-pause" /> Paused</>;
          showPause = true; pauseIcon = 'ti-player-play';
        } else {
          title = <><i className="ti ti-send" /> Sending {total} email{total > 1 ? 's' : ''}…</>;
          showPause = true;
        }

        return (
          <div className="sjw-card" key={job.id}>
            <div className="sjw-header">
              <span>{title}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {showPause && (
                  <button className="btn btn-xs" onClick={() => togglePause(job)} type="button">
                    <i className={`ti ${pauseIcon}`} />
                  </button>
                )}
                <button className="btn btn-xs" onClick={() => setCollapsed(c => !c)} title="Minimise" type="button"><i className="ti ti-minus" /></button>
                <button className="btn btn-xs" onClick={() => close(job.id)} title="Cancel job" type="button"><i className="ti ti-x" /></button>
              </div>
            </div>
            <div className={`sjw-body${collapsed ? ' collapsed' : ''}`}>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
                {done}/{total} · {failed > 0 ? `${failed} failed` : done > 0 ? 'all good' : 'starting…'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
