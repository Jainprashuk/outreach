import { useEffect, useMemo, useRef, useState } from 'react';
import Layout from '../components/Layout';
import BoardManager from '../components/BoardManager';
import CriteriaPanel from '../components/CriteriaPanel';
import PostingDetailModal from '../components/PostingDetailModal';
import PostingFilterPanel from '../components/PostingFilterPanel';
import SyncReportBanner from '../components/SyncReportBanner';
import { SkeletonRows } from '../components/Skeleton';
import { useToast } from '../context/ToastContext';
import {
  bulkUpdatePostingsApi, deletePostingApi, deletePostingsApi, loadBoardsApi,
  loadLeadsApi, loadPostingsApi, loadPostingsMetaApi, syncPostingsApi,
  type JobBoard, type Lead, type Posting, type PostingsMeta, type SyncRunReport,
  type TrackStatus,
} from '../lib/api';
import {
  activeChips, applyPostingFilters, countActive, DEFAULT_FILTERS, TAB_LABELS, TABS,
  tabCounts, type PostingFilters, type PostingTab,
} from '../lib/postingFilters';
import {
  boardFirstSyncMap, formatSalary, isNewSince, isSyncStale, relativeTime,
  SOURCE_LABELS, SYNC_STALE_HOURS, TRACK_BADGE_CLASS, TRACK_STATUS_LABELS,
  TRACK_STATUS_ORDER,
} from '../lib/postings';

const PAGE_SIZE = 25;

