import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import { SkeletonRows } from '../components/Skeleton';
import { RefreshBar, Refreshing, CountOrSpinner } from '../components/RefreshBar';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import {
  importLibraryApi, loadLibraryApi,
  type LibraryAddedBy, type LibraryCompany, type LibraryLead, type LibraryPage, type LibraryPerson,
  type LibraryProspect, type LibraryTab,
} from '../lib/api';
import { sourceLabel } from '../lib/leads';
import { CONFIDENCE_CLASS, CONFIDENCE_HELP, CONFIDENCE_LABEL } from '../lib/prospects';

// The shared Library: every user's contact DATA in one list — never anyone's
// sends, replies or notes (lib/library.js on the server decides what leaves).

const PAGE_SIZE = 25;

const TABS: Array<[LibraryTab, string]> = [
  ['people', 'People'], ['leads', 'Leads'], ['discover', 'Discover'], ['companies', 'Companies'],
];

const SOURCES: Record<LibraryTab, Array<[string, string]>> = {
  people: [['outreach', 'Added directly (CSV / typed)'], ['lead', 'From a lead'], ['discover', 'From Discover'], ['naukri', 'From Naukri']],
  leads: [['scroll', 'LinkedIn'], ['paste', 'Pasted'], ['hn', 'HN'], ['web-post', 'Hiring posts'], ['gmail', 'Gmail alerts']],
  discover: [['search', 'Web search'], ['github', 'GitHub'], ['website', 'Company website']],
  companies: [],
};

const PEOPLE_SOURCE: Record<string, string> = { outreach: 'Direct', lead: 'Lead', discover: 'Discover', naukri: 'Naukri' };
const FOUND_VIA: Record<string, string> = { search: 'Web search', github: 'GitHub', website: 'Website' };

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function AddedBy({ list }: { list: LibraryAddedBy[] }) {
  if (!list.length) return null;
  const shown = list.slice(0, 2).map(a => a.name).join(', ');
  const more = list.length > 2 ? ` +${list.length - 2}` : '';
  return <span title={list.map(a => a.name).join(', ')} style={{ color: 'var(--text2)' }}>{shown}{more}</span>;
}

function Flags({ row }: { row: { bounced: boolean; inMine: boolean } }) {
  return (
    <>
      {row.bounced && <span className="badge badge-rejected" style={{ marginLeft: 6 }} title="This address bounced for someone — it is skipped when you add rows">Bounced</span>}
      {row.inMine && <span className="badge badge-queued" style={{ marginLeft: 6 }} title="Already in your contacts">In my contacts</span>}
    </>
  );
}

