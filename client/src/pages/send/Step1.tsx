import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import Avatar from '../../components/Avatar';
import Stepper from './Stepper';
import ModePicker, { type SendMode } from './ModePicker';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch, bulkUpdateContactsApi, resetForSendApi } from '../../lib/api';
import { parseCsvText, readFileText } from '../../lib/csv';

interface Row { name: string; email: string; company: string; role: string; template: string; }

const emptyRow = (template = ''): Row => ({ name: '', email: '', company: '', role: '', template });

export default function Step1() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const isFollowUpMode = params.get('followup') === '1';
  const followupIds = isFollowUpMode ? (params.get('ids')?.split(',').filter(Boolean) || []) : [];
  const urlMode = params.get('mode');

  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<SendMode>('bulk');
  const [dripRate, setDripRate] = useState(5);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importedInfo, setImportedInfo] = useState('');
  const followupMap = useRef<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      if (urlMode === 'bulk' || urlMode === 'sequential' || urlMode === 'drip') {
        setMode(urlMode);
      } else if (!isFollowUpMode) {
        setPickerOpen(true);
      }

      try { await app.loadTemplates(); } catch { /* select shows the empty state */ }

      if (isFollowUpMode && followupIds.length > 0) {
        try {
          const data = await apiFetch<any>(`/api/contacts?ids=${followupIds.join(',')}`);
          const contacts = data.contacts || data;
          const map: Record<string, string> = {};
          const pre: Row[] = contacts.map((c: any) => {
            map[c.email.toLowerCase()] = c.id;
            return { name: c.name, email: c.email, company: c.company, role: c.role, template: 'follow-up' };
          });
          followupMap.current = map;
          setRows(pre);
        } catch (err: any) {
          toast('Could not load follow-up contacts: ' + err.message, 'error');
        }
      } else if (!isFollowUpMode) {
        setRows([emptyRow()]);
      }
    })();
  }, []);

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

  const goNext = async () => {
    if (validRows.length === 0) { toast('Please add at least one contact.', 'error'); return; }
    const rateParam = mode === 'drip' ? `&rate=${dripRate}` : '';

    if (isFollowUpMode) {
      const keptIds = validRows.map(r => followupMap.current[r.email.trim().toLowerCase()]).filter(Boolean);
      if (keptIds.length === 0) { toast('No valid follow-up contacts found.', 'error'); return; }
      try {
        const { contacts, skipped, cooldownLabel } = await resetForSendApi(keptIds);
        if (skipped.length > 0) {
          toast(`${skipped.length} skipped — already emailed in the last ${cooldownLabel}.`, contacts.length === 0 ? 'error' : 'info');
        }
        if (contacts.length === 0) return;
        const sendIds = contacts.map(c => c.id);
        await bulkUpdateContactsApi(sendIds.map(id => ({ id, template: 'follow-up' })));
        navigate(`/send/step2?mode=${mode}&ids=${sendIds.join(',')}${rateParam}`);
      } catch (err: any) {
        toast('Could not prepare follow-up contacts: ' + err.message, 'error');
      }
      return;
    }

    try {
      const { created, skipped } = await app.createContacts(validRows.map(r => ({
        name: r.name.trim(), email: r.email.trim(), company: r.company.trim(), role: r.role.trim(), template: r.template || defaultTpl,
      })));
      if (created.length === 0) { toast('All contacts already exist — nothing added.', 'error'); return; }
      toast(`${created.length} added${skipped > 0 ? `, ${skipped} skipped (duplicate)` : ''}.`, 'success');
      navigate(`/send/step2?mode=${mode}&ids=${created.map(c => c.id).join(',')}${rateParam}`);
    } catch (err: any) {
      toast('Could not save contacts: ' + err.message, 'error');
    }
  };

  return (
    <Layout title="New entry" subtitle={isFollowUpMode ? 'Step 1 of 3 — Review follow-up contacts' : 'Step 1 of 3 — Add contacts'} actions={
      <Link to="/" className="btn btn-sm"><i className="ti ti-x" /> Cancel</Link>
    } wide>
      <Stepper current={1} />

      <div className="form-body" style={{ flex: 1, overflowY: 'auto' }}>
        {!isFollowUpMode && (
          <>
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
          </>
        )}

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

        {!isFollowUpMode && (
          <button className="btn btn-sm" style={{ borderStyle: 'dashed', marginTop: 4 }} onClick={() => setRows(rs => [...rs, emptyRow()])} type="button">
            <i className="ti ti-plus" /> Add another contact
          </button>
        )}

        {validRows.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <span className="section-title">Contacts in this batch</span>
              <span className="contact-count-badge">{validRows.length} contact{validRows.length > 1 ? 's' : ''}</span>
            </div>
            {validRows.map((r, i) => (
              <div className="batch-row" key={i}>
                <Avatar name={r.name} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text2)' }}>{r.email} · {r.company}</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{r.template}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="step-footer">
        <Link to="/" className="btn"><i className="ti ti-arrow-left" /> Back</Link>
        <button className="btn btn-primary" onClick={goNext} type="button">
          Next — approve templates <i className="ti ti-arrow-right" />
        </button>
      </div>

      <ModePicker open={pickerOpen} mode={mode} onPick={setMode} onConfirm={() => setPickerOpen(false)}
        dripRate={dripRate} onDripRateChange={setDripRate} showDripRate />
    </Layout>
  );
}
