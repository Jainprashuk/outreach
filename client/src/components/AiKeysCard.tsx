// Settings card for this account's own AI keys. Groq is required (fast, 1,000 free
// requests a day); Gemini and Cerebras are backups and can be added once Groq is. Each is
// checked with one tiny real call before it is saved, stored encrypted, and never
// sent back to this page — only whether one is set and what the last call said.
import { useEffect, useRef, useState } from 'react';
import { useToast } from '../context/ToastContext';
import {
  aiAccessApi, removeAiKeyApi, saveAiKeyApi, AI_KEYS_CHANGED_EVENT,
  type AiAccess, type AiProvider,
} from '../lib/api';

const PROVIDERS: { key: AiProvider; name: string; url: string; steps: string[]; tag: string; note?: string }[] = [
  {
    key: 'groq', name: 'Groq', tag: 'Required', url: 'https://console.groq.com/keys',
    note: 'Does almost all the work. Free, no card.',
    steps: ['Open the Groq console and sign up with Google or email.', 'Click “Create API Key” and give it any name.', 'Copy the key (it is shown only once) and paste it here.'],
  },
  {
    key: 'gemini', name: 'Google Gemini', tag: 'Optional backup', url: 'https://aistudio.google.com/apikey',
    note: 'Used when Groq is busy. Free, no card.',
    steps: ['Open Google AI Studio and sign in with any Google account.', 'Click “Create API key”.', 'Copy the key and paste it here.'],
  },
  {
    key: 'cerebras', name: 'Cerebras', tag: 'Optional backup', url: 'https://cloud.cerebras.ai',
    note: 'Cerebras now asks for a card to start its free trial credit.',
    steps: ['Open Cerebras Cloud and sign up.', 'Go to “API Keys” in the left menu and generate a key.', 'Copy the key and paste it here.'],
  },
];

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

function StatusPill({ access, p }: { access: AiAccess; p: AiProvider }) {
  if (!access.has[p]) {
    if (access.ownerFallback || !access.enforce || access.inGrace) {
      return <span className="sr-ml badge badge-pending">Using admin’s key</span>;
    }
    return <span className="sr-ml badge badge-pending">Not set</span>;
  }
  const st = access.status[p];
  if (st?.state === 'invalid') return <span className="sr-ml badge badge-rejected" title={st.error || ''}>Rejected</span>;
  if (st?.state === 'quota') return <span className="sr-ml badge badge-pending">Daily limit reached</span>;
  return <span className="sr-ml badge badge-sent"><i className="ti ti-lock" /> Working</span>;
}

