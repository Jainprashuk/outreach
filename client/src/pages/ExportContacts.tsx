import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import ExportContactFilterPanel from '../components/ExportContactFilterPanel';
import LeadFilterPanel from '../components/LeadFilterPanel';
import { useSession } from '../context/SessionContext';
import { useToast } from '../context/ToastContext';
import { API_BASE, type Lead, type LeadOutcomeMap } from '../lib/api';
import { toDelimitedText, downloadTextFile } from '../lib/csv';
import { CATEGORY_LABELS, STATUS_LABELS } from '../lib/format';
import {
  applyContactFilters, contactChips, DEFAULT_CONTACT_FILTERS, PRESETS,
  type ContactFilters, type ContactPreset, type ShareContact,
} from '../lib/exportContactFilters';
import {
  activeChips, applyLeadFilters, countActive, DEFAULT_FILTERS, tabCounts, TAB_LABELS,
  type LeadFilters, type LeadTab,
} from '../lib/leadFilters';
import { APPLY_STATUS_LABELS, deriveCompany } from '../lib/leads';
import { outcomeOf, stageOf, STAGE_BADGE, STAGE_LABELS } from '../lib/leadOutcome';

const PAGE_SIZE = 25;

type Dataset = 'contacts' | 'leads';

// `ownerOnly` columns carry dates, which the server only sends to the account's
// own signed-in owner — a share viewer never sees them offered.
type ColumnDef<T> = { key: string; label: string; get: (row: T) => string; ownerOnly?: boolean };

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

const CONTACT_COLUMNS: ColumnDef<ShareContact>[] = [
  { key: 'name', label: 'Name', get: c => c.name },
  { key: 'email', label: 'Email', get: c => c.email },
  { key: 'company', label: 'Company', get: c => c.company },
  { key: 'role', label: 'Role', get: c => c.role },
  { key: 'status', label: 'Status', get: c => STATUS_LABELS[c.status] || c.status },
  { key: 'category', label: 'Reply category', get: c => (c.replyCategory ? CATEGORY_LABELS[c.replyCategory] || c.replyCategory : '') },
  { key: 'replied', label: 'Replied', get: c => yesNo(c.replied) },
  { key: 'followedUp', label: 'Followed up', get: c => yesNo(c.followedUp) },
  { key: 'template', label: 'Template', get: c => c.template },
  { key: 'source', label: 'Came from', get: c => (c.source === 'lead' ? 'LinkedIn lead' : 'Direct') },
  { key: 'approval', label: 'Approval', get: c => c.approvalStatus },
  { key: 'createdAt', label: 'Added', get: c => day(c.createdAt), ownerOnly: true },
  { key: 'lastSentAt', label: 'Last sent', get: c => day(c.lastSentAt), ownerOnly: true },
  { key: 'repliedAt', label: 'Replied on', get: c => day(c.repliedAt), ownerOnly: true },
];
const DEFAULT_CONTACT_COLS = ['name', 'email', 'company', 'role', 'status'];

const leadColumns = (outcomes: LeadOutcomeMap): ColumnDef<Lead>[] => [
  { key: 'name', label: 'Name', get: l => l.authorName },
  { key: 'email', label: 'Email', get: l => l.email || '' },
  { key: 'company', label: 'Company', get: l => deriveCompany(l) },
  { key: 'role', label: 'Role', get: l => l.role },
  { key: 'fit', label: 'Fit score', get: l => String(l.fitScore) },
  { key: 'stage', label: 'Outreach outcome', get: l => STAGE_LABELS[stageOf(outcomeOf(l, outcomes))] },
  { key: 'status', label: 'Lead status', get: l => TAB_LABELS[l.status] || l.status },
  { key: 'apply', label: 'Application', get: l => APPLY_STATUS_LABELS[l.applyStatus || 'not-applied'] },
  { key: 'hiring', label: 'Hiring', get: l => yesNo(l.hiring) },
  { key: 'profile', label: 'LinkedIn profile', get: l => l.authorUrl || '' },
  { key: 'post', label: 'Post URL', get: l => l.postUrl || '' },
  { key: 'queries', label: 'Search queries', get: l => (l.queries || []).join('; ') },
  { key: 'links', label: 'Links', get: l => (l.links || []).join(' ') },
  { key: 'source', label: 'Source', get: l => l.source },
  { key: 'createdAt', label: 'Imported', get: l => day(l.createdAt), ownerOnly: true },
];
const DEFAULT_LEAD_COLS = ['name', 'email', 'company', 'fit', 'stage', 'profile'];
const LEAD_TABS: LeadTab[] = ['all', 'new', 'added-to-outreach', 'direct-apply'];

