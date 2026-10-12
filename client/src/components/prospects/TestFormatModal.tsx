// "Test format" — send ONE real outreach email to one person in one format, to find out
// whether a company's format is right before everyone else gets it. The person moves to
// outreach and the email goes out like any Step 3 send; what happens next shows in the
// Format tests panel on the company card.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  JOBS_CHANGED_EVENT, prospectAddressesApi, startFormatTestApi,
  type CompanyFormat, type FormatTest, type Prospect,
} from '../../lib/api';
import { renderTemplate } from '../../lib/format';
import { PATTERN_EXAMPLE } from '../../lib/prospects';

const FORMATS = Object.keys(PATTERN_EXAMPLE);
const FOUND = '__found';
const TEMPLATE_KEY = 'discover.testTemplate';

const readTemplate = () => { try { return localStorage.getItem(TEMPLATE_KEY) || ''; } catch (_) { return ''; } };
const saveTemplate = (k: string) => { try { localStorage.setItem(TEMPLATE_KEY, k); } catch (_) { /* private mode */ } };

type Person = Pick<Prospect, 'id' | 'name' | 'title' | 'company' | 'roleMatch'> & { bounced?: string };

/**
 * People a format can be tested on: open, with a first and last name, role matches
 * first — plus anyone whose test hard-bounced, who can be tried in another format.
 */
export function testablePeople(prospects: Prospect[], tests: FormatTest[] = []): Person[] {
  const tested = new Set(tests.map(t => t.prospectId));
  const open: Person[] = prospects
    .filter(p => ['new', 'ready', 'error'].includes(p.status) && !tested.has(p.id) && p.name.trim().split(/\s+/).length >= 2)
    .sort((a, b) => Number(b.roleMatch) - Number(a.roleMatch));
  const retry = new Map<string, Person>();
  for (const t of tests) {
    if (t.status !== 'bounced' || retry.has(t.prospectId)) continue;
    // Tried again since, with something that didn't bounce? Then not a retry candidate.
    if (tests.some(o => o.prospectId === t.prospectId && o.status !== 'bounced')) continue;
    retry.set(t.prospectId, { id: t.prospectId, name: t.name, title: '', company: '', roleMatch: false, bounced: t.email });
  }
  return [...open, ...retry.values()];
}

