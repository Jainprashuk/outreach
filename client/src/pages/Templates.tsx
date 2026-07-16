import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import VariablePills from '../components/VariablePills';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { bodyToHtml } from '../lib/format';

export default function Templates() {
  const app = useApp();
  const toast = useToast();
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'subject' | 'body'>('body');

  useEffect(() => {
    Promise.all([app.loadTemplates(), app.loadSettings()]).catch(err => setError(err.message));
  }, []);

  const openModal = (key?: string) => {
    setEditingKey(key || null);
    if (key) {
      const tpl = app.templates[key];
      setName(tpl.name); setSubject(tpl.subject); setBody(tpl.body);
    } else {
      setName(''); setSubject(''); setBody('');
    }
    setModalOpen(true);
  };

  const insertVariable = (key: string) => {
    const el = lastFocused.current === 'subject' ? subjectRef.current : bodyRef.current;
    const setter = lastFocused.current === 'subject' ? setSubject : setBody;
    const text = `{{${key}}}`;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setter(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  };

  const save = async () => {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast('Please fill in the name, subject and body.', 'error');
      return;
    }
    setSaving(true);
    try {
      if (editingKey) {
        await app.updateTemplate(editingKey, { name: name.trim(), subject: subject.trim(), body: body.trim() });
        toast('Template updated.', 'success');
      } else {
        await app.createTemplate({ name: name.trim(), subject: subject.trim(), body: body.trim() });
        toast('Template created.', 'success');
      }
      setModalOpen(false);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (key: string) => {
    if (!confirm(`Delete the "${app.templates[key]?.name || key}" template? This cannot be undone.`)) return;
    try {
      await app.deleteTemplate(key);
      toast('Template deleted.', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const entries = Object.entries(app.templates);

  return (
    <Layout title="Templates" subtitle="Manage your email templates" actions={
      <button className="btn btn-primary" onClick={() => openModal()} type="button"><i className="ti ti-plus" /> New template</button>
    }>
      <div className="info-box" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ marginBottom: 6 }}>
            Variables auto-replaced per contact — click <Link to="/settings" style={{ color: 'var(--blue)' }}>Settings</Link> to add your own.
          </div>
          <div><VariablePills /></div>
        </div>
      </div>

      {error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state"><i className="ti ti-file-text" />No templates yet — create your first one.</div>
      ) : entries.map(([key, tpl]) => (
        <div className="tpl-card" key={key}>
          <div className="tpl-card-head">
            <span className="tpl-head-name">{tpl.name}</span>
            <div className="tpl-head-actions">
              <span className="tpl-key">{key}</span>
              <button className="btn btn-xs" onClick={() => openModal(key)} title="Edit" type="button"><i className="ti ti-edit" /></button>
              <button className="btn btn-xs" style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }} onClick={() => remove(key)} title="Delete" type="button"><i className="ti ti-trash" /></button>
            </div>
          </div>
          <div className="tpl-card-body">
            <div className="tpl-subject">Subject: {tpl.subject}</div>
            <div className="tpl-body-text" style={{ marginTop: 10 }} dangerouslySetInnerHTML={{ __html: bodyToHtml(tpl.body) }} />
          </div>
        </div>
      ))}

      {modalOpen && (
        <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div className="edit-modal">
            <h2>{editingKey ? 'Edit template' : 'New template'}</h2>
            <div className="form-group">
              <label className="form-label">Template name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Investor outreach" />
            </div>
            <div className="form-group">
              <label className="form-label">Subject</label>
              <input ref={subjectRef} type="text" value={subject}
                onChange={e => setSubject(e.target.value)}
                onFocus={() => { lastFocused.current = 'subject'; }}
                placeholder="Quick question, {{name}}" />
            </div>
            <div className="form-group">
              <label className="form-label">Body</label>
              <textarea ref={bodyRef} value={body} style={{ minHeight: 180 }}
                onChange={e => setBody(e.target.value)}
                onFocus={() => { lastFocused.current = 'body'; }}
                placeholder="Hi {{name}}, ..." />
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5 }}>
                Tip: use <code style={{ background: 'var(--bg2)', padding: '1px 4px', borderRadius: 3 }}>[link text](https://...)</code> for clickable links
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Insert a variable</label>
              <div><VariablePills onInsert={insertVariable} /></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
              <button className="btn" onClick={() => setModalOpen(false)} type="button">Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving} type="button">
                {saving ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : <><i className="ti ti-check" /> Save template</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
