import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import type { Contact } from '../lib/api';
import { toDelimitedText, downloadTextFile } from '../lib/csv';

const PAGE_SIZE = 25;

const PRESETS: Array<{ key: string; label: string; fn: (c: Contact) => boolean }> = [
  { key: 'all', label: 'All contacts', fn: () => true },
  { key: 'replied', label: 'Ever replied', fn: c => !!c.repliedAt || c.status === 'replied' || c.status === 'follow-up-replied' },
  { key: 'delivered', label: 'Delivered (not bounced)', fn: c => !!c.lastSentAt && c.status !== 'bounced' && c.status !== 'failed' },
  { key: 'sent', label: 'Sent', fn: c => c.status === 'sent' },
  { key: 'follow-up-sent', label: 'Follow-up sent', fn: c => c.status === 'follow-up-sent' },
  { key: 'bounced', label: 'Bounced', fn: c => c.status === 'bounced' },
  { key: 'failed', label: 'Failed', fn: c => c.status === 'failed' },
  { key: 'queued', label: 'Not contacted', fn: c => c.status === 'queued' },
  { key: 'closed', label: 'Closed', fn: c => c.status === 'closed' },
];

const fmtDate = (d: string | null): string => {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
};

type ColumnDef = { key: string; label: string; get: (c: Contact, tplName: (k: string) => string) => string };

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', get: c => c.name },
  { key: 'email', label: 'Email', get: c => c.email },
  { key: 'company', label: 'Company', get: c => c.company },
  { key: 'role', label: 'Role', get: c => c.role },
  { key: 'template', label: 'Template', get: (c, t) => t(c.template) },
  { key: 'status', label: 'Status', get: c => c.status },
  { key: 'approvalStatus', label: 'Approval', get: c => c.approvalStatus },
  { key: 'repliedAt', label: 'Replied At', get: c => fmtDate(c.repliedAt) },
  { key: 'replySnippet', label: 'Reply Snippet', get: c => c.replySnippet || '' },
  { key: 'bounceReason', label: 'Bounce Reason', get: c => c.bounceReason || '' },
  { key: 'lastSentAt', label: 'Last Sent At', get: c => fmtDate(c.lastSentAt) },
  { key: 'sentSubject', label: 'Sent Subject', get: c => c.sentSubject || '' },
  { key: 'createdAt', label: 'Created At', get: c => fmtDate(c.createdAt) },
];

const DEFAULT_COLS = ['name', 'email', 'company', 'role', 'status'];

export default function ExportContacts() {
  const app = useApp();
  const toast = useToast();

  const [preset, setPreset] = useState('all');
  const [search, setSearch] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState<Set<string>>(new Set(DEFAULT_COLS));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!app.loaded);

  useEffect(() => {
    app.init().catch(err => setError(err.message)).finally(() => setLoading(false));
  }, []);

  const tplName = (key: string) => app.templates[key]?.name || key;

  const filtered = useMemo(() => {
    const presetFn = (PRESETS.find(p => p.key === preset) || PRESETS[0]).fn;
    let list = app.contacts.filter(presetFn);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
    if (templateFilter) list = list.filter(c => c.template === templateFilter);
    return list;
  }, [app.contacts, preset, search, templateFilter]);

  const resetPage = () => setPage(1);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Selected columns in their canonical (COLUMNS) order.
  const activeCols = COLUMNS.filter(col => cols.has(col.key));

  const toggleCol = (key: string) => {
    setCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const buildTable = (): { headers: string[]; rows: string[][] } => ({
    headers: activeCols.map(col => col.label),
    rows: filtered.map(c => activeCols.map(col => col.get(c, tplName))),
  });

  const downloadCsv = () => {
    if (filtered.length === 0) { toast('No contacts to export.', 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    const { headers, rows } = buildTable();
    const text = toDelimitedText(headers, rows, ',');
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(`contacts-${preset}-${date}.csv`, text, 'text/csv');
    toast(`Exported ${filtered.length} contact${filtered.length !== 1 ? 's' : ''}.`, 'success');
  };

  const copyEmails = async () => {
    if (filtered.length === 0) { toast('No contacts to copy.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(filtered.map(c => c.email).join('\n'));
      toast(`Copied ${filtered.length} email${filtered.length !== 1 ? 's' : ''}.`, 'success');
    } catch {
      toast('Could not copy to clipboard.', 'error');
    }
  };

  const copyTsv = async () => {
    if (filtered.length === 0) { toast('No contacts to copy.', 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    try {
      const { headers, rows } = buildTable();
      await navigator.clipboard.writeText(toDelimitedText(headers, rows, '\t'));
      toast('Copied table to clipboard.', 'success');
    } catch {
      toast('Could not copy to clipboard.', 'error');
    }
  };

  return (
    <Layout title="Export Contacts" subtitle="Filter contacts by outcome, then download or copy them">
      {error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : (
        <>
          {/* Preset filters */}
          <div className="section-head">
            <div className="nav-tabs">
              {PRESETS.map(p => (
                <div key={p.key} className={`nav-tab${preset === p.key ? ' active' : ''}`}
                  onClick={() => { setPreset(p.key); resetPage(); }}>
                  {p.label}
                </div>
              ))}
            </div>
            <span className="contact-count-badge">{filtered.length} contacts</span>
          </div>

          {/* Narrowing filters */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <input type="text" placeholder="Search name, email or company..." value={search}
              onChange={e => { setSearch(e.target.value); resetPage(); }}
              style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
            <select value={templateFilter} onChange={e => { setTemplateFilter(e.target.value); resetPage(); }} style={{ width: 'auto', minWidth: 140 }}>
              <option value="">All templates</option>
              {Object.keys(app.templates).map(key => <option key={key} value={key}>{tplName(key)}</option>)}
            </select>
            <button className="btn btn-sm" type="button" onClick={() => {
              setSearch(''); setTemplateFilter(''); setPreset('all'); resetPage();
            }}>Clear filters</button>
          </div>

          {/* Column picker */}
          <div className="table-card" style={{ padding: '12px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Columns to export</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {COLUMNS.map(col => (
                <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" className="row-cb" checked={cols.has(col.key)} onChange={() => toggleCol(col.key)} />
                  {col.label}
                </label>
              ))}
            </div>
          </div>

          {/* Action bar */}
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

          {/* Preview table */}
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Contact</th>
                  {activeCols.filter(col => col.key !== 'name' && col.key !== 'email').map(col => <th key={col.key}>{col.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading && app.contacts.length === 0 ? (
                  <tr><td colSpan={activeCols.length + 1}><div className="empty-state"><i className="ti ti-loader" />Loading…</div></td></tr>
                ) : paged.length === 0 ? (
                  <tr><td colSpan={activeCols.length + 1}><div className="empty-state"><i className="ti ti-users" />No contacts match this filter</div></td></tr>
                ) : paged.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="contact-chip">
                        <Avatar name={c.name} />
                        <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
                      </div>
                    </td>
                    {activeCols.filter(col => col.key !== 'name' && col.key !== 'email').map(col => (
                      <td key={col.key} style={{ color: 'var(--text2)' }}>
                        {col.key === 'status' ? <StatusBadge status={c.status} contact={c} />
                          : col.key === 'approvalStatus' ? <StatusBadge status={c.approvalStatus} />
                          : col.get(c, tplName)}
                      </td>
                    ))}
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
        </>
      )}
    </Layout>
  );
}