export default function AiKeysCard() {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [access, setAccess] = useState<AiAccess | null>(null);
  const [values, setValues] = useState<Partial<Record<AiProvider, string>>>({});
  const [open, setOpen] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState<AiProvider | null>(null);

  useEffect(() => { aiAccessApi().then(setAccess).catch(() => setAccess(null)); }, []);
  // The banner and the bell link here as /settings#ai-keys.
  useEffect(() => {
    if (access && window.location.hash === '#ai-keys') ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [access]);

  const changed = (a: AiAccess) => {
    setAccess(a);
    window.dispatchEvent(new Event(AI_KEYS_CHANGED_EVENT));
  };

  const save = async (p: AiProvider) => {
    const v = (values[p] || '').trim();
    if (!v) return;
    setBusy(p);
    try {
      changed(await saveAiKeyApi(p, v));
      setValues(prev => ({ ...prev, [p]: '' }));
      toast('Key checked and saved', 'success');
    } catch (err: any) {
      toast(err.message || 'Could not save the key', 'error');
    } finally { setBusy(null); }
  };

  const remove = async (p: AiProvider) => {
    const msg = p === 'groq'
      ? 'Remove your Groq key? Groq does almost all the AI work — without it, AI may stop for your account.'
      : 'Remove this key?';
    if (!window.confirm(msg)) return;
    setBusy(p);
    try { changed(await removeAiKeyApi(p)); toast('Key removed', 'success'); }
    catch (err: any) { toast(err.message || 'Could not remove it', 'error'); }
    finally { setBusy(null); }
  };

  const hasGroq = !!access?.has.groq;
  const backups = access ? Number(!!access.has.gemini) + Number(!!access.has.cerebras) : 0;

  return (
    <div className="s-card" id="ai-keys" ref={ref} style={{ animationDelay: '.08s', scrollMarginTop: 16 }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-sparkles" /></div>
          <div>
            <div className="s-title">AI keys</div>
            <div className="s-sub">
              {!hasGroq ? 'Add your free Groq key to turn AI on'
                : backups ? `Groq added, plus ${backups} backup${backups === 1 ? '' : 's'}` : 'Groq added — a Gemini backup is optional'}
            </div>
          </div>
        </div>
      </div>
      <div className="s-body">
        <div className="sr-intro">
          Outreach uses AI to sort your replies, draft answers, and find people. It runs on your own
          free <strong>Groq</strong> key — about 2 minutes to get, no card. A Gemini key is an optional
          backup for when Groq is busy.
        </div>

        {access && access.enforce && access.inGrace && !hasGroq && !access.ownerFallback && access.graceUntil && (
          <div className="info-box" style={{ marginBottom: 14, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
            <i className="ti ti-clock" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>Until <strong>{day(access.graceUntil)}</strong> your AI runs on the admin’s keys. After that it needs your own.</div>
          </div>
        )}
        {access && !access.aiOn && (
          <div className="info-box danger" style={{ marginBottom: 14 }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>AI is off for your account. Add your Groq key below to turn reply sorting and drafts back on.</div>
          </div>
        )}

        <div className="sr-keylist">
        {PROVIDERS.map((p, idx) => {
          const has = !!access?.has[p.key];
          // A backup on its own would leave the account on a key too slow to carry it.
          const locked = p.key !== 'groq' && !hasGroq && !has;
          return (
            <div className="form-group sr-keyrow" key={p.key}>
              <label className="form-label sr-keyhead">
                <span className="sr-num" aria-hidden="true">{idx + 1}</span>
                <span className="sr-keyname">{p.name}</span>
                <span className={'sr-tag' + (p.key === 'groq' ? ' req' : '')}>{p.tag}</span>
                {access && <StatusPill access={access} p={p.key} />}
              </label>
              <div className="sr-keynote">
                {p.note && <>{p.note} </>}
                <a href={p.url} target="_blank" rel="noreferrer" className="sr-link">Get a free key <i className="ti ti-external-link" /></a>
                {' · '}
                <button type="button" className="btn-link sr-link sr-linkbtn"
                  onClick={() => setOpen(open === p.key ? null : p.key)}>
                  How?
                </button>
              </div>
              {open === p.key && (
                <ol className="sr-steps">
                  {p.steps.map(s => <li key={s}>{s}</li>)}
                </ol>
              )}
              <div className="sr-keyinput">
                <input type="password" autoComplete="off"
                  value={values[p.key] || ''} onChange={e => setValues(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={locked ? 'Add your Groq key first' : has ? 'Enter a new one to replace it' : 'Paste the key'}
                  disabled={locked}
                  onKeyDown={e => { if (e.key === 'Enter') save(p.key); }} />
                <button className="btn btn-primary" type="button" disabled={locked || busy !== null || !(values[p.key] || '').trim()} onClick={() => save(p.key)}>
                  {busy === p.key ? <><i className="ti ti-loader" /> Checking…</> : has ? 'Replace' : 'Save'}
                </button>
                {has && <button className="btn btn-danger" type="button" disabled={busy !== null} onClick={() => remove(p.key)}>Remove</button>}
              </div>
            </div>
          );
        })}
        </div>

        <div className="info-box sr-note">
          <i className="ti ti-lock" style={{ fontSize: 15, flexShrink: 0 }} />
          <div>Each key is checked with one tiny request before saving, stored <strong>encrypted</strong>, and used only for your account.</div>
        </div>
      </div>
    </div>
  );
}