export default function ExportContacts() {
  const session = useSession();
  const toast = useToast();
  // A share LINK carries its own credential in ?s=. It names the account whose
  // export this is, which the old single global password could not do.
  const shareToken = new URLSearchParams(window.location.search).get('s') || '';
  const authed = session.owner || session.share || !!shareToken;
  const shareQuery = shareToken ? `?s=${encodeURIComponent(shareToken)}` : '';

  const [dataset, setDataset] = useState<Dataset>('contacts');
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);

  const [contacts, setContacts] = useState<ShareContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [withDates, setWithDates] = useState(false);

  // Leads are fetched the first time their tab is opened, not on page load.
  const [leads, setLeads] = useState<Lead[]>([]);
  const [outcomes, setOutcomes] = useState<LeadOutcomeMap>({});
  const [leadsLoaded, setLeadsLoaded] = useState(false);
  const [leadsLoading, setLeadsLoading] = useState(false);

  // Password gate state
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pwError, setPwError] = useState('');

  // Export UI state — each dataset keeps its own, so switching back loses nothing.
  const [preset, setPreset] = useState<ContactPreset>('all');
  const [contactFilters, setContactFilters] = useState<ContactFilters>(DEFAULT_CONTACT_FILTERS);
  const [leadFilters, setLeadFilters] = useState<LeadFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [contactCols, setContactCols] = useState<Set<string>>(new Set(DEFAULT_CONTACT_COLS));
  const [leadCols, setLeadCols] = useState<Set<string>>(new Set(DEFAULT_LEAD_COLS));

  // 401 → the gate shows; 503 → sharing isn't configured. Anything else is an error.
  const fetchShare = async (path: string) => {
    const res = await fetch(`${API_BASE}${path}${shareQuery}`);
    if (res.status === 401) return null;
    if (res.status === 503) { setNotConfigured(true); return null; }
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  };

  const loadContacts = async () => {
    setContactsLoading(true);
    setError('');
    try {
      const data = await fetchShare('/api/share/contacts');
      if (!data) return;
      setContacts(data.contacts || []);
      setWithDates(!!data.withDates);
    } catch (err: any) {
      setError(err.message || 'Could not load contacts.');
    } finally {
      setContactsLoading(false);
    }
  };

  const loadLeads = async () => {
    setLeadsLoading(true);
    setError('');
    try {
      const data = await fetchShare('/api/share/leads');
      if (!data) return;
      setLeads(data.leads || []);
      setOutcomes(data.outcomes || {});
      setLeadsLoaded(true);
    } catch (err: any) {
      setError(err.message || 'Could not load LinkedIn leads.');
    } finally {
      setLeadsLoading(false);
    }
  };

  useEffect(() => {
    if (authed) loadContacts();
  }, [authed]);

  useEffect(() => {
    if (authed && dataset === 'leads' && !leadsLoaded && !leadsLoading) loadLeads();
  }, [authed, dataset]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setPwError('');
    try {
      const res = await fetch(`${API_BASE}/api/share/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 503) { setNotConfigured(true); return; }
      if (!res.ok) { setPwError('Incorrect password. Please try again.'); return; }
      setPassword('');
      await session.refresh(); // flips `share` → true, effect reloads contacts
    } catch {
      setPwError('Could not sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetPage = () => setPage(1);
  const isLeads = dataset === 'leads';

  // ── Contacts ────────────────────────────────────────────────────────────────
  const filteredContacts = useMemo(
    () => applyContactFilters(contacts, preset, contactFilters), [contacts, preset, contactFilters]);
  const presetCounts = useMemo(() => Object.fromEntries(
    PRESETS.map(p => [p.key, contacts.filter(p.fn).length])) as Record<ContactPreset, number>, [contacts]);
  const setContactFilter = (patch: Partial<ContactFilters>) => { setContactFilters(f => ({ ...f, ...patch })); resetPage(); };

  // ── Leads ───────────────────────────────────────────────────────────────────
  const filteredLeads = useMemo(
    () => applyLeadFilters(leads, leadFilters, outcomes), [leads, leadFilters, outcomes]);
  const leadTabCounts = useMemo(() => tabCounts(leads), [leads]);
  const setLeadFilter = (patch: Partial<LeadFilters>) => { setLeadFilters(f => ({ ...f, ...patch })); resetPage(); };
  const LEAD_COLUMNS = useMemo(() => leadColumns(outcomes), [outcomes]);

  // ── Whichever dataset is showing ────────────────────────────────────────────
  // Rows are typed loosely here so one table, one CSV builder and one pager
  // serve both; each column's `get` is still typed against its own row shape.
  const rows: any[] = isLeads ? filteredLeads : filteredContacts;
  const allColumns = (isLeads ? LEAD_COLUMNS : CONTACT_COLUMNS) as ColumnDef<any>[];
  const columns = allColumns.filter(col => withDates || !col.ownerOnly);
  const cols = isLeads ? leadCols : contactCols;
  const setCols = isLeads ? setLeadCols : setContactCols;
  const activeCols = columns.filter(col => cols.has(col.key));
  const extraCols = activeCols.filter(col => col.key !== 'name' && col.key !== 'email');
  const loading = isLeads ? leadsLoading && leads.length === 0 : contactsLoading && contacts.length === 0;
  const noun = isLeads ? 'lead' : 'contact';

  const chips = isLeads
    ? activeChips(leadFilters)
        // The tab strip already shows the status, so it is not repeated as a chip.
        .filter(c => c.key !== 'status')
        .map(c => ({ id: c.key, label: c.label, clear: () => setLeadFilter({ [c.key]: DEFAULT_FILTERS[c.key] } as Partial<LeadFilters>) }))
    : contactChips(contactFilters).map(c => ({
        id: c.keys.join(','), label: c.label,
        clear: () => setContactFilter(Object.fromEntries(c.keys.map(k => [k, DEFAULT_CONTACT_FILTERS[k]])) as Partial<ContactFilters>),
      }));
  const activeCount = isLeads ? countActive(leadFilters) - (leadFilters.status !== 'all' ? 1 : 0) : chips.length;

  const clearFilters = () => {
    if (isLeads) setLeadFilters(f => ({ ...DEFAULT_FILTERS, status: f.status }));
    else setContactFilters(DEFAULT_CONTACT_FILTERS);
    resetPage();
  };

  const totalPages = Math.ceil(rows.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleCol = (key: string) => {
    setCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const buildTable = () => ({
    headers: activeCols.map(col => col.label),
    rows: rows.map(r => activeCols.map(col => col.get(r))),
  });

  const plural = (n: number, w = noun) => `${n} ${w}${n !== 1 ? 's' : ''}`;

  const downloadCsv = () => {
    if (rows.length === 0) { toast(`No ${noun}s to export.`, 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    const { headers, rows: body } = buildTable();
    const date = new Date().toISOString().slice(0, 10);
    const name = isLeads ? `linkedin-leads-${leadFilters.status}` : `contacts-${preset}`;
    downloadTextFile(`${name}-${date}.csv`, toDelimitedText(headers, body, ','), 'text/csv');
    toast(`Exported ${plural(rows.length)}.`, 'success');
  };

  const copyEmails = async () => {
    // A lead can have no email, and one address can appear on several leads.
    const emails = [...new Set(rows.map(r => r.email as string | null).filter((e): e is string => !!e))];
    if (emails.length === 0) { toast('No emails to copy.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(emails.join('\n'));
      toast(`Copied ${plural(emails.length, 'email')}.`, 'success');
    } catch { toast('Could not copy to clipboard.', 'error'); }
  };

  const copyTsv = async () => {
    if (rows.length === 0) { toast(`No ${noun}s to copy.`, 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    try {
      const { headers, rows: body } = buildTable();
      await navigator.clipboard.writeText(toDelimitedText(headers, body, '\t'));
      toast('Copied table to clipboard.', 'success');
    } catch { toast('Could not copy to clipboard.', 'error'); }
  };

  const renderCell = (row: any, col: ColumnDef<any>) => {
    if (!isLeads && col.key === 'status') return <StatusBadge status={row.status} />;
    if (isLeads && col.key === 'stage') {
      const stage = stageOf(outcomeOf(row, outcomes));
      return <span className={`badge ${STAGE_BADGE[stage]}`}>{STAGE_LABELS[stage]}</span>;
    }
    const v = col.get(row);
    if (/^https?:\/\//.test(v) && !v.includes(' ')) {
      return <a href={v} target="_blank" rel="noopener noreferrer">Open <i className="ti ti-external-link" /></a>;
    }
    return v;
  };

  // ── Not-configured state ────────────────────────────────────────────────────
  if (notConfigured && !session.owner) {
    return (
      <Layout title="Export Contacts" subtitle="Shareable contact export">
        <div className="empty-state" style={{ flexDirection: 'column', gap: 10, padding: '48px 20px' }}>
          <i className="ti ti-lock-off" style={{ fontSize: 36 }} />
          <div>Sharing isn't configured yet.</div>
        </div>
      </Layout>
    );
  }

  // ── Password gate ───────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <Layout title="Export Contacts" subtitle="Enter the share password to continue">
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 16px' }}>
          <form onSubmit={submitPassword} className="table-card" style={{ padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <i className="ti ti-lock" style={{ fontSize: 34, color: 'var(--text2)' }} />
              <div style={{ fontWeight: 600, marginTop: 8 }}>Shared contact export</div>
              <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>Enter the password you were given.</div>
            </div>
            <input
              type="password" placeholder="Share password" value={password} autoFocus
              onChange={e => { setPassword(e.target.value); setPwError(''); }}
              style={{ width: '100%', marginBottom: 10 }}
            />
            {pwError && <div style={{ color: 'var(--red, #e5484d)', fontSize: 13, marginBottom: 10 }}>{pwError}</div>}
            <button className="btn btn-primary" type="submit" disabled={submitting || !password} style={{ width: '100%' }}>
              {submitting ? 'Checking…' : 'Continue'}
            </button>
          </form>
        </div>
      </Layout>
    );
  }

  // ── Export view ─────────────────────────────────────────────────────────────
  return (
    <Layout title="Export Contacts" subtitle="Pick a source, filter it, then download or copy">
      <div className="nav-tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`nav-tab${!isLeads ? ' active' : ''}`}
          onClick={() => { setDataset('contacts'); setShowFilters(false); resetPage(); }}>
          <i className="ti ti-mail" style={{ marginRight: 4 }} /> Outreach contacts
          <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{contacts.length}</span>
        </button>
        <button type="button" className={`nav-tab${isLeads ? ' active' : ''}`}
          onClick={() => { setDataset('leads'); setShowFilters(false); resetPage(); }}>
          <i className="ti ti-brand-linkedin" style={{ marginRight: 4 }} /> LinkedIn leads
          {leadsLoaded && <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{leads.length}</span>}
        </button>
      </div>

      {error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : (
        <>
          <div className="section-head">
            <div className="nav-tabs">
              {isLeads ? LEAD_TABS.map(key => (
                <button type="button" key={key} className={`nav-tab${leadFilters.status === key ? ' active' : ''}`}
                  onClick={() => setLeadFilter({ status: key })}>
                  {TAB_LABELS[key]}
                  <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{leadTabCounts[key]}</span>
                </button>
              )) : PRESETS.map(p => (
                <button type="button" key={p.key} className={`nav-tab${preset === p.key ? ' active' : ''}`}
                  onClick={() => { setPreset(p.key); resetPage(); }}>
                  {p.label}
                  <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{presetCounts[p.key]}</span>
                </button>
              ))}
            </div>
            <span className="contact-count-badge">{plural(rows.length)}</span>
          </div>

          <div className="filter-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input type="text"
              placeholder={isLeads ? 'Search name, email, company, links...' : 'Search name, email, company, role...'}
              value={isLeads ? leadFilters.search : contactFilters.search}
              onChange={e => (isLeads ? setLeadFilter : setContactFilter)({ search: e.target.value })}
              style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
            <div style={{ position: 'relative' }}>
              <button className={`btn btn-sm${showFilters || activeCount > 0 ? ' btn-primary' : ''}`} type="button"
                data-filter-trigger onClick={() => setShowFilters(v => !v)}>
                <i className="ti ti-filter" /> Filters
                {activeCount > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{activeCount}</span>}
                <i className={`ti ti-chevron-${showFilters ? 'up' : 'down'}`} style={{ marginLeft: 4, fontSize: 12 }} />
              </button>
              {showFilters && (isLeads ? (
                <LeadFilterPanel leads={leads} filters={leadFilters} onChange={setLeadFilter}
                  onReset={clearFilters} matched={filteredLeads.length} onClose={() => setShowFilters(false)} />
              ) : (
                <ExportContactFilterPanel contacts={contacts} filters={contactFilters} onChange={setContactFilter}
                  onReset={clearFilters} matched={filteredContacts.length} withDates={withDates}
                  onClose={() => setShowFilters(false)} />
              ))}
            </div>
            {isLeads && (
              <button className="btn btn-sm" type="button" disabled={leadFilters.hasEmail === 'yes'}
                onClick={() => setLeadFilter({ hasEmail: 'yes' })}
                title="Quick filter — same as “Has an email” in Filters">
                Only with email
              </button>
            )}
          </div>

          {chips.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              {chips.map(c => (
                <button key={c.id} className="btn btn-xs" type="button" onClick={c.clear} title="Remove this filter">
                  {c.label} <i className="ti ti-x" style={{ marginLeft: 2 }} />
                </button>
              ))}
              <button className="btn btn-xs" type="button" onClick={clearFilters}>
                <i className="ti ti-filter-off" /> Clear all
              </button>
            </div>
          )}

          <div className="table-card" style={{ padding: '12px 16px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>Columns to export</span>
              <button className="btn btn-xs" type="button" onClick={() => setCols(new Set(columns.map(c => c.key)))}>All</button>
              <button className="btn btn-xs" type="button"
                onClick={() => setCols(new Set(isLeads ? DEFAULT_LEAD_COLS : DEFAULT_CONTACT_COLS))}>Default</button>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {columns.map(col => (
                <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" className="row-cb" checked={cols.has(col.key)} onChange={() => toggleCol(col.key)} />
                  {col.label}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <button className="btn btn-primary" type="button" onClick={downloadCsv}>
              <i className="ti ti-download" /> Download CSV
            </button>
            <button className="btn" type="button" onClick={copyEmails}>
              <i className="ti ti-mail" /> Copy emails
            </button>
            <button className="btn" type="button" onClick={copyTsv}>
              <i className="ti ti-table" /> Copy table (TSV)
            </button>
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>{isLeads ? 'Lead' : 'Contact'}</th>
                  {extraCols.map(col => <th key={col.key}>{col.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={extraCols.length + 1}><div className="empty-state"><i className="ti ti-loader" />Loading…</div></td></tr>
                ) : paged.length === 0 ? (
                  <tr><td colSpan={extraCols.length + 1}><div className="empty-state"><i className="ti ti-users" />No {noun}s match this filter</div></td></tr>
                ) : paged.map((r, i) => {
                  const name = isLeads ? r.authorName : r.name;
                  return (
                    <tr key={(isLeads ? r.id : r.email) + i}>
                      <td>
                        <div className="contact-chip">
                          <Avatar name={name} />
                          <div><div className="name">{name}</div><div className="email">{r.email || 'No email'}</div></div>
                        </div>
                      </td>
                      {extraCols.map(col => (
                        <td key={col.key} style={{ color: 'var(--text2)' }}>{renderCell(r, col)}</td>
                      ))}
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
        </>
      )}
    </Layout>
  );
}
