import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import ClassifierStatus from '../components/ClassifierStatus';
import InterviewCell from '../components/InterviewCell';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { API_BASE, loadContactCompaniesApi, resetForSendApi, type Contact } from '../lib/api';
import { CATEGORY_OPTIONS } from '../lib/format';
import { parseCsvText, readFileText } from '../lib/csv';
import { SkeletonRows } from '../components/Skeleton';
import { RefreshBar, Refreshing, CountOrSpinner } from '../components/RefreshBar';
import { useContactList, loadContactListIds, type ContactListQuery } from '../hooks/useContactList';
import CreateContactCampaignModal from '../components/CreateContactCampaignModal';
import ContactDateFilterPanel, {
  countActiveDateFilters, DEFAULT_DATE_FILTERS, type ContactDateFilters,
} from '../components/ContactDateFilterPanel';

const PAGE_SIZE = 25;

const TABS = [
  ['all', 'All'], ['sent', 'Sent'], ['pending', 'Pending approval'], ['remaining', 'Remaining'],
  ['in-campaign', 'In campaign'],
  ['bounced', 'Bounced'], ['replied', 'Replied'], ['followup-due', 'Follow-up Due'],
  ['follow-up-sent', 'Follow-up Sent'], ['follow-up-replied', 'Replied after Follow-up'],
  ['closed', 'Closed'], ['no-openings', 'No Openings'], ['in-review', 'In Review'], ['blocked', 'Blocked'],
] as const;

