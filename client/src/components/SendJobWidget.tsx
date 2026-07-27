// Port of the send-job widget (_sjw*) from js/app.js.
// Floats bottom-right on every page except the step3 send screen (which has its own log).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { API_BASE, type SendJob } from '../lib/api';
import { useToast } from '../context/ToastContext';

const fmtTime = (ms: number) => {
  if (ms <= 0) return 'finishing…';
  const totalMins = Math.round(ms / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hrs > 0 ? `~${hrs}h ${mins}m` : `~${mins}m`;
};

export default function SendJobWidget() {
  const location = useLocation();
  const toast = useToast();
  const [job, setJob] = useState<SendJob | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isStep3 = location.pathname.startsWith('/send/step3');

  const stopPolling = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const dismiss = useCallback(() => {
    stopPolling();
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
    jobIdRef.current = null;
    setJob(null);
  }, [stopPolling]);

  const poll = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${id}`);
      if (!res.ok) return;
      const j: SendJob = await res.json();
      setJob(j);

      const allItemsDone = j.items.length > 0 && j.items.every(i => i.status !== 'pending');
      const effectivelyDone = j.status === 'done' || j.status === 'cancelled' || (j.status === 'processing' && allItemsDone);
      if (effectivelyDone) {
        if (j.status === 'processing' && allItemsDone) {
          fetch(`${API_BASE}/api/jobs/${id}/repair`, { method: 'POST' }).catch(() => {});
        }
        stopPolling();
        if (!dismissTimerRef.current) dismissTimerRef.current = setTimeout(dismiss, 8000);
      }
    } catch { /* transient */ }
  }, [dismiss, stopPolling]);

  const track = useCallback((id: string) => {
    if (jobIdRef.current) return;
    jobIdRef.current = id;
    if (!timerRef.current) timerRef.current = setInterval(poll, 3000);
    poll();
  }, [poll]);

  // Auto-detect an active job on mount (DB is the source of truth)
  useEffect(() => {
    if (isStep3) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/jobs/active`);
        if (!res.ok) return;
        const j = await res.json();
        if (j && !cancelled) track(j.id);
      } catch { /* no active job */ }
    })();
    return () => { cancelled = true; };
  }, [isStep3, track]);

  useEffect(() => () => { stopPolling(); if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current); }, [stopPolling]);

  const close = async () => {
    const id = jobIdRef.current;
    dismiss();
    if (!id) return;
    try { await fetch(`${API_BASE}/api/jobs/${id}/cancel`, { method: 'POST' }); } catch { /* best-effort */ }
  };

  const togglePause = async () => {
    const id = jobIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${id}`);
      if (!res.ok) return;
      const j: SendJob = await res.json();
      const action = j.status === 'paused' ? 'resume' : 'pause';
      const actionRes = await fetch(`${API_BASE}/api/jobs/${id}/${action}`, { method: 'POST' });
      if (!actionRes.ok) {
        const err = await actionRes.json();
        if (err.error === 'credentials_missing') {
          dismiss();
          toast('Gmail credentials expired for this job. Use the "Resume sending" button on the dashboard.', 'error', 7000);
          return;
        }
      }
      poll();
    } catch { /* transient */ }
  };

  if (isStep3 || !job) return null;

  const total = job.items.length;
  const sent = job.items.filter(i => i.status === 'sent').length;
  const failed = job.items.filter(i => i.status === 'failed').length;
  const skipped = job.items.filter(i => i.status === 'skipped').length;
  const done = sent + failed + skipped;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const allItemsDone = total > 0 && job.items.every(i => i.status !== 'pending');
  const effectivelyDone = job.status === 'done' || job.status === 'cancelled' || (job.status === 'processing' && allItemsDone);

  let title: React.ReactNode;
  let showPause = false;
  let pauseIcon = 'ti-player-pause';
  if (effectivelyDone) {
    title = <><i className="ti ti-circle-check" /> {sent} sent{failed ? `, ${failed} failed` : ''}{skipped ? `, ${skipped} skipped` : ''}</>;
  } else if (job.sendMode === 'drip') {
    const remaining = job.items.filter(i => i.status === 'pending').length;
    const delayMs = Math.round(3_600_000 / (job.ratePerHour || 5));
    title = <><i className="ti ti-clock" /> Drip — {fmtTime(Math.max(0, (remaining - 1) * delayMs))} left</>;
  } else if (job.status === 'paused') {
    title = <><i className="ti ti-player-pause" /> Paused</>;
    showPause = true; pauseIcon = 'ti-player-play';
  } else {
    title = <><i className="ti ti-send" /> Sending emails…</>;
    showPause = true;
  }

  return (
    <div id="send-job-widget">
      <div id="sjw-header">
        <span id="sjw-title">{title}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {showPause && (
            <button className="btn btn-xs" onClick={togglePause} type="button">
              <i className={`ti ${pauseIcon}`} />
            </button>
          )}
          <button className="btn btn-xs" onClick={() => setCollapsed(c => !c)} title="Minimise" type="button"><i className="ti ti-minus" /></button>
          <button className="btn btn-xs" onClick={close} title="Dismiss" type="button"><i className="ti ti-x" /></button>
        </div>
      </div>
      <div id="sjw-body" className={collapsed ? 'collapsed' : ''}>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
        <div id="sjw-stats" style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
          {done}/{total} · {failed > 0 ? `${failed} failed` : 'all good'}
        </div>
      </div>
    </div>
  );
}
