import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import { useSession } from '../context/SessionContext';
import { useToast } from '../context/ToastContext';
import { API_BASE } from '../lib/api';
import { toDelimitedText, downloadTextFile } from '../lib/csv';

const PAGE_SIZE = 25;

// Minimal, non-sensitive shape returned by GET /api/share/contacts.
interface ShareContact {
  name: string;
  email: string;
  company: string;
  role: string;
  status: string;
  replied: boolean;
  delivered: boolean;
}

const PRESETS: Array<{ key: string; label: string; fn: (c: ShareContact) => boolean }> = [
  { key: 'all', label: 'All contacts', fn: () => true },
  { key: 'replied', label: 'Ever replied', fn: c => c.replied },
  { key: 'delivered', label: 'Delivered (not bounced)', fn: c => c.delivered },
  { key: 'no-openings', label: 'No Openings', fn: c => c.status === 'no-openings' },
];

type ColumnDef = { key: string; label: string; get: (c: ShareContact) => string };

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', get: c => c.name },
  { key: 'email', label: 'Email', get: c => c.email },
  { key: 'company', label: 'Company', get: c => c.company },
  { key: 'role', label: 'Role', get: c => c.role },
  { key: 'status', label: 'Status', get: c => c.status },
];

export default function ExportContacts() {
  const session = useSession();
  const toast = useToast();
  const authed = session.owner || session.share;

  const [contacts, setContacts] = useState<ShareContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);

  // Password gate state
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pwError, setPwError] = useState('');

  // Export UI state
  const [preset, setPreset] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState<Set<string>>(new Set(COLUMNS.map(c => c.key)));

  const loadContacts = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/share/contacts`);
      if (res.status === 401) { return; } // not authed — gate will show
      if (res.status === 503) { setNotConfigured(true); return; }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setContacts(data.contacts || []);
    } catch (err: any) {
      setError(err.message || 'Could not load contacts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authed) loadContacts();
  }, [authed]);

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

  const filtered = useMemo(() => {
    const presetFn = (PRESETS.find(p => p.key === preset) || PRESETS[0]).fn;
    let list = contacts.filter(presetFn);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
    return list;
  }, [contacts, preset, search]);

  const resetPage = () => setPage(1);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const activeCols = COLUMNS.filter(col => cols.has(col.key));
  const extraCols = activeCols.filter(col => col.key !== 'name' && col.key !== 'email');

  const toggleCol = (key: string) => {
    setCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const buildTable = () => ({
    headers: activeCols.map(col => col.label),
    rows: filtered.map(c => activeCols.map(col => col.get(c))),
  });

  const downloadCsv = () => {
    if (filtered.length === 0) { toast('No contacts to export.', 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    const { headers, rows } = buildTable();
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(`contacts-${preset}-${date}.csv`, toDelimitedText(headers, rows, ','), 'text/csv');
    toast(`Exported ${filtered.length} contact${filtered.length !== 1 ? 's' : ''}.`, 'success');
  };

  const copyEmails = async () => {
    if (filtered.length === 0) { toast('No contacts to copy.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(filtered.map(c => c.email).join('\n'));
      toast(`Copied ${filtered.length} email${filtered.length !== 1 ? 's' : ''}.`, 'success');
    } catch { toast('Could not copy to clipboard.', 'error'); }
  };

  const copyTsv = async () => {
    if (filtered.length === 0) { toast('No contacts to copy.', 'error'); return; }
    if (activeCols.length === 0) { toast('Select at least one column.', 'error'); return; }
    try {
      const { headers, rows } = buildTable();
      await navigator.clipboard.writeText(toDelimitedText(headers, rows, '\t'));
      toast('Copied table to clipboard.', 'success');
    } catch { toast('Could not copy to clipboard.', 'error'); }
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
    <Layout title="Export Contacts" subtitle="Filter contacts, then download or copy them">
      {error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : (
        <>
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

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <input type="text" placeholder="Search name, email or company..." value={search}
              onChange={e => { setSearch(e.target.value); resetPage(); }}
              style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
            <button className="btn btn-sm" type="button" onClick={() => { setSearch(''); setPreset('all'); resetPage(); }}>
              Clear filters
            </button>
          </div>

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
                  <th>Contact</th>
                  {extraCols.map(col => <th key={col.key}>{col.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading && contacts.length === 0 ? (
                  <tr><td colSpan={extraCols.length + 1}><div className="empty-state"><i className="ti ti-loader" />Loading…</div></td></tr>
                ) : paged.length === 0 ? (
                  <tr><td colSpan={extraCols.length + 1}><div className="empty-state"><i className="ti ti-users" />No contacts match this filter</div></td></tr>
                ) : paged.map((c, i) => (
                  <tr key={c.email + i}>
                    <td>
                      <div className="contact-chip">
                        <Avatar name={c.name} />
                        <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
                      </div>
                    </td>
                    {extraCols.map(col => (
                      <td key={col.key} style={{ color: 'var(--text2)' }}>
                        {col.key === 'status' ? <StatusBadge status={c.status} /> : col.get(c)}
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
