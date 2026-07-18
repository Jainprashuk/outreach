import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { API_BASE, resetForSendApi, type Contact } from '../lib/api';
import { parseCsvText, readFileText } from '../lib/csv';
import { SkeletonRows } from '../components/Skeleton';

const PAGE_SIZE = 25;

const TABS = [
  ['all', 'All'], ['sent', 'Sent'], ['pending', 'Pending approval'], ['remaining', 'Remaining'],
  ['bounced', 'Bounced'], ['replied', 'Replied'], ['followup-due', 'Follow-up Due'],
  ['follow-up-sent', 'Follow-up Sent'], ['follow-up-replied', 'Replied after Follow-up'],
  ['closed', 'Closed'], ['no-openings', 'No Openings'], ['in-review', 'In Review'],
] as const;

export default function Contacts() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [tab, setTab] = useState(params.get('tab') || 'all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [importOk, setImportOk] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!app.loaded);
  const fileRef = useRef<HTMLInputElement>(null);
  const [failReasons, setFailReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    app.init().catch(err => setError(err.message)).finally(() => setLoading(false));
  }, []);

  const busy = loading && app.contacts.length === 0;

  const filtered = useMemo(() => {
    let list = app.filterContacts(tab);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
    if (statusFilter) list = list.filter(c => c.status === statusFilter);
    if (approvalFilter) list = list.filter(c => c.approvalStatus === approvalFilter);
    if (templateFilter) list = list.filter(c => c.template === templateFilter);
    return list;
  }, [app.contacts, tab, search, statusFilter, approvalFilter, templateFilter]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const allChecked = paged.length > 0 && paged.every(c => selected.has(c.id));
  const someChecked = paged.some(c => selected.has(c.id));

  const resetPage = () => setPage(1);

  const toggleRow = (id: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      paged.forEach(c => { if (checked) next.add(c.id); else next.delete(c.id); });
      return next;
    });
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
    for (const id of ids) {
      try { await app.deleteContact(id); }
      catch { failed++; }
    }
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
      await app.loadContacts();
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
      await resetForSendApi(ids);
      navigate(`/send/step2?from=contacts&ids=${ids.join(',')}`);
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
      await app.loadContacts();
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
    <Layout title="Contacts" subtitle={`${filtered.length} contacts`} actions={
      <a href="#" className="btn btn-primary" onClick={(e) => { e.preventDefault(); navigate('/add-contacts'); }}>
        <i className="ti ti-user-plus" /> Add contacts
      </a>
    }>
      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label]) => (
            <div key={key} className={`nav-tab${tab === key ? ' active' : ''}`}
              onClick={() => { setTab(key); resetPage(); }}>
              {label}
            </div>
          ))}
        </div>
        <span className="contact-count-badge">{filtered.length} contacts</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder="Search name, email or company..." value={search}
          onChange={e => { setSearch(e.target.value); resetPage(); }}
          style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
          <option value="">All statuses</option>
          <option value="queued">Queued</option><option value="sent">Sent</option>
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
        <button className="btn btn-sm" type="button" onClick={() => {
          setSearch(''); setStatusFilter(''); setApprovalFilter(''); setTemplateFilter(''); setTab('all'); resetPage();
        }}>Clear filters</button>
      </div>

      {/* CSV upload strip */}
      <div
        className={`upload-strip${dragOver ? ' drag-over' : ''}`}
        style={importOk ? { borderColor: 'var(--green)', background: 'var(--green-bg)' } : undefined}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
      >
        <i className="ti ti-table-import us-icon" />
        <div className="us-text"><strong>Upload CSV</strong> — drag &amp; drop or click to browse. Columns: Name, Email, Company, Role</div>
        <button className="btn btn-sm" style={{ pointerEvents: 'none' }} type="button"><i className="ti ti-upload" /> Browse</button>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }} />
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th className="cb-col">
                <input type="checkbox" className="row-cb" checked={allChecked}
                  ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                  onChange={e => toggleAll(e.target.checked)} title="Select all" />
              </th>
              <th>Contact</th><th>Company</th><th>Role</th><th>Template</th><th>Status</th><th>Approval</th><th></th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <SkeletonRows rows={8} cols={8} chipCol={1} />
            ) : error ? (
              <tr><td colSpan={8}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={8}><div className="empty-state"><i className="ti ti-users" />No contacts found</div></td></tr>
            ) : paged.map(c => (
              <tr key={c.id}>
                <td className="cb-col">
                  <input type="checkbox" className="row-cb" checked={selected.has(c.id)}
                    onChange={e => toggleRow(c.id, e.target.checked)} />
                </td>
                <td>
                  <div className="contact-chip">
                    <Avatar name={c.name} />
                    <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
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
                <td><StatusBadge status={c.approvalStatus} /></td>
                <td>
                  <button className="btn btn-sm" onClick={() => confirmDelete(c)} title="Delete contact" type="button">
                    <i className="ti ti-trash" />
                  </button>
                </td>
              </tr>
            ))}
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
        <select value="" onChange={e => { changeTemplateSelected(e.target.value); e.target.value = ''; }}
          style={{ width: 'auto', minWidth: 150 }} title="Change template for selected contacts">
          <option value="">Change template…</option>
          {(Object.keys(app.templates).length
            ? Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }))
            : [{ key: 'intro-v2', name: 'Intro v2' }, { key: 'follow-up', name: 'Follow-up' }, { key: 'cold', name: 'Cold outreach' }]
          ).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        <button className="btn btn-del" onClick={deleteSelected} type="button"><i className="ti ti-trash" /> Delete</button>
        <button className="btn btn-send" onClick={sendSelected} type="button">
          <i className="ti ti-send" /> {tab === 'followup-due' ? 'Send Follow-ups' : 'Send selected'}
        </button>
      </div>
    </Layout>
  );
}