export default function TestFormatModal({ format, prospects, initial, onClose, onSent }: {
  format: CompanyFormat;
  prospects: Prospect[];
  /** Pre-fill from "Try another format / person". */
  initial?: { prospectId?: string; pattern?: string };
  onClose: () => void;
  onSent: (r: { tests: FormatTest[]; error: string | null }) => void;
}) {
  const app = useApp();
  const people = useMemo(() => testablePeople(prospects, format.tests), [prospects, format.tests]);
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));

  const [personId, setPersonId] = useState(initial?.prospectId && people.some(p => p.id === initial.prospectId) ? initial.prospectId : people[0]?.id || '');
  const [pattern, setPattern] = useState(initial?.pattern || format.decision.pattern);
  const [template, setTemplate] = useState(() => {
    const saved = readTemplate();
    return templateOptions.some(t => t.key === saved) ? saved : templateOptions[0]?.key || '';
  });
  const [attachResume, setAttachResume] = useState(false);
  const [addresses, setAddresses] = useState<Record<string, string | null> | null>(null);
  const [known, setKnown] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const person = people.find(p => p.id === personId) || null;

  useEffect(() => {
    if (!personId) return;
    let live = true;
    setAddresses(null);
    prospectAddressesApi(personId).then(r => {
      if (!live) return;
      setAddresses(r.addresses);
      setKnown(r.knownEmail);
      // A real address found for this person beats any guess — offer it first.
      if (r.knownEmail && !initial?.pattern) setPattern(FOUND);
      else setPattern(p => (p === FOUND || !r.addresses[p] ? (initial?.pattern && r.addresses[initial.pattern] ? initial.pattern : FORMATS.find(f => r.addresses[f]) || p) : p));
    }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [personId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const email = pattern === FOUND ? known : (addresses && addresses[pattern]) || null;
  const preview = person && template
    ? renderTemplate(app.templates, app.sender, template, { name: person.name, company: person.company || format.companyName, role: person.title } as any)
    : null;
  const tried = new Set(format.tests.filter(t => t.status === 'bounced').map(t => t.pattern));

  const send = async () => {
    if (!person || !email) return;
    setSaving(true); setErr('');
    saveTemplate(template);
    try {
      const r = await startFormatTestApi({
        prospectId: person.id, template, attachResume,
        ...(pattern === FOUND ? { email } : { pattern }),
      });
      window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
      onSent({ tests: r.tests, error: r.error });
    } catch (e: any) { setErr(e.message); setConfirming(false); setSaving(false); }
  };

  const field = (label: string, node: React.ReactNode, hint?: React.ReactNode) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      {node}
      {hint && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{hint}</div>}
    </div>
  );

  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 560, maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Test {format.companyName || format.domain}’s email format</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              One real email to one person. If it doesn’t bounce, confirm the format for everyone.
            </div>
          </div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button" disabled={saving}><i className="ti ti-x" /></button>
        </div>

        {err && (
          <div className="info-box danger" style={{ marginTop: 12 }}><i className="ti ti-alert-triangle" /><div>{err}</div></div>
        )}

        {!people.length ? (
          <div className="info-box" style={{ marginTop: 12 }}>
            <i className="ti ti-info-circle" />
            <div>No one left to test with — everyone here is already in outreach, tested, or has only one name. Search again to find more people.</div>
          </div>
        ) : confirming && person && email ? (
          <div style={{ marginTop: 14 }}>
            <div className="info-box" style={{ marginBottom: 12 }}>
              <i className="ti ti-send" />
              <div>
                Send <strong>1 email</strong> to <strong>{email}</strong> now?
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                  {person.name} moves to outreach and gets “{preview?.subject}” from your Gmail, like a normal outreach email.
                  If the address is wrong it will bounce — one bounce, instead of one for everyone at {format.domain}.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" type="button" onClick={() => setConfirming(false)} disabled={saving}>Back</button>
              <button className="btn btn-sm btn-primary" type="button" onClick={send} disabled={saving}>
                {saving ? <><i className="ti ti-loader" /> Sending…</> : <><i className="ti ti-send" /> Send test email</>}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {field('Person',
              <select value={personId} style={{ width: '100%' }} onChange={e => { setPersonId(e.target.value); setErr(''); }}>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}{p.title ? ` — ${p.title}` : ''}{p.roleMatch ? ' ★' : ''}{p.bounced ? ` (bounced: ${p.bounced})` : ''}</option>)}
              </select>,
              'Pick someone likely still there — a recent title is safer than an old one.')}

            {field('Format',
              <select value={pattern} style={{ width: '100%' }} onChange={e => { setPattern(e.target.value); setErr(''); }} disabled={!addresses}>
                {known && <option value={FOUND}>Found: {known}</option>}
                {FORMATS.map(f => (
                  <option key={f} value={f} disabled={!addresses?.[f]}>
                    {f} — {addresses?.[f] || 'can’t build from this name'}{tried.has(f) ? ' (bounced before)' : ''}{f === format.decision.pattern ? ' · current guess' : ''}
                  </option>
                ))}
              </select>,
              email ? <>Will send to <strong>{email}</strong></> : addresses ? 'This format needs a full first and last name.' : 'Loading…')}

            {field('Template',
              <select value={template} style={{ width: '100%' }} onChange={e => setTemplate(e.target.value)}>
                {templateOptions.length === 0 && <option value="">No templates — create one first</option>}
                {templateOptions.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select>,
              templateOptions.length === 0 ? <Link to="/templates">Create a template</Link> : undefined)}

            {preview && preview.subject && (
              <div className="s-card" style={{ padding: 10, marginBottom: 12, fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{preview.subject}</div>
                <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text2)', maxHeight: 160, overflowY: 'auto' }}>{preview.body}</div>
              </div>
            )}

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={attachResume} onChange={e => setAttachResume(e.target.checked)} /> Attach my resume
            </label>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" type="button" disabled={!person || !email || !template}
                onClick={() => setConfirming(true)}>
                <i className="ti ti-send" /> Send test email…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