export default function Contacts() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [tab, setTab] = useState(params.get('tab') || 'all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState(params.get('source') || '');
  // The company being filtered on, and what's typed in its box (a filter only applies
  // once the text names one of your companies, so half a word doesn't empty the table).
  const [companyFilter, setCompanyFilter] = useState(params.get('company') || '');
  const [companyText, setCompanyText] = useState(params.get('company') || '');
  const [companies, setCompanies] = useState<{ company: string; n: number }[]>([]);
  const [dateFilters, setDateFilters] = useState<ContactDateFilters>(DEFAULT_DATE_FILTERS);
  const [showDateFilters, setShowDateFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [importOk, setImportOk] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [failReasons, setFailReasons] = useState<Record<string, string>>({});
  const [creatingCampaign, setCreatingCampaign] = useState(false);

  // Templates + settings only: the table pages its contacts on the server.
  useEffect(() => {
    app.initMeta().catch(err => setError(err.message));
    loadContactCompaniesApi().then(r => setCompanies(r.companies)).catch(() => { /* the box still accepts typing */ });
  }, []);

  const pickCompany = (text: string) => {
    setCompanyText(text);
    const t = text.trim().replace(/\s+/g, ' ').toLowerCase();
    const hit = t ? companies.find(c => c.company.toLowerCase() === t) : null;
    const next = !t ? '' : hit ? hit.company : companyFilter;
    if (next !== companyFilter) { setCompanyFilter(next); resetPage(); }
  };

  const query: ContactListQuery = {
    tab, search, status: statusFilter, approval: approvalFilter, template: templateFilter,
    category: categoryFilter, source: sourceFilter, company: companyFilter, ...dateFilters,
  };
  // Filtered ids are only needed to draw the select-all checkbox, i.e. once something is selected.
  const list = useContactList(query, page, { withIds: selected.size > 0 });
  useEffect(() => { if (list.error) setError(list.error); }, [list.error]);

  const busy = !list.data;
  // A refetch with rows already on screen (first loads show skeletons instead).
  const refreshing = list.loading && !!list.data;
  // "First N" / "All" wait on the server for the matching ids; which one is running.
  const [selecting, setSelecting] = useState<number | 'all' | null>(null);
  const filteredCount = list.data?.total ?? 0;

  const dateFilterCount = countActiveDateFilters(dateFilters);

  const totalPages = list.data?.pages ?? 1;
  const safePage = list.data?.page ?? 1;
  const paged = list.data?.contacts ?? [];

  const filteredIds = list.data?.ids ?? [];
  const allChecked = selected.size > 0 && filteredIds.length > 0 && filteredIds.every(id => selected.has(id));
  const someChecked = selected.size > 0 && filteredIds.some(id => selected.has(id));

  const resetPage = () => setPage(1);

  const toggleRow = (id: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  // Quick-select the first N contacts of the current filtered list (replaces the
  // current selection so counts stay predictable across pages).
  const selectFirst = async (n: number) => {
    setSelecting(n);
    try {
      const ids = await loadContactListIds(query);
      setSelected(new Set(ids.slice(0, n)));
    } catch (err: any) { toast(err.message, 'error'); }
    finally { setSelecting(null); }
  };

  const toggleAll = async (checked: boolean) => {
    setSelecting('all');
    try {
      const ids = await loadContactListIds(query);
      setSelected(prev => {
        const next = new Set(prev);
        ids.forEach(id => { if (checked) next.add(id); else next.delete(id); });
        return next;
      });
    } catch (err: any) { toast(err.message, 'error'); }
    finally { setSelecting(null); }
  };

  const confirmDelete = async (c: Contact) => {
    if (!confirm(`Delete ${c.name} (${c.email})?\nThis will hide the contact from all views.`)) return;
    try {
      await app.deleteContact(c.id);
      setSelected(prev => { const n = new Set(prev); n.delete(c.id); return n; });
      toast(`${c.name} deleted.`, 'success');
      setPage(1);
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} contact${selected.size !== 1 ? 's' : ''}? This will hide them from all views.`)) return;
    const ids = [...selected];
    let failed = 0;
    try { ({ failed } = await app.deleteContacts(ids)); }
    catch { failed = ids.length; }
    setSelected(new Set());
    toast(
      failed === 0 ? `${ids.length} contact${ids.length !== 1 ? 's' : ''} deleted.` : `${ids.length - failed} deleted, ${failed} failed.`,
      failed ? 'error' : 'success',
    );
    setPage(1);
  };

  const changeTemplateSelected = async (template: string) => {
    if (!template || selected.size === 0) return;
    const ids = [...selected];
    try {
      await app.bulkUpdateContacts(ids.map(id => ({ id, template })));
      list.reload();
      toast(`Template updated for ${ids.length} contact${ids.length !== 1 ? 's' : ''}.`, 'success');
    } catch (err: any) {
      toast('Could not update template: ' + err.message, 'error');
    }
  };

  const sendSelected = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    if (tab === 'followup-due') {
      navigate(`/send/step1?followup=1&ids=${ids.join(',')}`);
      return;
    }
    try {
      const { contacts, skipped, cooldownLabel } = await resetForSendApi(ids);
      if (skipped.length > 0) {
        const reserved = skipped.filter(c => c.reason === 'in_campaign').length;
        const blocked = skipped.filter(c => c.reason === 'blocked').length;
        const interviewing = skipped.filter(c => c.reason === 'in_interview').length;
        const awaitingYou = skipped.filter(c => c.reason === 'replied').length;
        const cooldown = skipped.length - reserved - blocked - interviewing - awaitingYou;
        toast(
          [
            cooldown ? `${cooldown} contact${cooldown !== 1 ? 's were' : ' was'} skipped — already emailed in the last ${cooldownLabel}.` : '',
            reserved ? `${reserved} contact${reserved !== 1 ? 's are' : ' is'} already reserved by a campaign.` : '',
            blocked ? `${blocked} contact${blocked !== 1 ? 's are' : ' is'} blocklisted and won't be sent to.` : '',
            interviewing ? `${interviewing} contact${interviewing !== 1 ? 's are' : ' is'} in your interview pipeline — outreach is stopped for them.` : '',
            awaitingYou ? `${awaitingYou} contact${awaitingYou !== 1 ? 's have' : ' has'} replied and ${awaitingYou !== 1 ? 'are' : 'is'} waiting on your answer — reply from the Mailbox.` : '',
          ].filter(Boolean).join(' '),
          contacts.length === 0 ? 'error' : 'info',
        );
        list.reload();
      }
      if (contacts.length === 0) return;
      navigate(`/send/step2?from=contacts&ids=${contacts.map(c => c.id).join(',')}`);
    } catch (err: any) {
      toast('Could not queue contacts: ' + err.message, 'error');
    }
  };

  const processFile = async (file: File) => {
    const text = await readFileText(file);
    const rows = parseCsvText(text).filter(r => r.name && r.email);
    if (rows.length === 0) { toast('No valid contacts found in CSV.', 'error'); return; }
    try {
      const { created, skipped } = await app.createContacts(rows);
      const skipMsg = skipped > 0 ? ` (${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped)` : '';
      toast(
        `${created.length} contact${created.length !== 1 ? 's' : ''} imported from ${file.name}${skipMsg}.`,
        skipped > 0 && created.length === 0 ? 'error' : 'success',
      );
      setImportOk(true);
      list.reload();
      setPage(1);
      setTimeout(() => setImportOk(false), 3000);
    } catch (err: any) {
      toast('Import failed: ' + err.message, 'error');
    }
  };

  const loadFailReason = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/contacts/${id}/fail-reason`);
      const data = await res.json();
      setFailReasons(prev => ({ ...prev, [id]: data.reason || 'No reason recorded.' }));
    } catch { /* leave button */ }
  };

  const tplName = (key: string) => app.templates[key]?.name || key;

  return (
    <Layout title="Contacts" subtitle={`${filteredCount} contacts`} actions={
      <a href="#" className="btn btn-primary" onClick={(e) => { e.preventDefault(); navigate('/add-contacts'); }}>
        <i className="ti ti-user-plus" /> Add contacts
      </a>
    }>
      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label]) => (
            <button type="button" key={key} className={`nav-tab${tab === key ? ' active' : ''}`}
              onClick={() => { setTab(key); resetPage(); }}>
              {label}
            </button>
          ))}
        </div>
        <span className="contact-count-badge"><CountOrSpinner loading={refreshing}>{filteredCount} contacts</CountOrSpinner></span>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder="Search name, email or company..." value={search}
          onChange={e => { setSearch(e.target.value); resetPage(); }}
          style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
          <option value="">All statuses</option>
          <option value="queued">Queued</option><option value="in-campaign">In campaign</option><option value="sent">Sent</option>
          <option value="failed">Failed</option><option value="bounced">Bounced</option>
          <option value="replied">Replied</option>
        </select>
        <select value={approvalFilter} onChange={e => { setApprovalFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
          <option value="">All approvals</option>
          <option value="pending">Pending</option><option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select value={templateFilter} onChange={e => { setTemplateFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
          <option value="">All templates</option>
          {Object.keys(app.templates).map(key => <option key={key} value={key}>{tplName(key)}</option>)}
        </select>
        <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 150 }}>
          <option value="">All reply categories</option>
          {CATEGORY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input type="text" list="contact-companies" value={companyText} placeholder="All companies"
            title="Show one company's contacts — pick from the list"
            onChange={e => pickCompany(e.target.value)}
            style={{ width: 180, paddingRight: companyText ? 28 : undefined, ...(companyFilter ? { borderColor: 'var(--accent)' } : {}) }} />
          <datalist id="contact-companies">
            {companies.slice(0, 1500).map(c => <option key={c.company} value={c.company}>{c.n} contact{c.n === 1 ? '' : 's'}</option>)}
          </datalist>
          {companyText && (
            <button type="button" aria-label="Clear company" onClick={() => pickCompany('')}
              style={{ position: 'absolute', right: 6, background: 'none', border: 0, cursor: 'pointer', color: 'var(--text3)', padding: 2 }}>
              <i className="ti ti-x" />
            </button>
          )}
        </div>
        <select value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
          <option value="">All sources</option>
          <option value="lead">From a lead</option>
          <option value="discover">From Discover</option>
          <option value="outreach">Added directly</option>
        </select>
        <div style={{ position: 'relative' }}>
          <button className={`btn btn-sm${showDateFilters || dateFilterCount > 0 ? ' btn-primary' : ''}`} type="button"
            data-filter-trigger onClick={() => setShowDateFilters(v => !v)}>
            <i className="ti ti-calendar" /> Dates
            {dateFilterCount > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{dateFilterCount}</span>}
            <i className={`ti ti-chevron-${showDateFilters ? 'up' : 'down'}`} style={{ marginLeft: 4, fontSize: 12 }} />
          </button>
          {showDateFilters && (
            <ContactDateFilterPanel filters={dateFilters} onChange={patch => { setDateFilters(prev => ({ ...prev, ...patch })); resetPage(); }}
              onReset={() => { setDateFilters(DEFAULT_DATE_FILTERS); resetPage(); }}
              matched={filteredCount} total={list.data?.stats.total ?? 0} onClose={() => setShowDateFilters(false)} />
          )}
        </div>
        <button className="btn btn-sm" type="button" onClick={() => {
          setSearch(''); setStatusFilter(''); setApprovalFilter(''); setTemplateFilter(''); setCategoryFilter(''); setSourceFilter('');
          setCompanyFilter(''); setCompanyText('');
          setDateFilters(DEFAULT_DATE_FILTERS); setTab('all'); resetPage();
        }}>Clear filters</button>
      </div>

      {/* CSV upload strip */}
      <div
        className={`upload-strip${dragOver ? ' drag-over' : ''}`}
        style={importOk ? { borderColor: 'var(--green)', background: 'var(--green-bg)' } : undefined}
        role="button" tabIndex={0}
        aria-label="Upload a CSV of contacts"
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
      >
        <i className="ti ti-table-import us-icon" />
        <div className="us-text"><strong>Upload CSV</strong> — drag &amp; drop or click to browse. Columns: Name, Email, Company, Role</div>
        <button className="btn btn-sm" style={{ pointerEvents: 'none' }} type="button" tabIndex={-1} aria-hidden="true"><i className="ti ti-upload" /> Browse</button>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }} />
      </div>

      <div className="quick-select" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0 10px' }}>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>Quick select:</span>
        {[50, 100, 200, 500].map(n => (
          <button key={n} className="btn btn-sm" type="button" disabled={filteredCount === 0 || selecting !== null}
            onClick={() => selectFirst(n)}
            title={`Select the first ${n} contacts in this view`}>
            {selecting === n && <i className="ti ti-loader" aria-hidden="true" />} First {n}
          </button>
        ))}
        <button className="btn btn-sm" type="button" disabled={filteredCount === 0 || selecting !== null}
          onClick={() => toggleAll(true)}>
          {selecting === 'all' && <i className="ti ti-loader" aria-hidden="true" />} All ({filteredCount})
        </button>
        <button className="btn btn-sm" type="button" disabled={selected.size === 0}
          onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>

      {/* Refetching after a tab / filter / page change: keep the rows, dimmed. */}
      <RefreshBar active={refreshing} />
      <Refreshing active={refreshing}>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th className="cb-col">
                <input type="checkbox" className="row-cb" checked={allChecked}
                  ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                  disabled={selecting !== null}
                  onChange={e => toggleAll(e.target.checked)} title="Select all" />
              </th>
              <th>Contact</th><th>Company</th><th>Role</th><th>Template</th><th>Status</th><th>Category</th><th>Approval</th><th>Interview</th><th></th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <SkeletonRows rows={8} cols={10} chipCol={1} />
            ) : error ? (
              <tr><td colSpan={10}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={10}><div className="empty-state"><i className="ti ti-users" />No contacts found</div></td></tr>
            ) : paged.map(c => (
              <tr key={c.id}>
                <td className="cb-col">
                  <input type="checkbox" className="row-cb" checked={selected.has(c.id)}
                    onChange={e => toggleRow(c.id, e.target.checked)} />
                </td>
                <td>
                  <div className="contact-chip">
                    <Avatar name={c.name} />
                    <div>
                      <div className="name">
                        {c.name}
                        {c.source === 'lead' && (
                          <i className="ti ti-target-arrow" title="Promoted from a lead"
                            style={{ marginLeft: 6, fontSize: 13, color: 'var(--text3)' }} />
                        )}
                        {c.prospectId && (
                          <i className="ti ti-compass" title="Found with Discover — address guessed"
                            style={{ marginLeft: 6, fontSize: 13, color: 'var(--text3)' }} />
                        )}
                      </div>
                      <div className="email">{c.email}</div>
                    </div>
                  </div>
                </td>
                <td style={{ color: 'var(--text2)' }}>{c.company}</td>
                <td style={{ color: 'var(--text2)' }}>{c.role}</td>
                <td style={{ color: 'var(--text2)' }}>{tplName(c.template)}</td>
                <td>
                  <div>
                    <StatusBadge status={c.status} contact={c} />
                    {c.status === 'failed' && (c.failReason || failReasons[c.id]) ? (
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, maxWidth: 180, whiteSpace: 'normal', lineHeight: 1.3 }}>
                        {c.failReason || failReasons[c.id]}
                      </div>
                    ) : c.status === 'failed' ? (
                      <button className="btn btn-sm" style={{ marginTop: 4, fontSize: 11, padding: '2px 7px' }}
                        onClick={() => loadFailReason(c.id)} type="button">Why?</button>
                    ) : null}
                  </div>
                </td>
                <td><ClassifierStatus contact={c} /></td>
                <td><StatusBadge status={c.approvalStatus} /></td>
                <td>
                  {/* Additive: links to the interview record, or starts one.
                      Never writes to the contact's own status. */}
                  <InterviewCell seed={{
                    sourceType: 'contact', sourceId: c.id,
                    name: c.name, email: c.email, company: c.company, role: c.role,
                  }} />
                </td>
                <td>
                  <button aria-label="Delete contact" className="btn btn-sm" onClick={() => confirmDelete(c)} title="Delete contact" type="button"><i className="ti ti-trash" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Refreshing>

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
        <select value="" onChange={e => { changeTemplateSelected(e.target.value); e.target.value = ''; }}
          style={{ width: 'auto', minWidth: 150 }} title="Change template for selected contacts">
          <option value="">Change template…</option>
          {Object.entries(app.templates).map(([key, tpl]) => (
            <option key={key} value={key}>{tpl.name}</option>
          ))}
        </select>
        <button className="btn btn-del" onClick={deleteSelected} type="button"><i className="ti ti-trash" /> Delete</button>
        <button className="btn btn-sm" onClick={() => setCreatingCampaign(true)} type="button">
          <i className="ti ti-speakerphone" /> Create campaign
        </button>
        <button className="btn btn-send" onClick={sendSelected} type="button">
          <i className="ti ti-send" /> {tab === 'followup-due' ? 'Send Follow-ups' : 'Send selected'}
        </button>
      </div>
      {creatingCampaign && <CreateContactCampaignModal contactIds={[...selected]} onClose={() => setCreatingCampaign(false)} />}
    </Layout>
  );
}
