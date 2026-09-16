import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  scrapeStatusApi, queueScrapeApi, cancelScrapeApi, updateScrapeScheduleApi,
  type ScrapeStatus, type ScrapeRun,
} from '../../lib/api';
import { useToast } from '../../context/ToastContext';

// Harvesting runs on a worker on the Mac — `jl harvest` drives a real logged-in
// Chrome over CDP and cannot run on Vercel. So the button always QUEUES; the
// only question is whether a worker is awake to pick the job up now or later.
// That distinction has to be visible before you click, not discovered after.

const POLL_MS = 3000;
const MAX_QUERIES = 20;   // MAX_SEARCHES in scroll_harvest.py — the cap is deliberate
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

function elapsed(since: string | null): string {
  if (!since) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  return m < 1 ? `${secs}s` : `${m}m ${secs % 60}s`;
}

type Readiness = {
  tone: 'ok' | 'warn' | 'idle';
  icon: string;
  text: string;
  /** What the primary button should say — queueing stays possible when offline. */
  verb: string;
};

// Never a generic "offline": each state has a different fix, and saying which
// one is the whole point of the strip.
function readiness(s: ScrapeStatus): Readiness {
  const { worker, nextOccurrence } = s;
  if (!worker.everSeen) {
    return { tone: 'idle', icon: 'ti-plug-connected-x', verb: 'Queue scrape',
      text: 'Worker has never checked in. Run `npm run scrape-worker` on your Mac.' };
  }
  if (!worker.online) {
    const when = worker.nextWakeAt
      ? `at the next wake, ${fmtTime(worker.nextWakeAt)}`
      : 'when you next open your Mac';
    return { tone: 'idle', icon: 'ti-zzz', verb: 'Queue scrape',
      text: `Your Mac is asleep. This will be queued and run ${when}.` };
  }
  if (!worker.linkedinLoggedIn) {
    return { tone: 'warn', icon: 'ti-lock', verb: 'Queue scrape',
      text: 'Worker is up but LinkedIn is logged out. Log in inside the debug Chrome window.' };
  }
  if (!worker.chromeUp) {
    return { tone: 'warn', icon: 'ti-browser', verb: 'Scrape now',
      text: 'Chrome is not running — the worker will launch it automatically.' };
  }
  return { tone: 'ok', icon: 'ti-circle-check', verb: 'Scrape now',
    text: nextOccurrence ? `Ready — runs immediately. Next scheduled run ${fmtTime(nextOccurrence)}.` : 'Ready — runs immediately.' };
}

