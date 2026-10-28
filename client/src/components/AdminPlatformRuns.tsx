import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { adminFailStalePlatformRunsApi, adminPlatformRunsApi, type AdminPlatformRun, type AdminUserRow } from '../lib/api';
import { RefreshBar, Refreshing } from './RefreshBar';

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  : '—';

const STATUS_CLASS: Record<AdminPlatformRun['status'], string> = {
  queued: 'badge-pending', running: 'badge-inreview', done: 'badge-sent',
  failed: 'badge-rejected', blocked: 'badge-blocked', cancelled: 'badge-queued',
};

function resultsText(run: AdminPlatformRun) {
  const r = run.results;
  if (run.kind === 'apply') {
    return `${r.applied} applied · ${r.skipped} skipped · ${r.failed} failed${r.rehearsed ? ` · ${r.rehearsed} rehearsed` : ''}`;
  }
  if (run.kind === 'harvest') return `${r.found} found · ${r.new} new · ${r.updated} updated`;
  if (run.kind === 'track') return `${r.tracked} tracked`;
  return '—';
}

export default function AdminPlatformRuns({ accounts }: { accounts: AdminUserRow[] }) {
  const toast = useToast();
  const [days, setDays] = useState<number | 'all'>(30);
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof adminPlatformRunsApi>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminPlatformRunsApi({ days, page, status, kind, platform, userId }));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load job-platform run history');
    } finally { setLoading(false); }
  }, [days, page, status, kind, platform, userId]);

  useEffect(() => { load(); }, [load]);
  const change = (fn: () => void) => { fn(); setPage(1); };
  const markStaleFailed = async () => {
    const account = accounts.find(a => a.id === userId);
    const scope = userId ? `for ${account?.email || 'the selected account'}` : 'across all accounts';
    if (!window.confirm(`Mark job-platform runs ${scope} as failed if they have had no progress for at least 30 minutes? This changes run status only; it does not retry applications or undo results already recorded.`)) return;
    setActing(true);
    try {
      const result = await adminFailStalePlatformRunsApi(userId || undefined);
      toast(result.failed
        ? `Marked ${result.failed} stale run(s) as failed.`
        : 'No stale runs met the 30-minute cutoff.', 'success');
      await load();
    } catch (e: any) {
      toast(e?.message || 'Could not clean up stale runs', 'error');
    } finally { setActing(false); }
  };

  return (
    <>
      <div className="section-head" style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="login-input" aria-label="Time range" value={days} onChange={e => change(() => setDays(e.target.value === 'all' ? 'all' : Number(e.target.value)))} style={{ width: 'auto' }}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value="all">All time</option>
        </select>
        <select className="login-input" aria-label="Account" value={userId} onChange={e => change(() => setUserId(e.target.value))} style={{ width: 'auto', maxWidth: 260 }}>
          <option value="">All accounts</option>{accounts.filter(a => a.id).map(a => <option key={a.id!} value={a.id!}>{a.email}</option>)}
        </select>
        <select className="login-input" aria-label="Platform" value={platform} onChange={e => change(() => setPlatform(e.target.value))} style={{ width: 'auto' }}>
          <option value="">All platforms</option><option value="naukri">Naukri</option><option value="instahyre">Instahyre</option><option value="hirist">Hirist</option><option value="cutshort">Cutshort</option><option value="wellfound">Wellfound</option>
        </select>
        <select className="login-input" aria-label="Run type" value={kind} onChange={e => change(() => setKind(e.target.value))} style={{ width: 'auto' }}>
          <option value="">All run types</option><option value="harvest">Harvest</option><option value="apply">Apply</option>
          <option value="track">Track replies</option><option value="refresh">Profile refresh</option><option value="probe">Check-in</option>
        </select>
        <select className="login-input" aria-label="Status" value={status} onChange={e => change(() => setStatus(e.target.value))} style={{ width: 'auto' }}>
          <option value="">All statuses</option><option value="queued">Queued</option><option value="running">Running</option>
          <option value="done">Done</option><option value="failed">Failed</option><option value="blocked">Blocked</option><option value="cancelled">Cancelled</option>
        </select>
        <button className="btn btn-sm" type="button" onClick={markStaleFailed} disabled={loading || acting} title="Mark runs with no progress for 30 minutes as failed" style={{ marginLeft: 'auto' }}>
          <i className={`ti ${acting ? 'ti-loader-2' : 'ti-alert-triangle'}`} /> Mark stale failed
        </button>
        <button className="btn btn-sm" type="button" onClick={load} disabled={loading || acting}>
          <i className={`ti ${loading ? 'ti-loader-2' : 'ti-refresh'}`} /> Refresh
        </button>
      </div>

      {error && <div className="login-error" style={{ textAlign: 'left', marginBottom: 12 }}>{error}</div>}
      <RefreshBar active={loading && !!data} />
      <Refreshing active={loading && !!data}>
        <div className="an-card">
          <div className="an-card-head">
            <div className="an-card-title"><i className="ti ti-history" /> Job-platform runs</div>
            <div className="an-card-sub">Recent runs across accounts. Status and numeric results only; job titles and error text are not shown.</div>
          </div>
          <div className="an-card-body" style={{ overflowX: 'auto' }}>
            {!data && loading ? <div className="an-empty">Loading run history…</div>
              : !data?.runs.length ? <div className="an-empty">No runs in this period.</div>
                : (
                  <>
                    <table className="an-table" style={{ minWidth: 800 }}>
                      <thead><tr><th>Time (IST)</th><th>Account</th><th>Platform</th><th>Run</th><th>Status</th><th>Results</th></tr></thead>
                      <tbody>{data.runs.map((run, i) => (
                        <tr key={`${run.account}-${run.createdAt}-${i}`}>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {dateTime(run.claimedAt || run.createdAt)}
                            {run.finishedAt && <div style={{ color: 'var(--text3)', fontSize: 11 }}>finished {dateTime(run.finishedAt)}</div>}
                          </td>
                          <td>{run.account}</td>
                          <td>{run.platformLabel}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {run.kind === 'refresh' ? 'Profile refresh' : run.kind === 'track' ? 'Track replies' : run.kind === 'probe' ? 'Check-in' : run.kind[0].toUpperCase() + run.kind.slice(1)}
                            {run.trigger === 'scheduled' && <div style={{ color: 'var(--text3)', fontSize: 11 }}>scheduled</div>}
                            {run.dryRun && <div style={{ color: 'var(--amber)', fontSize: 11 }}>dry run</div>}
                          </td>
                          <td><span className={`badge ${STATUS_CLASS[run.status]}`}>{run.status}</span></td>
                          <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{resultsText(run)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 14, fontSize: 12, color: 'var(--text2)' }}>
                      <span>{data.total.toLocaleString('en-IN')} run(s) · page {data.page} of {Math.max(1, data.pages)}</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-xs" type="button" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>Previous</button>
                        <button className="btn btn-xs" type="button" disabled={page >= data.pages || loading} onClick={() => setPage(p => p + 1)}>Next</button>
                      </div>
                    </div>
                  </>
                )}
          </div>
        </div>
      </Refreshing>
    </>
  );
}
