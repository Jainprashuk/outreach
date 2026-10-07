// Discover → Hiring now: companies you already know are hiring — from your LinkedIn
// hiring posts and Naukri jobs — each one click away from a people search.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SkeletonRows } from '../Skeleton';
import { hiringCompaniesApi, type HiringCompany, type HiringPage } from '../../lib/api';
import { ago } from './SearchReport';

const PERIODS: [number, string][] = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'All time']];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function HiringView({ onFind, busy }: {
  onFind: (c: HiringCompany, roles: string[]) => void;
  busy: boolean;
}) {
  const [days, setDays] = useState(30);
  const [source, setSource] = useState<'' | 'linkedin' | 'naukri'>('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [hideSearched, setHideSearched] = useState(false);
  const [roles, setRoles] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HiringPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [finding, setFinding] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [days, source, debounced, hideSearched]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    hiringCompaniesApi({ days, source, q: debounced, hideSearched, page })
      .then(r => { if (alive) { setData(r); setError(''); } })
      .catch(err => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days, source, debounced, hideSearched, page]);

  const counts = data?.counts;
  const roleList = () => roles.split(',').map(r => r.trim()).filter(Boolean);
  const find = async (c: HiringCompany) => {
    setFinding(c.key);
    try { await onFind(c, roleList()); } finally { setFinding(null); }
  };

  return (
    <>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <div className="s-body">
          <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
            Companies you already know are hiring — from your <Link to="/leads">LinkedIn hiring posts</Link> and{' '}
            <Link to="/naukri">Naukri jobs</Link>. Click <strong>Find people</strong> to search one.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search a company" style={{ width: 200 }} />
            <div className="seg-toggle">
              {([['', 'All', counts?.all], ['linkedin', 'LinkedIn', counts?.linkedin], ['naukri', 'Naukri', counts?.naukri]] as const).map(([k, label, n]) => (
                <button key={k} type="button" className={`btn btn-xs${source === k ? ' active' : ''}`} onClick={() => setSource(k)}>
                  {label}{n != null && <span style={{ opacity: 0.6, marginLeft: 4 }}>{n}</span>}
                </button>
              ))}
            </div>
            <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
              {PERIODS.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={hideSearched} onChange={e => setHideSearched(e.target.checked)} />
              Hide companies already searched{counts?.searched ? ` (${counts.searched})` : ''}
            </label>
            <input type="text" value={roles} onChange={e => setRoles(e.target.value)}
              placeholder="Roles to look for (optional), e.g. engineering manager"
              title="Used for every Find people you start from this list"
              style={{ flex: 1, minWidth: 220 }} />
          </div>
        </div>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr><th>Company</th><th>Hiring</th><th>Roles</th><th>Last seen</th><th>In Discover</th><th></th></tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <SkeletonRows rows={8} cols={6} />
            ) : error ? (
              <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
            ) : !data || data.companies.length === 0 ? (
              <tr><td colSpan={6}><div className="empty-state">
                <i className="ti ti-briefcase" />
                {counts && counts.all === 0
                  ? <>No hiring companies in this period yet — they come from <Link to="/leads">Leads</Link> scrapes and <Link to="/naukri">Naukri</Link> harvests.</>
                  : 'No company matches these filters'}
              </div></td></tr>
            ) : data.companies.map(c => (
              <tr key={c.key} style={loading ? { opacity: 0.6 } : undefined}>
                <td>
                  <div style={{ fontWeight: 500 }}>{c.company}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {c.domain || 'website found when you search'}
                  </div>
                </td>
                <td>
                  <span className="tc-mini">
                    {c.linkedin > 0 && <span className="badge badge-queued" title="Hiring posts on LinkedIn"><i className="ti ti-brand-linkedin" /> {plural(c.linkedin, 'post')}</span>}
                    {c.naukri > 0 && <span className="badge badge-pending" title="Jobs on Naukri"><i className="ti ti-briefcase-2" /> {plural(c.naukri, 'job')}</span>}
                  </span>
                </td>
                <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 260 }}>
                  {c.roles.length ? c.roles.join(' · ') : <span style={{ color: 'var(--text3)' }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}
                  title={c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : undefined}>{ago(c.lastSeenAt)}</td>
                <td style={{ fontSize: 12 }}>
                  {c.searchedAt
                    ? <Link to={`/discover?domain=${encodeURIComponent(c.domain || '')}`} className="badge badge-sent" title={`Searched ${ago(c.searchedAt)}`}>
                        {plural(c.people, 'person', 'people')}
                      </Link>
                    : <span style={{ color: 'var(--text3)' }}>Not searched</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className={`btn btn-xs${c.searchedAt ? '' : ' btn-primary'}`} type="button"
                    disabled={busy || finding !== null} onClick={() => find(c)}>
                    {finding === c.key ? <><i className="ti ti-loader-2 tc-spin" /> Starting…</> : <><i className="ti ti-search" /> {c.searchedAt ? 'Search again' : 'Find people'}</>}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.pages > 1 && (
        <div className="pagination-bar">
          <button className="btn btn-sm" disabled={data.page <= 1} onClick={() => setPage(p => p - 1)} type="button">
            <i className="ti ti-chevron-left" /> Prev
          </button>
          <span className="page-info">Page {data.page} of {data.pages} · {data.total} companies</span>
          <button className="btn btn-sm" disabled={data.page >= data.pages} onClick={() => setPage(p => p + 1)} type="button">
            Next <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}
    </>
  );
}