function RunReport({ run }: { run: ScrapeRun }) {
  if (run.status === 'done') {
    const r = run.importResult;
    return (
      <div className="info-box" style={{ marginTop: 12 }}>
        <i className="ti ti-circle-check" />
        <span>
          <strong>{run.stats.new} new</strong> from {run.stats.hiring} hiring posts
          {' '}across {run.stats.searches} searches — <strong>{r.created} imported</strong>
          {r.skipped > 0 && `, ${r.skipped} already known`}
          {r.updated > 0 && `, ${r.updated} updated`}.
        </span>
      </div>
    );
  }
  if (run.status === 'failed') {
    return (
      <div className="info-box" style={{ marginTop: 12, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
        <i className="ti ti-alert-triangle" />
        <span><strong>Last run failed.</strong> {run.error}</span>
      </div>
    );
  }
  return null;
}

export default function ScrapePanel({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ScrapeStatus | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adhoc, setAdhoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [, forceTick] = useState(0);

  // Refresh the leads table exactly once, on the transition out of a run —
  // polling the list every 3s alongside this would be wasteful.
  const prevActive = useRef<string | null>(null);

  // The parent re-creates onImported on every render. Holding it in a ref keeps
  // `load` stable, so the poll effect below mounts one interval instead of
  // tearing it down and re-fetching on every state update.
  const onImportedRef = useRef(onImported);
  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  const load = useCallback(async () => {
    try {
      const s = await scrapeStatusApi();
      setStatus(s);
      const activeId = s.activeRun?.id ?? null;
      if (prevActive.current && !activeId) onImportedRef.current();
      prevActive.current = activeId;
      setPicked(prev => {
        if (prev.size > 0) return prev;
        return new Set(s.schedule.queries.length ? s.schedule.queries : s.defaultQueries.slice(0, MAX_QUERIES));
      });
    } catch { /* a transient poll failure shouldn't blank the panel */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Drive the elapsed-time readout without re-fetching.
  useEffect(() => {
    if (!status?.activeRun) return;
    const t = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [status?.activeRun?.id]);

  const blockedUntil = status?.blockedUntil ?? null;
  const ready = useMemo(() => (status ? readiness(status) : null), [status]);
  const active = status?.activeRun ?? null;

  const queries = useMemo(() => {
    const extra = adhoc.split(',').map(q => q.trim()).filter(Boolean);
    return [...new Set([...picked, ...extra])];
  }, [picked, adhoc]);

  const toggle = (q: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else if (next.size < MAX_QUERIES) next.add(q);
      else toast(`That's the cap — ${MAX_QUERIES} searches per run.`, 'error');
      return next;
    });

  const submit = async () => {
    if (queries.length === 0) return toast('Pick at least one query', 'error');
    setBusy(true);
    try {
      await queueScrapeApi(queries.slice(0, MAX_QUERIES));
      // Repeat the asleep warning here — if the Mac is shut, a silent "queued"
      // toast reads like nothing happened.
      toast(status && !status.worker.online
        ? 'Queued. Your Mac is asleep, so it will run when it next wakes.'
        : 'Scrape started.', 'success');
      await load();
    } catch (err: any) {
      toast(err.message || 'Could not queue the scrape', 'error');
    } finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    try { await cancelScrapeApi(id); toast('Cancelled', 'success'); await load(); }
    catch (err: any) { toast(err.message, 'error'); }
  };

  const saveSchedule = async (patch: Parameters<typeof updateScrapeScheduleApi>[0]) => {
    try {
      const r = await updateScrapeScheduleApi(patch);
      setStatus(s => (s ? { ...s, schedule: r.schedule, nextOccurrence: r.nextOccurrence } : s));
      toast('Schedule saved', 'success');
    } catch (err: any) { toast(err.message, 'error'); }
  };

  if (!status || !ready) return null;
  const sch = status.schedule;

  return (
    <div className="section" style={{ marginBottom: 18 }}>
      <div className="section-head">
        <span className="section-title">Scrape LinkedIn</span>
        <button className="btn btn-xs" type="button" onClick={() => setShowSchedule(v => !v)}>
          <i className="ti ti-clock" /> {showSchedule ? 'Hide schedule' : 'Schedule'}
        </button>
      </div>

      {blockedUntil ? (
        <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
          <i className="ti ti-hand-stop" />
          <span>
            <strong>Harvesting is paused until {fmtDate(blockedUntil)}.</strong>{' '}
            {status.blockedReason || 'LinkedIn showed a checkpoint.'} Waiting it out is what keeps the
            account safe — there is deliberately no retry.
          </span>
        </div>
      ) : (
        <>
          <div className="info-box" style={ready.tone === 'warn' ? { background: 'var(--amber-bg)', color: 'var(--amber)' } : undefined}>
            <i className={`ti ${ready.icon}`} />
            <span>{ready.text}</span>
          </div>

          {active ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <strong>
                  {active.status === 'queued' ? 'Queued' : 'Harvesting'}
                  {active.trigger === 'scheduled' && ' (scheduled)'}
                </strong>
                <span className="page-info">
                  {active.queries.length} {active.queries.length === 1 ? 'search' : 'searches'}
                  {active.status === 'running' && ` · ${elapsed(active.claimedAt)} elapsed`}
                </span>
                {active.status === 'queued' && (
                  <button className="btn btn-xs" type="button" onClick={() => cancel(active.id)}>Cancel</button>
                )}
              </div>
              {/* jl reports only at the end, so there is no honest percentage to show. */}
              <div className="progress-bar"><div className="progress-fill progress-indeterminate" /></div>
              <div className="page-info" style={{ marginTop: 6 }}>
                Usually 10–20 minutes. Leave the Chrome window open and visible.
              </div>
            </div>
          ) : (
            <>
              <div style={{ margin: '14px 0 8px', display: 'flex', justifyContent: 'space-between' }}>
                <strong>Searches</strong>
                <span className="page-info">{queries.length} / {MAX_QUERIES} selected</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {status.defaultQueries.map(q => (
                  <label key={q} className="contact-chip" style={{ cursor: 'pointer', opacity: picked.has(q) ? 1 : 0.55 }}>
                    <input type="checkbox" checked={picked.has(q)} onChange={() => toggle(q)}
                      style={{ marginRight: 6 }} />
                    {q}
                  </label>
                ))}
                {status.defaultQueries.length === 0 && (
                  <span className="page-info">
                    No saved searches yet — the worker reports these from the scraper's config.json.
                  </span>
                )}
              </div>
              <input type="text" style={{ marginTop: 10, width: '100%' }} value={adhoc}
                onChange={e => setAdhoc(e.target.value)}
                placeholder="Extra searches for this run, comma separated" />

              <div className="step-footer" style={{ marginTop: 14 }}>
                <button className="btn btn-primary" type="button" disabled={busy || queries.length === 0}
                  onClick={submit}>
                  <i className="ti ti-brand-linkedin" /> {busy ? 'Queueing…' : ready.verb}
                </button>
              </div>
            </>
          )}

          {!active && status.lastRun && <RunReport run={status.lastRun} />}
        </>
      )}

      {showSchedule && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <input type="checkbox" checked={sch.enabled}
              onChange={e => saveSchedule({ enabled: e.target.checked, queries: [...picked] })} />
            <strong>Run automatically</strong>
            {sch.enabled && status.nextOccurrence && (
              <span className="page-info">Next: {fmtTime(status.nextOccurrence)}</span>
            )}
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="time" value={sch.time} style={{ width: 130 }}
              onChange={e => saveSchedule({ time: e.target.value })} />
            {DAY_LABELS.map((d, i) => (
              <button key={d} type="button"
                className={`btn btn-xs${sch.days.includes(i) ? ' btn-primary' : ''}`}
                onClick={() => {
                  const next = sch.days.includes(i) ? sch.days.filter(x => x !== i) : [...sch.days, i].sort();
                  if (next.length) saveSchedule({ days: next });
                }}>
                {d}
              </button>
            ))}
          </div>

          <div className="page-info" style={{ marginTop: 10 }}>
            Runs at {sch.time} {sch.timezone}, using the searches ticked above. One run a day is the
            safe ceiling — the scraper's own caps assume an attended run, and over-running is what
            gets a LinkedIn account restricted.
          </div>

          {sch.enabled && !status.worker.nextWakeAt && (
            <div className="info-box" style={{ marginTop: 10, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
              <i className="ti ti-zzz" />
              <span>
                Your Mac has no scheduled wake, so this only fires if it happens to be awake.
                To wake it automatically — <strong>with the lid open</strong>, or it wakes dark and
                harvests nothing — run:
                <code style={{ display: 'block', marginTop: 6 }}>
                  sudo pmset repeat wakeorpoweron MTWRFSU {sch.time.replace(/:(\d+)$/, (_m, m2) =>
                    ':' + String(Math.max(0, Number(m2) - 5)).padStart(2, '0'))}:00
                </code>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
