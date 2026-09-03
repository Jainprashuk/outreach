import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { useApp } from '../context/AppContext';
import { moveLeadsToOutreachApi, type Lead, type MoveToOutreachResult } from '../lib/api';

interface Edit { name: string; company: string; role: string; }

export default function MoveToOutreachModal({ leads, onClose, onDone }: {
  leads: Lead[];                                  // selected, email-bearing
  onClose: () => void;
  onDone: (result: MoveToOutreachResult) => void;
}) {
  const app = useApp();

  // Whatever templates you have — no built-in defaults (same as AddContacts).
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));
  const defaultTpl = templateOptions[0]?.key || '';

  const [template, setTemplate] = useState(defaultTpl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState<Record<string, Edit>>(() =>
    Object.fromEntries(leads.map(l => [l.id, { name: l.authorName, company: l.company, role: l.role }])));

  useEffect(() => { if (!template && defaultTpl) setTemplate(defaultTpl); }, [defaultTpl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const setEdit = (id: string, patch: Partial<Edit>) =>
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const anyEmptyName = useMemo(
    () => leads.some(l => !(edits[l.id]?.name || '').trim()),
    [leads, edits],
  );

  const confirm = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await moveLeadsToOutreachApi(template, leads.map(l => ({
        id: l.id,
        name: (edits[l.id]?.name || '').trim(),
        company: (edits[l.id]?.company || '').trim(),
        role: (edits[l.id]?.role || '').trim(),
      })));
      onDone(result);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 760, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Move {leads.length} lead{leads.length !== 1 ? 's' : ''} to outreach</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              Creates contacts in your outreach list. Names and company/role can't be edited afterwards, so fix them here.
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} style={{ flexShrink: 0 }} type="button" disabled={saving}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ padding: '14px 0' }}>
          <div className="form-group">
            <label className="form-label">Template</label>
            <select value={template} onChange={e => setTemplate(e.target.value)}>
              {templateOptions.length === 0 && <option value="">No templates — create one first</option>}
              {templateOptions.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
            {templateOptions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                You need at least one template before contacts can be sent.{' '}
                <Link to="/templates">Create a template</Link>
              </div>
            )}
          </div>

          <div className="section-head" style={{ margin: '18px 0 10px' }}>
            <span className="section-title">Contacts to create</span>
            <span className="contact-count-badge">{leads.length}</span>
          </div>

          {leads.map(l => (
            <div key={l.id} style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 12 }}>
              <div className="contact-chip" style={{ marginBottom: 12 }}>
                <Avatar name={edits[l.id]?.name || l.authorName} />
                <div>
                  <div className="email">{l.email}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    fit {l.fitScore}{l.source ? ` · ${l.source}` : ''}
                    {l.authorUrl ? <> · <a href={l.authorUrl} target="_blank" rel="noopener noreferrer">profile</a></> : null}
                  </div>
                </div>
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">Full name *</label>
                  <input type="text" value={edits[l.id]?.name || ''}
                    onChange={e => setEdit(l.id, { name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Company</label>
                  <input type="text" placeholder="Acme Inc." value={edits[l.id]?.company || ''}
                    onChange={e => setEdit(l.id, { company: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <input type="text" placeholder="VP of Sales" value={edits[l.id]?.role || ''}
                    onChange={e => setEdit(l.id, { role: e.target.value })} />
                </div>
              </div>
            </div>
          ))}

          {error && (
            <div className="info-box" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
              <i className="ti ti-alert-triangle" /> {error}
            </div>
          )}
        </div>

        <div className="reply-modal-footer">
          <button className="btn btn-sm" onClick={onClose} type="button" disabled={saving}>
            <i className="ti ti-x" /> Cancel
          </button>
          <button className="btn btn-primary" onClick={confirm} type="button"
            disabled={saving || anyEmptyName || !template}
            title={anyEmptyName ? 'Every contact needs a name' : !template ? 'Pick a template first' : undefined}>
            <i className="ti ti-user-plus" /> {saving ? 'Adding…' : `Add ${leads.length} to outreach`}
          </button>
        </div>
      </div>
    </div>
  );
}