// Opening more than this many tabs at once is almost never what you meant.
const MAX_BULK_OPEN = 10;

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function Jobs() {
  const toast = useToast();

  const [postings, setPostings] = useState<Posting[]>([]);
  const [boards, setBoards] = useState<JobBoard[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [meta, setMeta] = useState<PostingsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState<PostingFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Posting | null>(null);
  const [showBoards, setShowBoards] = useState(false);
  const [showCriteria, setShowCriteria] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<SyncRunReport | null>(null);

  // So an open modal can pick up its refreshed row after a save.
  const postingsRef = useRef<Posting[]>([]);
  postingsRef.current = postings;

  const reload = async () => {
    setError('');
    try {
      // Closed postings are excluded by default: one board can be 600+ rows and
      // this page filters client-side.
      const [rows, boardRes, metaRes] = await Promise.all([
        loadPostingsApi(includeClosed ? { listingStatus: 'all' } : undefined),
        loadBoardsApi().catch(() => ({ boards: [] as JobBoard[] })),
        loadPostingsMetaApi().catch(() => null),
      ]);
      setPostings(rows);
      setBoards(boardRes.boards);
      if (metaRes) setMeta(metaRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setLoading(true); reload(); }, [includeClosed]);

  // Leads are only needed to suggest boards from their ATS links — best effort,
  // and never a reason for this page to fail.
  useEffect(() => { loadLeadsApi().then(setLeads).catch(() => setLeads([])); }, []);

  // previousSyncAt comes from the last run report when we have one, since that
  // is the only place that knows the value from BEFORE the run overwrote it.
  const previousSyncAt = report?.previousSyncAt ?? meta?.lastSyncAt ?? null;
  const ctx = useMemo(
    () => ({ previousSyncAt, boardFirstSync: boardFirstSyncMap(boards) }),
    [previousSyncAt, boards],
  );

  const counts = useMemo(() => tabCounts(postings, ctx), [postings, ctx]);
  const filtered = useMemo(() => applyPostingFilters(postings, filters, ctx), [postings, filters, ctx]);
  const chips = activeChips(filters);
  const activeCount = countActive(filters);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [filters]);

  const setFilter = (patch: Partial<PostingFilters>) => setFilters(f => ({ ...f, ...patch }));
  const clearFilters = () => setFilters({ ...DEFAULT_FILTERS, tab: filters.tab });
  const clearOne = (key: keyof PostingFilters) =>
    setFilters(f => ({ ...f, [key]: DEFAULT_FILTERS[key] } as PostingFilters));

  const pageIds = pageRows.map(p => p.id);
  const allChecked = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const someChecked = pageIds.some(id => selected.has(id));
  const toggleAll = (on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of pageIds) on ? next.add(id) : next.delete(id);
      return next;
    });
  const toggleOne = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sync = async (boardIds?: string[]) => {
    setSyncing(true);
    try {
      const res = await syncPostingsApi(boardIds ? { boardIds } : {});
      setReport(res);
      if (res.ok === false && res.reason === 'locked') {
        toast('A sync is already running.', 'info');
      } else if (res.reason === 'no-boards') {
        toast('No enabled boards to sync yet.', 'info');
        setShowBoards(true);
      } else {
        const t = res.totals;
        const bits = [`${t.inserted} new`, `${t.closed} closed`];
        if (t.filteredOut > 0) bits.push(`${t.filteredOut} filtered out`);
        if (t.notFound + t.errored > 0) bits.push(`${t.notFound + t.errored} source(s) failed`);
        toast(`Sync done — ${bits.join(', ')}.`, t.notFound + t.errored > 0 ? 'info' : 'success');
      }
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const setStatusBulk = async (status: TrackStatus) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await bulkUpdatePostingsApi(ids.map(id => ({ id, applyStatus: status, note: 'Bulk update' })));
      toast(`${ids.length} posting${ids.length === 1 ? '' : 's'} set to ${TRACK_STATUS_LABELS[status]}.`, 'success');
      setSelected(new Set());
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update', 'error');
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} posting${ids.length === 1 ? '' : 's'}? Any application status on them goes too.`)) return;
    try {
      const res = await deletePostingsApi(ids);
      toast(`Deleted ${res.deleted}.`, 'success');
      setSelected(new Set());
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete', 'error');
    }
  };

  const confirmDelete = async (p: Posting) => {
    if (!window.confirm(`Delete “${p.title}”?`)) return;
    try {
      await deletePostingApi(p.id);
      toast('Posting deleted.', 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete', 'error');
    }
  };

  const openSelected = () => {
    const rows = filtered.filter(p => selected.has(p.id));
    const urls = rows.map(p => p.applyUrl || p.url).filter(Boolean);
    if (urls.length === 0) return;
    if (urls.length > MAX_BULK_OPEN &&
      !window.confirm(`Open ${urls.length} tabs? Your browser may block some.`)) return;
    for (const u of urls.slice(0, Math.max(MAX_BULK_OPEN, urls.length))) {
      window.open(u, '_blank', 'noopener,noreferrer');
    }
  };

  const stale = isSyncStale(meta?.lastSyncAt ?? null);

  const subtitle = boards.length === 0
    ? 'Live job postings from public ATS boards — add a board to get started'
    : [
        `Synced ${relativeTime(meta?.lastSyncAt ?? null)}`,
        `${counts.open} open`,
        counts.new > 0 ? `${counts.new} new` : null,
        `${boards.length} board${boards.length === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ');

  return (
    <Layout
      title="Jobs"
      subtitle={subtitle}
      actions={
        <>
          <button className="btn btn-sm" type="button" onClick={() => setShowCriteria(v => !v)}>
            <i className="ti ti-adjustments" /> What I want
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setShowBoards(v => !v)}>
            <i className="ti ti-list-details" /> Sources ({boards.length})
          </button>
          <button className="btn btn-sm btn-primary" type="button" disabled={syncing} onClick={() => sync()}>
            <i className={`ti ti-${syncing ? 'loader' : 'refresh'}`} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </>
      }
    >
      {error && (
        <div className="info-box" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 12 }}>
          <i className="ti ti-alert-triangle" /> {error}
        </div>
      )}

      {report && <SyncReportBanner report={report} onDismiss={() => setReport(null)} />}

      {/* GitHub disables scheduled workflows after 60 days of repo inactivity,
          and the sync would then just stop. This is the only honest way to notice. */}
      {stale && !report && (
        <div className="info-box" style={{ marginBottom: 12, borderColor: 'var(--red)' }}>
          <i className="ti ti-alert-triangle" style={{ color: 'var(--red)' }} />
          <span>
            Last synced {relativeTime(meta?.lastSyncAt ?? null)} — over {SYNC_STALE_HOURS} hours.
            {meta?.cronConfigured
              ? ' Check that the "Sync job postings" GitHub Action is still enabled (GitHub disables schedules after 60 days of repo inactivity).'
              : ' No CRON_SECRET is configured, so scheduled syncs are not running — use Sync now, or set it up.'}
          </span>
        </div>
      )}

      {showCriteria && (
        <CriteriaPanel onSaved={reload} onClose={() => setShowCriteria(false)} />
      )}

      {(showBoards || boards.length === 0) && (
        <BoardManager
          boards={boards} postings={postings} leads={leads} syncing={syncing}
          onChanged={reload} onSyncBoard={(id) => sync([id])}
        />
      )}

      {boards.length > 0 && (
        <>
          <div className="section-head">
            <div className="nav-tabs">
              {TABS.map(key => (
                <div key={key} className={`nav-tab${filters.tab === key ? ' active' : ''}`}
                  onClick={() => setFilter({ tab: key as PostingTab })}
                  title={key === 'tracked'
                    ? 'Anything you saved or applied to, open or closed'
                    : key === 'new' ? 'First seen in the latest sync' : undefined}>
                  {key === 'new' && <i className="ti ti-sparkles" style={{ marginRight: 4 }} />}
                  {TAB_LABELS[key]}
                  <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{counts[key]}</span>
                </div>
              ))}
            </div>
            <span className="contact-count-badge">{filtered.length} postings</span>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input type="text" placeholder="Search title, company, team, location..." value={filters.search}
              onChange={e => setFilter({ search: e.target.value })}
              style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
            <div style={{ position: 'relative' }}>
              <button className={`btn btn-sm${showFilters || activeCount > 0 ? ' btn-primary' : ''}`} type="button"
                data-filter-trigger onClick={() => setShowFilters(v => !v)}>
                <i className="ti ti-filter" /> Filters
                {activeCount > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{activeCount}</span>}
                <i className={`ti ti-chevron-${showFilters ? 'up' : 'down'}`} style={{ marginLeft: 4, fontSize: 12 }} />
              </button>
              {showFilters && (
                <PostingFilterPanel postings={postings} boards={boards} filters={filters}
                  onChange={setFilter} onReset={clearFilters} matched={filtered.length}
                  onClose={() => setShowFilters(false)} />
              )}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
              title="Closed postings are left out by default to keep this page fast">
              <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />
              Include closed
            </label>
            <button className="btn btn-sm" type="button" disabled={selected.size === 0}
              onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>

          {filters.tab === 'new' && counts.new === 0 && (
            <div className="info-box" style={{ marginBottom: 12 }}>
              <i className="ti ti-sparkles" />
              <span>
                Nothing new in the last sync. A board's very first sync is shown as an import rather
                than as new postings, so this tab only fills up once boards start changing.
              </span>
            </div>
          )}

          {chips.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              {chips.map(c => (
                <button key={c.key} className="btn btn-xs" type="button" onClick={() => clearOne(c.key)}
                  title="Remove this filter">
                  {c.label} <i className="ti ti-x" style={{ marginLeft: 2 }} />
                </button>
              ))}
              <button className="btn btn-xs" type="button" onClick={clearFilters}
                style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }}>
                <i className="ti ti-filter-off" /> Clear all
              </button>
            </div>
          )}

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th className="cb-col">
                    <input type="checkbox" className="row-cb" checked={allChecked}
                      ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                      onChange={e => toggleAll(e.target.checked)}
                      title="Select every posting on this page" />
                  </th>
                  <th>Role</th><th>Company</th><th>Location</th><th>Board</th>
                  <th>Posted</th><th>Tracking</th><th></th>
                </tr>
              </thead>
              <tbody>
                {loading && <SkeletonRows rows={6} cols={8} />}

                {!loading && pageRows.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty-state">
                        <i className="ti ti-briefcase" />
                        <p>No postings match this view.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {!loading && pageRows.map(p => {
                  const fresh = p.listingStatus === 'open' &&
                    isNewSince(p, ctx.previousSyncAt, p.boardId ? ctx.boardFirstSync[p.boardId] : null);
                  return (
                    <tr key={p.id} style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        // Don't open the modal when a control inside the row was hit.
                        if ((e.target as HTMLElement).closest('a, button, input, select')) return;
                        setDetail(p);
                      }}>
                      <td className="cb-col" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" className="row-cb" checked={selected.has(p.id)}
                          onChange={() => toggleOne(p.id)} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 500, whiteSpace: 'normal' }}>
                          {p.title}
                          {fresh && <span className="badge badge-new" style={{ marginLeft: 6 }}>New</span>}
                          {p.listingStatus === 'closed' && (
                            <span className="badge badge-closed" style={{ marginLeft: 6 }}>Closed</span>
                          )}
                        </div>
                        {(p.department || p.team) && (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            {[p.department, p.team].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td>
                        {p.company || <span style={{ color: 'var(--text3)' }}>—</span>}
                        {(() => {
                          const pay = formatSalary(p);
                          return pay
                            ? <div style={{ fontSize: 11, color: 'var(--green)' }}>{pay}</div>
                            : null;
                        })()}
                      </td>
                      <td>
                        {p.location || <span style={{ color: 'var(--text3)' }}>—</span>}
                        {p.remote && (
                          <div style={{ fontSize: 11, color: 'var(--green)' }}>Remote</div>
                        )}
                        {p.locations.length > 1 && (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            +{p.locations.length - 1} more
                          </div>
                        )}
                      </td>
                      <td>
                        {/* Search-sourced postings are attributed by which saved
                            searches found them, not by a single board token. */}
                        <div style={{ fontSize: 12 }}>
                          {p.queries.length ? p.queries.join(', ') : p.boardToken}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{SOURCE_LABELS[p.source]}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(p.postedAt)}</td>
                      <td>
                        <span className={`badge ${TRACK_BADGE_CLASS[p.applyStatus]}`}>
                          {TRACK_STATUS_LABELS[p.applyStatus]}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {(p.applyUrl || p.url) && (
                          <a className="btn btn-sm" href={p.applyUrl || p.url} target="_blank"
                            rel="noopener noreferrer" title="Open the posting">
                            <i className="ti ti-external-link" />
                          </a>
                        )}
                        <button className="btn btn-sm" type="button" onClick={() => confirmDelete(p)}
                          title="Delete posting" style={{ marginLeft: 4 }}>
                          <i className="ti ti-trash" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination-bar">
              <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} type="button">
                <i className="ti ti-chevron-left" /> Prev
              </button>
              <span className="page-info">Page {safePage} of {totalPages}</span>
              <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} type="button">
                Next <i className="ti ti-chevron-right" />
              </button>
            </div>
          )}

          <div className={`bulk-bar${selected.size > 0 ? ' visible' : ''}`}>
            <span className="bb-count">{selected.size} selected</span>
            <select value="" onChange={e => { if (e.target.value) setStatusBulk(e.target.value as TrackStatus); e.target.value = ''; }}
              style={{ width: 'auto', minWidth: 165 }} title="Set your tracking status">
              <option value="">Set tracking status…</option>
              {TRACK_STATUS_ORDER.map(s => <option key={s} value={s}>{TRACK_STATUS_LABELS[s]}</option>)}
            </select>
            <button className="btn" type="button" onClick={openSelected}>
              <i className="ti ti-external-link" /> Open all
            </button>
            <button className="btn btn-del" type="button" onClick={deleteSelected}>
              <i className="ti ti-trash" /> Delete
            </button>
          </div>
        </>
      )}

      {detail && (
        <PostingDetailModal
          posting={detail}
          onSaved={async () => {
            await reload();
            setDetail(d => (d ? postingsRef.current.find(x => x.id === d.id) || d : d));
            toast('Tracking saved.', 'success');
          }}
          onClose={() => setDetail(null)}
          onDelete={async (p) => { setDetail(null); await confirmDelete(p); }}
        />
      )}
    </Layout>
  );
}