function ext(href: string, label: string, icon = 'ti-external-link') {
  if (!/^https?:\/\//i.test(href)) return null;
  return <a href={href} target="_blank" rel="noreferrer" title={label} style={{ color: 'var(--text3)', marginLeft: 6 }}><i className={`ti ${icon}`} /></a>;
}

/** One page from the server: debounced search, the previous page kept while the next loads. */
function useLibrary(tab: LibraryTab, params: Record<string, string>, page: number, withIds: boolean) {
  const [data, setData] = useState<LibraryPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [q, setQ] = useState(params.q || '');
  useEffect(() => { const t = setTimeout(() => setQ(params.q || ''), 250); return () => clearTimeout(t); }, [params.q]);
  const key = JSON.stringify({ ...params, q });

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const p: Record<string, string> = Object.fromEntries(Object.entries(JSON.parse(key)).filter(([, v]) => v)) as Record<string, string>;
    loadLibraryApi(tab, { ...p, page: String(page), limit: String(PAGE_SIZE), ...(withIds ? { ids: '1' } : {}) }, ac.signal)
      .then(res => { if (!ac.signal.aborted) { setData(res); setError(''); } })
      .catch(err => { if (!ac.signal.aborted) setError(err.message || 'Could not load the Library'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [tab, key, page, withIds, tick]);

  return { data, error, loading, reload: () => setTick(t => t + 1) };
}

export default function Library() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const initialTab = (params.get('tab') as LibraryTab) || 'people';
  const [tab, setTabState] = useState<LibraryTab>(TABS.some(([k]) => k === initialTab) ? initialTab : 'people');
  const [search, setSearch] = useState(params.get('q') || '');
  const [source, setSource] = useState('');
  const [domain, setDomain] = useState(params.get('domain') || '');
  const [hideMine, setHideMine] = useState(false);
  const [hideBounced, setHideBounced] = useState(false);
  const [sort, setSort] = useState<'recent' | 'people'>('recent');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [template, setTemplate] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => { app.initMeta().catch(() => { /* the template picker just stays empty */ }); }, []);
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));
  useEffect(() => { if (!template && templateOptions[0]) setTemplate(templateOptions[0].key); }, [templateOptions.length]);

  const setTab = (next: LibraryTab) => {
    setTabState(next); setSource(''); setSelected(new Set()); setPage(1);
    const p = new URLSearchParams(params); p.set('tab', next); setParams(p, { replace: true });
  };
  const resetPage = () => setPage(1);

  const query = {
    q: search, source, domain,
    hideMine: hideMine ? '1' : '', hideBounced: hideBounced ? '1' : '',
    sort: tab === 'companies' && sort === 'people' ? 'people' : '',
  };
  const list = useLibrary(tab, query, page, selected.size > 0);
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = list.data?.pages ?? 1;
  const safePage = list.data?.page ?? 1;
  const refreshing = list.loading && !!list.data;
  const busy = !list.data && list.loading;
  const canSelect = tab !== 'companies';

  const ids = list.data?.ids ?? [];
  const allChecked = selected.size > 0 && ids.length > 0 && ids.every(k => selected.has(k));
  const someChecked = selected.size > 0 && ids.some(k => selected.has(k));
  const toggleRow = (key: string, on: boolean) => setSelected(prev => {
    const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next;
  });
  const toggleAll = async (on: boolean) => {
    if (!on) { setSelected(new Set()); return; }
    try {
      const res = await loadLibraryApi(tab, { ...Object.fromEntries(Object.entries(query).filter(([, v]) => v)), ids: '1', limit: '1' });
      setSelected(new Set((res.ids || []).slice(0, 500)));
      if ((res.ids || []).length > 500) toast('Selected the first 500 — that is the most you can add at once', 'info');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const openCompany = (c: LibraryCompany) => {
    setTabState('people'); setDomain(c.domain); setSearch(''); setSource(''); setSelected(new Set()); setPage(1);
    const p = new URLSearchParams(); p.set('tab', 'people'); p.set('domain', c.domain); setParams(p, { replace: true });
  };

  const addSelected = async () => {
    if (!template) { toast('Pick a template first', 'error'); return; }
    setImporting(true);
    try {
      const r = await importLibraryApi(tab, [...selected], template);
      const skipped = [
        r.existing && `${r.existing} already in your contacts`,
        r.bounced && `${r.bounced} bounced`,
        r.blocked && `${r.blocked} on your blocklist`,
        r.noEmail && `${r.noEmail} with no email`,
        r.lowConfidence && `${r.lowConfidence} low-confidence guesses`,
      ].filter(Boolean).join(', ');
      toast(`Added ${r.created} to your outreach${skipped ? ` — skipped ${skipped}` : ''}. Approve them in Step 2.`, r.created ? 'success' : 'info', 7000);
      setSelected(new Set());
      list.reload();
    } catch (e: any) {
      toast(e.message || 'Could not add them', 'error');
    } finally {
      setImporting(false);
    }
  };

  const cols = 6;

  const header = (() => {
    if (tab === 'people') return ['Person', 'Company', 'Role', 'Source', 'Added by'];
    if (tab === 'leads') return ['Person', 'Company', 'Role / location', 'Source', 'Added by'];
    if (tab === 'discover') return ['Person', 'Company', 'Email guess', 'Found via', 'Added by'];
    return ['Company', 'People', 'Email format set by users', 'Shared inboxes', 'Contributors', 'Last added'];
  })();

  const renderRow = (row: any) => {
    const cb = canSelect ? (
      <td className="cb-col">
        <input type="checkbox" className="row-cb" checked={selected.has(row.key)} onChange={e => toggleRow(row.key, e.target.checked)} />
      </td>
    ) : null;
    if (tab === 'people') {
      const r = row as LibraryPerson;
      return (
        <tr key={r.key}>
          {cb}
          <td><div className="contact-chip"><Avatar name={r.name} /><div>
            <div className="name">{r.name}{ext(r.linkedin, 'LinkedIn profile', 'ti-brand-linkedin')}<Flags row={r} /></div>
            <div className="email">{r.email}</div>
          </div></div></td>
          <td style={{ color: 'var(--text2)' }}>{r.company}</td>
          <td style={{ color: 'var(--text2)' }}>{r.role || r.jobTitle}</td>
          <td>{r.sources.map(s => <span key={s} className="badge" style={{ marginRight: 4 }}>{PEOPLE_SOURCE[s] || s}</span>)}</td>
          <td><AddedBy list={r.addedBy} /><div style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtDate(r.lastAt)}</div></td>
        </tr>
      );
    }
    if (tab === 'leads') {
      const r = row as LibraryLead;
      return (
        <tr key={r.key}>
          {cb}
          <td><div className="contact-chip"><Avatar name={r.name} /><div>
            <div className="name">{r.name}{ext(r.postUrl, 'The post')}<Flags row={r} /></div>
            <div className="email">{r.email || <span style={{ color: 'var(--text3)' }}>no email</span>}</div>
          </div></div></td>
          <td style={{ color: 'var(--text2)' }}>{r.company}</td>
          <td style={{ color: 'var(--text2)' }}>{r.role}{r.location && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{r.location}</div>}</td>
          <td>{(r.sources.length ? r.sources : ['']).map(s => <span key={s || 'x'} className="badge" style={{ marginRight: 4 }}>{sourceLabel(s)}</span>)}
            {r.postedAt && <div style={{ fontSize: 11, color: 'var(--text3)' }}>posted {fmtDate(r.postedAt)}</div>}</td>
          <td><AddedBy list={r.addedBy} /><div style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtDate(r.lastAt)}</div></td>
        </tr>
      );
    }
    if (tab === 'discover') {
      const r = row as LibraryProspect;
      return (
        <tr key={r.key}>
          {cb}
          <td><div className="contact-chip"><Avatar name={r.name} /><div>
            <div className="name">{r.name}{ext(r.linkedin, 'LinkedIn profile', 'ti-brand-linkedin')}<Flags row={r} /></div>
            <div className="email">{r.title}</div>
          </div></div></td>
          <td style={{ color: 'var(--text2)' }}>{r.company}<div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{r.domain}</div></td>
          <td>
            {r.email ? <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }}>{r.email}</span> : <span style={{ color: 'var(--text3)' }}>no guess yet</span>}
            {r.emailConfidence && (
              <span className={`badge ${CONFIDENCE_CLASS[r.emailConfidence]}`} style={{ marginLeft: 6 }} title={CONFIDENCE_HELP[r.emailConfidence]}>
                {CONFIDENCE_LABEL[r.emailConfidence]}
              </span>
            )}
          </td>
          <td>{r.foundVia.map(v => <span key={v} className="badge" style={{ marginRight: 4 }}>{FOUND_VIA[v] || v}</span>)}</td>
          <td><AddedBy list={r.addedBy} /><div style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtDate(r.lastAt)}</div></td>
        </tr>
      );
    }
    const r = row as LibraryCompany;
    return (
      <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => openCompany(r)} title="See the people at this company">
        <td><div style={{ fontWeight: 500 }}>{r.company || r.domain}</div><div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{r.domain}</div></td>
        <td>
          <strong>{r.people}</strong>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {[r.contacts && `${r.contacts} contacts`, r.leads && `${r.leads} leads`, r.prospects && `${r.prospects} Discover`].filter(Boolean).join(' · ')}
          </div>
        </td>
        <td>{r.formats.length === 0 ? <span style={{ color: 'var(--text3)' }}>—</span> : r.formats.map(f => (
          <span key={f.pattern} className={`badge${f.tested ? ' badge-sent' : ''}`} style={{ marginRight: 4 }}
            title={`${f.accounts} user${f.accounts === 1 ? '' : 's'} set this${f.tested ? ', proven by a test email or a real address' : ''}`}>
            {f.pattern}{f.accounts > 1 ? ` ×${f.accounts}` : ''}
          </span>
        ))}</td>
        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.genericEmails.slice(0, 3).join(', ')}</td>
        <td><AddedBy list={r.addedBy} /></td>
        <td style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(r.lastAt)}</td>
      </tr>
    );
  };

  return (
    <Layout title="Library" subtitle="Shared by every user — contact details only, never anyone’s sends or replies">
      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label]) => (
            <button type="button" key={key} className={`nav-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <span className="contact-count-badge"><CountOrSpinner loading={refreshing}>{total} {tab === 'companies' ? 'companies' : 'rows'}</CountOrSpinner></span>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder={tab === 'companies' ? 'Search company or domain…' : 'Search name, email, company or role…'}
          value={search} onChange={e => { setSearch(e.target.value); resetPage(); }} style={{ flex: 1, minWidth: 180, maxWidth: 300 }} />
        {SOURCES[tab].length > 0 && (
          <select value={source} onChange={e => { setSource(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 150 }}>
            <option value="">All sources</option>
            {SOURCES[tab].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {tab === 'companies' ? (
          <select value={sort} onChange={e => { setSort(e.target.value as 'recent' | 'people'); resetPage(); }} style={{ width: 'auto' }}>
            <option value="recent">Recently added</option>
            <option value="people">Most people</option>
          </select>
        ) : (
          <>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text2)' }}>
              <input type="checkbox" checked={hideMine} onChange={e => { setHideMine(e.target.checked); resetPage(); }} /> Hide ones I already have
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text2)' }}>
              <input type="checkbox" checked={hideBounced} onChange={e => { setHideBounced(e.target.checked); resetPage(); }} /> Hide bounced
            </label>
          </>
        )}
        {domain && (
          <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            @{domain}
            <button type="button" aria-label="Clear company" onClick={() => {
              setDomain(''); resetPage();
              const p = new URLSearchParams(params); p.delete('domain'); setParams(p, { replace: true });
            }} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit', padding: 0 }}><i className="ti ti-x" /></button>
          </span>
        )}
      </div>

      <RefreshBar active={refreshing} />
      <Refreshing active={refreshing}>
        <div className="table-card">
          <table>
            <thead>
              <tr>
                {canSelect && (
                  <th className="cb-col">
                    <input type="checkbox" className="row-cb" checked={allChecked}
                      ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                      onChange={e => toggleAll(e.target.checked)} title="Select all (up to 500)" />
                  </th>
                )}
                {header.map(h => <th key={h}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {busy ? (
                <SkeletonRows rows={8} cols={cols} chipCol={canSelect ? 1 : 0} />
              ) : list.error ? (
                <tr><td colSpan={cols}><div className="empty-state"><i className="ti ti-alert-triangle" />{list.error}</div></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={cols}><div className="empty-state"><i className="ti ti-books" />Nothing here yet</div></td></tr>
              ) : rows.map(renderRow)}
            </tbody>
          </table>
        </div>
      </Refreshing>

      {pages > 1 && (
        <div className="pagination-bar">
          <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} type="button"><i className="ti ti-chevron-left" /> Prev</button>
          <span className="page-info">Page {safePage} of {pages}</span>
          <button className="btn btn-sm" disabled={safePage === pages} onClick={() => setPage(p => p + 1)} type="button">Next <i className="ti ti-chevron-right" /></button>
        </div>
      )}

      <div className={`bulk-bar${selected.size > 0 ? ' visible' : ''}`}>
        <span className="bb-count">{selected.size} selected</span>
        <select value={template} onChange={e => setTemplate(e.target.value)} style={{ width: 'auto', minWidth: 160 }} title="Template for the new contacts">
          {templateOptions.length === 0 && <option value="">No templates — create one first</option>}
          {templateOptions.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        <button className="btn btn-sm" type="button" onClick={() => setSelected(new Set())}>Clear</button>
        <button className="btn btn-send" type="button" disabled={importing || !template} onClick={addSelected}>
          <i className={`ti ${importing ? 'ti-loader-2' : 'ti-user-plus'}`} /> Add to my outreach
        </button>
        <button className="btn btn-sm" type="button" onClick={() => navigate('/send/step2')} title="Approve the people you added">Step 2 <i className="ti ti-arrow-right" /></button>
      </div>
    </Layout>
  );
}
