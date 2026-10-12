// "Set format" — tell the app a company's email format yourself, for when none of the
// automatic sources could prove it. Either pick it from the list, or paste one real
// address you found and let the app work the format out from it.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { setCompanyFormatApi, type CompanyFormat, type SetFormatBody } from '../../lib/api';
import { PATTERN_EXAMPLE } from '../../lib/prospects';

const FORMATS = Object.keys(PATTERN_EXAMPLE);

export default function SetFormatModal({ format, onClose, onSaved }: {
  format: CompanyFormat;
  onClose: () => void;
  onSaved: (r: { pattern: string | null; withEmail: number; people: number }) => void;
}) {
  const { domain } = format;
  const [tab, setTab] = useState<'list' | 'example'>(format.manual?.from === 'example' ? 'example' : 'list');
  const [pattern, setPattern] = useState(format.manual?.pattern || format.decision.pattern);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const company = format.companyName || domain;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`"${company}" email format ${domain}`)}`;

  const save = async (body: SetFormatBody) => {
    setSaving(true);
    setErr('');
    try {
      const r = await setCompanyFormatApi(domain, body);
      onSaved(r);
    } catch (e: any) { setErr(e.message || 'Could not save'); } finally { setSaving(false); }
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      {node}
    </label>
  );

  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 520, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Set {company}’s email format</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>Used for everyone at {domain} until you clear it</div>
          </div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /></button>
        </div>

        <div className="nav-tabs" style={{ margin: '12px 0' }}>
          <button type="button" className={`nav-tab${tab === 'list' ? ' active' : ''}`} onClick={() => { setTab('list'); setErr(''); }}>
            <i className="ti ti-list" style={{ marginRight: 4 }} />Pick from list
          </button>
          <button type="button" className={`nav-tab${tab === 'example' ? ' active' : ''}`} onClick={() => { setTab('example'); setErr(''); }}>
            <i className="ti ti-mail-check" style={{ marginRight: 4 }} />I found a real address
          </button>
        </div>

        {err && (
          <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent' }}>
            <i className="ti ti-alert-triangle" /><span>{err}</span>
          </div>
        )}

        {tab === 'list' ? (
          <>
            <div className="info-box" style={{ marginBottom: 12 }}>
              <i className="ti ti-bulb" />
              <span>
                Sites like RocketReach and LeadIQ list most companies’ formats —{' '}
                <a href={searchUrl} target="_blank" rel="noreferrer">search “{company} email format”</a>.
                A format picked here is labelled Medium.
              </span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {FORMATS.map(f => (
                <label key={f} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                  <input type="radio" name="fmt" checked={pattern === f} onChange={() => setPattern(f)} />
                  <strong style={{ minWidth: 80 }}>{f}</strong>
                  <span style={{ color: 'var(--text2)' }}>{PATTERN_EXAMPLE[f]}@{domain}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" type="button" disabled={saving} onClick={() => save({ pattern })}>
                {saving ? 'Saving…' : <><i className="ti ti-check" /> Use {pattern}</>}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="info-box" style={{ marginBottom: 12 }}>
              <i className="ti ti-info-circle" />
              <span>
                One real address — from an email signature, a press release, a PDF — proves the format.
                The app works it out from the name and address, and labels it High.
              </span>
            </div>
            {field('Their name', <input type="text" value={name} style={{ width: '100%' }} placeholder="Priya Kapoor"
              onChange={e => setName(e.target.value)} />)}
            {field('Their real address', <input type="email" value={email} style={{ width: '100%' }} placeholder={`priya.kapoor@${domain}`}
              onChange={e => setEmail(e.target.value)} />)}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" type="button" disabled={saving || !name.trim() || !email.trim()}
                onClick={() => save({ exampleName: name.trim(), exampleEmail: email.trim() })}>
                {saving ? 'Working it out…' : <><i className="ti ti-check" /> Work out the format</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
