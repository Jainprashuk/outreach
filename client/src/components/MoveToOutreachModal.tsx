import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { useApp } from '../context/AppContext';
import { moveLeadsToOutreachApi, type Lead, type MoveToOutreachResult } from '../lib/api';
import { deriveCompany, isCompanyDerived } from '../lib/leads';

interface Edit { name: string; company: string; role: string; }

export default function MoveToOutreachModal({ leads, onClose, onDone }: {
  leads: Lead[];                                  // selected, email-bearing
  onClose: () => void;
  onDone: (result: MoveToOutreachResult, excludedCount: number) => void;
}) {
  const app = useApp();

  // Whatever templates you have — no built-in defaults (same as AddContacts).
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));
  const defaultTpl = templateOptions[0]?.key || '';

  const [template, setTemplate] = useState(defaultTpl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Leads dropped during review. Reversible — nothing is discarded until you
  // confirm, and an excluded lead is simply left alone (still "new").
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Edit>>(() =>
    Object.fromEntries(leads.map(l => [l.id, { name: l.authorName, company: deriveCompany(l), role: l.role }])));

  useEffect(() => { if (!template && defaultTpl) setTemplate(defaultTpl); }, [defaultTpl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const setEdit = (id: string, patch: Partial<Edit>) =>
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const toggleExcluded = (id: string) =>
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const active = useMemo(() => leads.filter(l => !excluded.has(l.id)), [leads, excluded]);

  const anyEmptyName = useMemo(
    () => active.some(l => !(edits[l.id]?.name || '').trim()),
    [active, edits],
  );

  const canConfirm = !saving && active.length > 0 && !anyEmptyName && !!template;

  const confirm = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await moveLeadsToOutreachApi(template, active.map(l => ({
        id: l.id,
        name: (edits[l.id]?.name || '').trim(),
        company: (edits[l.id]?.company || '').trim(),
        role: (edits[l.id]?.role || '').trim(),
      })));
      onDone(result, excluded.size);
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
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              Move {active.length} lead{active.length !== 1 ? 's' : ''} to outreach
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              Company is pre-filled from each lead's email domain. Names and company/role can't be
              edited after this, so correct anything off here — or leave a lead out with “Skip”.
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
            <span className="contact-count-badge">
              {active.length}{excluded.size > 0 ? ` · ${excluded.size} skipped` : ''}
            </span>
          </div>

          {leads.map(l => {
            const isSkipped = excluded.has(l.id);
            return (
              <div key={l.id} style={{
                background: 'var(--bg)',
                border: '0.5px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                padding: isSkipped ? 12 : 16,
                marginBottom: 12,
                opacity: isSkipped ? 0.55 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isSkipped ? 0 : 12 }}>
                  <div className="contact-chip" style={{ flex: 1, minWidth: 0 }}>
                    <Avatar name={edits[l.id]?.name || l.authorName} />
                    <div style={{ minWidth: 0 }}>
                      <div className="email">{l.email}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                        {isSkipped ? 'Skipped — stays in your leads as “new”' : (
                          <>
                            fit {l.fitScore}{l.source ? ` · ${l.source}` : ''}
                            {l.authorUrl ? <> · <a href={l.authorUrl} target="_blank" rel="noopener noreferrer">profile</a></> : null}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <button className="btn btn-xs" type="button" disabled={saving}
                    style={isSkipped ? undefined : { color: 'var(--red)', borderColor: 'var(--red-bg)' }}
                    onClick={() => toggleExcluded(l.id)}
                    title={isSkipped ? 'Include this lead again' : "Leave this lead out — it stays in your leads as 'new'"}>
                    <i className={isSkipped ? 'ti ti-rotate' : 'ti ti-minus'} /> {isSkipped ? 'Include' : 'Skip'}
                  </button>
                </div>

                {!isSkipped && (
                  <div className="form-grid">
                    <div className="form-group">
                      <label className="form-label">Full name *</label>
                      <input type="text" value={edits[l.id]?.name || ''}
                        onChange={e => setEdit(l.id, { name: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">
                        Company
                        {isCompanyDerived(l) && (
                          <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · guessed from {l.email?.split('@')[1]}</span>
                        )}
                      </label>
                      <input type="text" placeholder="Acme Inc." value={edits[l.id]?.company || ''}
                        onChange={e => setEdit(l.id, { company: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Role</label>
                      <input type="text" placeholder="VP of Sales" value={edits[l.id]?.role || ''}
                        onChange={e => setEdit(l.id, { role: e.target.value })} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {active.length === 0 && (
            <div className="info-box">
              <i className="ti ti-info-circle" />
              <span>Every lead is skipped — include at least one, or cancel to leave them all as they are.</span>
            </div>
          )}

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
          <button className="btn btn-primary" onClick={confirm} type="button" disabled={!canConfirm}
            title={
              active.length === 0 ? 'Every lead is skipped'
                : anyEmptyName ? 'Every contact needs a name'
                : !template ? 'Pick a template first'
                : undefined
            }>
            <i className="ti ti-user-plus" /> {saving ? 'Adding…' : `Add ${active.length} to outreach`}
          </button>
        </div>
      </div>
    </div>
  );
}
