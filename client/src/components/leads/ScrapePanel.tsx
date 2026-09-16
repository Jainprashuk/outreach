import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  scrapeStatusApi, queueScrapeApi, cancelScrapeApi, updateScrapeScheduleApi, listScrapeRunsApi,
  type ScrapeStatus, type ScrapeRun,
} from '../../lib/api';
import { useToast } from '../../context/ToastContext';

// Harvesting runs on a worker on the Mac — `jl harvest` drives a real logged-in
// Chrome over CDP and cannot run on Vercel. So the button always QUEUES; the
// only question is whether a worker is awake to pick the job up now or later.
// That distinction has to be visible before you click, not discovered after.

const POLL_MS = 3000;
const MAX_QUERIES = 20;   // MAX_SEARCHES in scroll_harvest.py — the cap is deliberate
const HISTORY_LIMIT = 15;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const fmtRunTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

function elapsed(since: string | null): string {
  if (!since) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  return m < 1 ? `${secs}s` : `${m}m ${secs % 60}s`;
}

function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const secs = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  return m < 1 ? `${secs}s` : `${m}m`;
}

type Readiness = { tone: 'ok' | 'warn' | 'idle'; icon: string; text: string; verb: string };

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
    text: nextOccurrence ? `Ready. Next scheduled run ${fmtTime(nextOccurrence)}.` : 'Ready — runs immediately.' };
}

const RUN_BADGE: Record<ScrapeRun['status'], string> = {
  done: 'badge-sent', failed: 'badge-rejected', blocked: 'badge-rejected',
  cancelled: 'badge-closed', queued: 'badge-queued', running: 'badge-pending',
};

function HistoryRow({ run }: { run: ScrapeRun }) {
  const r = run.importResult;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
      padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span className={`badge ${RUN_BADGE[run.status]}`}>{run.status}</span>
      <span style={{ minWidth: 110 }}>{fmtRunTime(run.createdAt)}</span>
      <span className="page-info">
        {run.trigger === 'scheduled' ? 'scheduled' : 'manual'} · {run.queries.length}{' '}
        {run.queries.length === 1 ? 'search' : 'searches'}
        {run.claimedAt && run.finishedAt && ` · ${duration(run.claimedAt, run.finishedAt)}`}
      </span>
      {run.status === 'done' ? (
        <span className="page-info" style={{ marginLeft: 'auto' }}>
          {run.stats.rendered} seen · {run.stats.hiring} hiring ·{' '}
          <strong>{r.created} imported</strong>
          {r.skipped > 0 && ` · ${r.skipped} known`}
        </span>
      ) : run.error ? (
        <span className="page-info" style={{ marginLeft: 'auto', maxWidth: '100%', color: 'var(--red)' }}>
          {run.error.slice(0, 90)}
        </span>
      ) : null}
    </div>
  );
}

