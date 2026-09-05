import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { parseCsvText, readFileText } from '../lib/csv';

interface Row { name: string; email: string; company: string; role: string; template: string; }

const emptyRow = (template = ''): Row => ({ name: '', email: '', company: '', role: '', template });

export default function AddContacts() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [importedInfo, setImportedInfo] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { app.loadTemplates().catch(() => { /* select shows the empty state */ }); }, []);

  // Whatever templates you have — no built-in defaults.
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));
  const defaultTpl = templateOptions[0]?.key || '';

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const validRows = rows.filter(r => r.name.trim() && r.email.trim());

  const handleFile = async (file: File) => {
    const text = await readFileText(file);
    const parsed = parseCsvText(text);
    setRows(rs => [...rs, ...parsed.map(p => ({ ...p, template: defaultTpl }))]);
    setImportedInfo(`${parsed.length} contacts imported from ${file.name}`);
  };

  const save = async () => {
    if (validRows.length === 0) { toast('Please add at least one contact.', 'error'); return; }
    setSaving(true);
    try {
      const { created, skipped } = await app.createContacts(validRows.map(r => ({
        name: r.name.trim(), email: r.email.trim(), company: r.company.trim(), role: r.role.trim(), template: r.template || defaultTpl,
      })));
      if (created.length === 0) { toast('All contacts already exist — nothing added.', 'error'); return; }
      toast(`${created.length} added${skipped > 0 ? `, ${skipped} skipped (duplicate)` : ''}.`, 'success');
      navigate('/contacts');
    } catch (err: any) {
      toast('Could not save contacts: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout title="Add contacts" subtitle="Save contacts to your list — start a send flow later from the Contacts page" actions={
      <Link to="/contacts" className="btn btn-sm"><i className="ti ti-users" /> View contacts</Link>
    } wide>
      <div className="form-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="upload-zone" style={importedInfo ? { background: 'var(--green-bg)' } : undefined}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
          <i className="ti ti-table-import" />
          <div className="uz-title">{importedInfo || 'Drop a CSV or Excel file here'}</div>
          <div className="uz-sub">Columns detected: Name, Email, Company, Role</div>
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => fileRef.current?.click()} type="button">
            <i className="ti ti-upload" /> Browse file
          </button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
        </div>
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <a href="/sample-contacts.csv" download className="btn btn-xs" style={{ display: 'inline-flex' }}>
            <i className="ti ti-download" /> Download sample CSV
          </a>
        </div>
        <div className="divider-or">or enter manually</div>

        {rows.map((r, i) => (
          <div key={i} style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 12, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text2)' }}>Contact {i + 1}</span>
              <button className="btn btn-xs" style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }}
                onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} type="button"><i className="ti ti-trash" /></button>
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Full name *</label>
                <input type="text" placeholder="Rahul Sharma" value={r.name} onChange={e => setRow(i, { name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input type="email" placeholder="rahul@company.com" value={r.email} onChange={e => setRow(i, { email: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Company</label>
                <input type="text" placeholder="Acme Inc." value={r.company} onChange={e => setRow(i, { company: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <input type="text" placeholder="VP of Sales" value={r.role} onChange={e => setRow(i, { role: e.target.value })} />
              </div>
              <div className="form-group full">
                <label className="form-label">Template</label>
                <select value={r.template || defaultTpl} onChange={e => setRow(i, { template: e.target.value })}>
                  {templateOptions.length === 0 && <option value="">No templates — create one first</option>}
                  {templateOptions.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        ))}

        <button className="btn btn-sm" style={{ borderStyle: 'dashed', marginTop: 4 }} onClick={() => setRows(rs => [...rs, emptyRow()])} type="button">
          <i className="ti ti-plus" /> Add another contact
        </button>

        {validRows.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <span className="section-title">Contacts to save</span>
              <span className="contact-count-badge">{validRows.length} contact{validRows.length > 1 ? 's' : ''}</span>
            </div>
            {validRows.map((r, i) => (
              <div className="batch-row" key={i}>
                <Avatar name={r.name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', wordBreak: 'break-word' }}>{r.email} · {r.company}</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text2)', flexShrink: 0 }}>{r.template}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="step-footer">
        <Link to="/contacts" className="btn"><i className="ti ti-arrow-left" /> Cancel</Link>
        <button className="btn btn-primary" onClick={save} type="button" disabled={saving}>
          <i className="ti ti-user-plus" /> {saving ? 'Saving…' : 'Save contacts'}
        </button>
      </div>
    </Layout>
  );
}
