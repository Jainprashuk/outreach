import { Fragment, useCallback, useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { fmtAgo } from '../lib/analytics';
import { RefreshBar, Refreshing } from './RefreshBar';
import { adminIssuesApi, adminSetIssueStatusApi, type IssueRow, type IssueSource, type IssuesView } from '../lib/api';

const SOURCES: Array<{ key: IssueSource; label: string; icon: string; hint: string }> = [
  { key: 'server', label: 'Server errors', icon: 'ti-server-off', hint: 'A request crashed (HTTP 5xx)' },
  { key: 'job', label: 'Background jobs', icon: 'ti-clock-exclamation', hint: 'Sends, campaigns, scrapes, mailbox scans, system email' },
  { key: 'client', label: 'Browser', icon: 'ti-browser-x', hint: 'The page crashed, or a request never got an answer' },
  { key: 'validation', label: 'Rejected requests', icon: 'ti-hand-stop', hint: 'The server refused a request (HTTP 4xx)' },
];
const SOURCE_BADGE: Record<IssueSource, string> = {
  server: 'badge-rejected', job: 'badge-bounced', client: 'badge-pending', validation: 'badge',
};
const label = (s: IssueSource) => SOURCES.find(x => x.key === s)?.label || s;
const ago = (v: string | null) => (v ? fmtAgo(new Date(v).getTime()) : '—');

export default function AdminIssues({ onOpenCount }: { onOpenCount?: (n: number) => void }) {
  const toast = useToast();
  const [data, setData] = useState<IssuesView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [source, setSource] = useState<IssueSource | ''>('');
  const [userId, setUserId] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');   // q, debounced
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { status };
      if (source) params.source = source;
      if (userId) params.userId = userId;
      if (query) params.q = query;
      const d = await adminIssuesApi(params);
      setData(d);
      setError('');
      setSelected(new Set());
      onOpenCount?.(Object.values(d.open).reduce((n, g) => n + (g?.issues || 0), 0));
    } catch (e: any) {
      setError(e.message || 'Could not load issues');
    } finally {
      setLoading(false);
    }
  }, [status, source, userId, query, onOpenCount]);
  useEffect(() => { load(); }, [load]);

  const setIssueStatus = async (ids: string[], to: 'open' | 'resolved') => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await adminSetIssueStatusApi(ids, to);
      toast(`${r.updated} issue(s) ${to === 'resolved' ? 'resolved' : 'reopened'}`, 'success');
      await load();
    } catch (e: any) {
      toast(e.message || 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setSelected(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const rows = data?.issues || [];
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));

  return (
    <>
      <div className="stat-grid">
        {SOURCES.map(s => {
          const g = data?.open[s.key];
          const active = source === s.key;
          return (
            <button
              key={s.key} type="button" className="stat-card" title={s.hint}
              onClick={() => setSource(active ? '' : s.key)}
              style={{ textAlign: 'left', cursor: 'pointer', outline: active ? '2px solid var(--accent)' : undefined }}
            >
              <div className="stat-label"><i className={`ti ${s.icon}`} /> {s.label}</div>
              <div className={`stat-value ${g?.issues ? (s.key === 'validation' ? 'amber' : 'red') : 'green'}`}>{g?.issues || 0}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>
                open · {g?.occurrences || 0} occurrence(s)
              </div>
            </button>
          );
        })}
      </div>

      <div className="an-card" style={{ marginTop: 16 }}>
        <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="an-card-title"><i className="ti ti-bug" /> Issues</div>
            <div className="an-card-sub">
              Everything that failed for anyone. Repeats of the same failure are folded into one row with a count.
              Resolving a row and seeing it again opens a new one. Rows not seen for 90 days are removed.
            </div>
          </div>
          <div className="seg-toggle">
            {(['open', 'resolved', 'all'] as const).map(s => (
              <button key={s} type="button" className={`btn btn-xs${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>{s}</button>
            ))}
          </div>
        </div>
        <div className="an-card-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input
              className="login-input" type="search" placeholder="Search message, area or kind…"
              value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }}
            />
            <select value={source} onChange={e => setSource(e.target.value as IssueSource | '')} aria-label="Source" style={{ width: 'auto' }}>
              <option value="">Every source</option>
              {SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select value={userId} onChange={e => setUserId(e.target.value)} aria-label="Account" style={{ width: 'auto' }}>
              <option value="">Every account</option>
              <option value="none">No account (sign-in, system)</option>
              {(data?.users || []).map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
            <button className="btn btn-xs" type="button" onClick={load} disabled={loading} title="Refresh">
              <i className={`ti ${loading ? 'ti-loader' : 'ti-refresh'}`} />
            </button>
            {selected.size > 0 && (
              <>
                <button className="btn btn-xs btn-success" type="button" disabled={busy}
                  onClick={() => setIssueStatus([...selected], 'resolved')}>Resolve {selected.size}</button>
                <button className="btn btn-xs" type="button" disabled={busy}
                  onClick={() => setIssueStatus([...selected], 'open')}>Reopen {selected.size}</button>
              </>
            )}
          </div>

          {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
          {!data && !error && <div className="skeleton" style={{ height: 120 }} />}

          <RefreshBar active={loading && !!data} />
          <Refreshing active={loading && !!data}>
            {data && rows.length === 0 && (
              <div className="an-empty">
                <i className="ti ti-circle-check" />
                {status === 'open' ? 'No open issues. Nothing has failed for anyone.' : 'Nothing matches.'}
              </div>
            )}
            {data && rows.length > 0 && (
              <div className="table-card" style={{ boxShadow: 'none' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <input type="checkbox" aria-label="Select all" checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))} />
                      </th>
                      <th>What happened</th>
                      <th>Account</th>
                      <th style={{ textAlign: 'right' }}>Times</th>
                      <th>Last seen</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <Fragment key={r.id}>
                        <tr style={{ cursor: 'pointer', opacity: r.status === 'resolved' ? 0.6 : 1 }}
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          <td onClick={e => e.stopPropagation()}>
                            <input type="checkbox" aria-label="Select" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          </td>
                          <td style={{ maxWidth: 520 }}>
                            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginBottom: 3 }}>
                              <span className={`badge ${SOURCE_BADGE[r.source]}`}>{label(r.source)}</span>
                              <span className="badge">{r.area}</span>
                              <code style={{ fontSize: 11, color: 'var(--text3)' }}>{r.kind}</code>
                              {r.status === 'resolved' && <span className="badge badge-sent">resolved</span>}
                            </div>
                            <div style={{
                              fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: expanded === r.id ? 'pre-wrap' : 'nowrap', wordBreak: 'break-word',
                            }}>{r.message}</div>
                          </td>
                          <td style={{ fontSize: 12.5 }}>{r.userEmail || <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count}×</td>
                          <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{ago(r.lastSeenAt)}</td>
                          <td style={{ whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                            {r.status === 'open' ? (
                              <button className="btn btn-xs" type="button" disabled={busy}
                                onClick={() => setIssueStatus([r.id], 'resolved')}>Resolve</button>
                            ) : (
                              <button className="btn btn-xs" type="button" disabled={busy}
                                onClick={() => setIssueStatus([r.id], 'open')}>Reopen</button>
                            )}
                          </td>
                        </tr>
                        {expanded === r.id && <IssueDetail row={r} />}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data && data.total > rows.length && (
              <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 8 }}>
                Showing the {rows.length} most recent of {data.total}. Narrow the filters to see the rest.
              </p>
            )}
          </Refreshing>
        </div>
      </div>
    </>
  );
}

function IssueDetail({ row }: { row: IssueRow }) {
  const pre: React.CSSProperties = {
    fontSize: 11.5, background: 'var(--surface2, var(--bg))', border: '1px solid var(--border)', borderRadius: 6,
    padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflow: 'auto', margin: '4px 0 10px',
  };
  const hasMeta = row.meta && Object.keys(row.meta).length > 0;
  return (
    <tr>
      <td />
      <td colSpan={5} style={{ paddingTop: 0 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text3)', margin: '2px 0 6px' }}>
          First seen {new Date(row.firstSeenAt).toLocaleString()} · last seen {new Date(row.lastSeenAt).toLocaleString()}
          {row.resolvedAt && <> · resolved {new Date(row.resolvedAt).toLocaleString()}</>}
        </div>
        {row.detail && (<><div className="form-label">Detail</div><pre style={pre}>{row.detail}</pre></>)}
        {hasMeta && (<><div className="form-label">Context</div><pre style={pre}>{JSON.stringify(row.meta, null, 2)}</pre></>)}
        {!row.detail && !hasMeta && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>No further detail was recorded.</div>}
      </td>
    </tr>
  );
}