export default function ScrapePanel({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ScrapeStatus | null>(null);
  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [primed, setPrimed] = useState(false);
  const [adhoc, setAdhoc] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [, forceTick] = useState(0);

  const prevActive = useRef<string | null>(null);
  const onImportedRef = useRef(onImported);
  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  const loadRuns = useCallback(() => {
    listScrapeRunsApi(1, HISTORY_LIMIT).then(r => setRuns(r.runs)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await scrapeStatusApi();
      setStatus(s);
      const activeId = s.activeRun?.id ?? null;
      // Refresh the leads table and the history once, on the way out of a run.
      if (prevActive.current && !activeId) { onImportedRef.current(); loadRuns(); }
      prevActive.current = activeId;
      setPrimed(p => {
        if (p) return p;
        setPicked(new Set(s.schedule.queries.length ? s.schedule.queries : s.defaultQueries.slice(0, MAX_QUERIES)));
        return true;
      });
    } catch { /* a transient poll failure shouldn't blank the panel */ }
  }, [loadRuns]);

  useEffect(() => { load(); loadRuns(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); },
    [load, loadRuns]);

  useEffect(() => {
    if (!status?.activeRun) return;
    const t = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [status?.activeRun?.id]);

  // What each search actually produced most recently. This is the whole answer
  // to "which of these 20 should I tick?" — without it the list is 20
  // indistinguishable strings and you may as well leave them all on.
  const lastYield = useMemo(() => {
    const map = new Map<string, number>();
    for (const run of runs) {                  // newest first
      for (const q of run.progress?.perQuery || []) {
        if (!map.has(q.query)) map.set(q.query, q.new);
      }
    }
    return map;
  }, [runs]);

  const blockedUntil = status?.blockedUntil ?? null;
  const ready = useMemo(() => (status ? readiness(status) : null), [status]);
  const active = status?.activeRun ?? null;
  const prog = active?.status === 'running' ? active.progress : null;
  const pct = prog && prog.searchesTotal > 0
    ? Math.round((prog.searchesDone / prog.searchesTotal) * 100) : null;

  const extras = useMemo(() => adhoc.split(',').map(q => q.trim()).filter(Boolean), [adhoc]);
  const queries = useMemo(() => [...new Set([...picked, ...extras])], [picked, extras]);

  const catalogue = status?.defaultQueries ?? [];
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f ? catalogue.filter(q => q.toLowerCase().includes(f)) : catalogue;
    // Best-performing first, so the useful ones aren't buried.
    return [...rows].sort((a, b) => (lastYield.get(b) ?? -1) - (lastYield.get(a) ?? -1));
  }, [catalogue, filter, lastYield]);

  const toggle = (q: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else if (next.size + extras.length < MAX_QUERIES) next.add(q);
      else toast(`That's the cap — ${MAX_QUERIES} searches per run.`, 'error');
      return next;
    });

  const selectAll = () => setPicked(new Set(catalogue.slice(0, MAX_QUERIES - extras.length)));
  const clearAll = () => setPicked(new Set());
  const selectBest = () =>
    setPicked(new Set([...catalogue].sort((a, b) => (lastYield.get(b) ?? -1) - (lastYield.get(a) ?? -1))
      .filter(q => (lastYield.get(q) ?? 0) > 0).slice(0, MAX_QUERIES - extras.length)));

  const submit = async () => {
    if (queries.length === 0) return toast('Pick at least one search', 'error');
    setBusy(true);
    try {
      await queueScrapeApi(queries.slice(0, MAX_QUERIES));
      toast(status && !status.worker.online
        ? 'Queued. Your Mac is asleep, so it will run when it next wakes.'
        : 'Scrape started.', 'success');
      setEditing(false);
      await load(); loadRuns();
    } catch (err: any) {
      toast(err.message || 'Could not queue the scrape', 'error');
    } finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    try { await cancelScrapeApi(id); toast('Cancelled', 'success'); await load(); loadRuns(); }
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-xs" type="button" onClick={() => setShowHistory(v => !v)}>
            <i className="ti ti-history" /> History{runs.length ? ` (${runs.length})` : ''}
          </button>
          <button className="btn btn-xs" type="button" onClick={() => setShowSchedule(v => !v)}>
            <i className="ti ti-clock" /> Schedule{sch.enabled ? ' · on' : ''}
          </button>
        </div>
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
          <div className="info-box"
            style={ready.tone === 'warn' ? { background: 'var(--amber-bg)', color: 'var(--amber)' } : undefined}>
            <i className={`ti ${ready.icon}`} />
            <span>{ready.text}</span>
          </div>

          {active ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <strong>
                  {active.status === 'queued' ? 'Queued' : 'Harvesting'}
                  {active.trigger === 'scheduled' && ' (scheduled)'}
                </strong>
                <span className="page-info">
                  {prog && prog.searchesTotal > 0
                    ? `${prog.searchesDone} of ${prog.searchesTotal} searches`
                    : `${active.queries.length} ${active.queries.length === 1 ? 'search' : 'searches'}`}
                  {active.status === 'running' && ` · ${elapsed(active.claimedAt)} elapsed`}
                </span>
                {active.status === 'queued' && (
                  <button className="btn btn-xs" type="button" onClick={() => cancel(active.id)}>Cancel</button>
                )}
              </div>

              {/* Determinate once the first search reports; indeterminate until
                  then, and while merely queued, because there is nothing honest
                  to measure yet. */}
              {pct === null ? (
                <div className="progress-bar"><div className="progress-fill progress-indeterminate" /></div>
              ) : (
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
              )}

              {prog && prog.currentQuery && (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
                  <span><i className="ti ti-search" style={{ marginRight: 4 }} /><strong>{prog.currentQuery}</strong></span>
                  <span className="page-info">
                    {prog.rendered} seen · {prog.hiring} hiring · <strong>{prog.new} new</strong>
                  </span>
                </div>
              )}

              {prog && prog.perQuery.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 150, overflowY: 'auto' }}>
                  {[...prog.perQuery].reverse().map((q, i) => (
                    <div key={`${q.query}-${i}`} className="page-info"
                      style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <i className="ti ti-check" style={{ marginRight: 4, opacity: 0.6 }} />{q.query}
                      </span>
                      <span style={{ whiteSpace: 'nowrap' }}>{q.rendered} seen · {q.hiring} hiring · {q.new} new</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="page-info" style={{ marginTop: 6 }}>
                Usually 10–20 minutes. Leave the Chrome window open and visible.
              </div>
            </div>
          ) : (
            <>
              {/* The trigger is one line by default. The 20-checkbox list is a
                  wall that buries the button, so it stays behind "Edit". */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
                <button className="btn btn-primary" type="button" disabled={busy || queries.length === 0}
                  onClick={submit}>
                  <i className="ti ti-brand-linkedin" /> {busy ? 'Queueing…' : ready.verb}
                </button>
                <span className="page-info">
                  {queries.length} {queries.length === 1 ? 'search' : 'searches'} selected
                </span>
                <button className="btn btn-xs" type="button" onClick={() => setEditing(v => !v)}>
                  <i className={editing ? 'ti ti-chevron-up' : 'ti ti-adjustments'} />{' '}
                  {editing ? 'Done' : 'Choose searches'}
                </button>
              </div>

              {editing && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                    <button className="btn btn-xs" type="button" onClick={selectAll}>Select all</button>
                    <button className="btn btn-xs" type="button" onClick={clearAll}>Clear</button>
                    {lastYield.size > 0 && (
                      <button className="btn btn-xs" type="button" onClick={selectBest}>
                        <i className="ti ti-sparkles" /> Best performers
                      </button>
                    )}
                    <span className="page-info" style={{ marginLeft: 'auto' }}>
                      {queries.length} / {MAX_QUERIES}
                    </span>
                  </div>

                  {catalogue.length > 8 && (
                    <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                      placeholder="Filter searches…" style={{ width: '100%', marginBottom: 8 }} />
                  )}

                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {visible.map(q => {
                      const y = lastYield.get(q);
                      const on = picked.has(q);
                      return (
                        <label key={q} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px',
                          cursor: 'pointer', opacity: on ? 1 : 0.6 }}>
                          <input type="checkbox" checked={on} onChange={() => toggle(q)} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {q}
                          </span>
                          <span className="page-info" style={{ whiteSpace: 'nowrap' }}>
                            {y === undefined ? '—' : y === 0 ? 'no new last run' : `${y} new last run`}
                          </span>
                        </label>
                      );
                    })}
                    {visible.length === 0 && (
                      <span className="page-info">
                        {catalogue.length === 0
                          ? "No saved searches yet — the worker reports these from the scraper's config.json."
                          : 'Nothing matches that filter.'}
                      </span>
                    )}
                  </div>

                  <input type="text" value={adhoc} onChange={e => setAdhoc(e.target.value)}
                    placeholder="One-off searches for this run, comma separated"
                    style={{ width: '100%', marginTop: 10 }} />
                </div>
              )}

              {status.lastRun && status.lastRun.status === 'done' && (
                <div className="info-box" style={{ marginTop: 12 }}>
                  <i className="ti ti-circle-check" />
                  <span>
                    Last run: <strong>{status.lastRun.stats.new} new</strong> from{' '}
                    {status.lastRun.stats.hiring} hiring posts —{' '}
                    <strong>{status.lastRun.importResult.created} imported</strong>
                    {status.lastRun.importResult.skipped > 0 && `, ${status.lastRun.importResult.skipped} already known`}.
                  </span>
                </div>
              )}
              {status.lastRun && status.lastRun.status === 'failed' && (
                <div className="info-box" style={{ marginTop: 12, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
                  <i className="ti ti-alert-triangle" />
                  <span><strong>Last run failed.</strong> {status.lastRun.error}</span>
                </div>
              )}
            </>
          )}
        </>
      )}

      {showHistory && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <strong>Recent harvests</strong>
          <div style={{ marginTop: 6, maxHeight: 320, overflowY: 'auto' }}>
            {runs.map(r => <HistoryRow key={r.id} run={r} />)}
            {runs.length === 0 && <span className="page-info">No harvests yet.</span>}
          </div>
        </div>
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
            Runs at {sch.time} {sch.timezone} using the searches selected above. One run a day is the
            safe ceiling — the scraper's caps assume an attended run, and over-running is what gets a
            LinkedIn account restricted.
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
