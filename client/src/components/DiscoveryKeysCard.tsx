// Settings card for the Discover tab's free services. Each key is your own,
// stored encrypted, and never sent back to this page — only whether one is set.
import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import {
  discoveryConfigApi, removeDiscoveryKeyApi, saveDiscoveryKeysApi, saveRecruiterLinkedinApi,
  type DiscoveryConfigView, type DiscoveryProvider, type RecruiterLinkedinMode,
} from '../lib/api';

const PROVIDERS: { key: DiscoveryProvider; name: string; what: string; url: string; usage?: 'tavily' | 'serpapi' | 'hunter' }[] = [
  { key: 'tavily', name: 'Tavily', what: 'Finds people at a company (1,000 free searches a month, no card).', url: 'https://app.tavily.com', usage: 'tavily' },
  { key: 'serpapi', name: 'SerpApi', what: 'Backup people search when Tavily is used up (250 free a month).', url: 'https://serpapi.com/users/sign_up', usage: 'serpapi' },
  { key: 'hunter', name: 'Hunter', what: 'Optional. Gravatar, the web and email-format sites usually find the format already; Hunter is only asked when they can’t (once per company, 50 free a month).', url: 'https://hunter.io/users/sign_up', usage: 'hunter' },
  { key: 'github', name: 'GitHub token', what: 'Optional. Raises GitHub’s limit from 60 to 5,000 requests an hour. No scopes needed.', url: 'https://github.com/settings/personal-access-tokens/new' },
];

const LI_MODES: { key: RecruiterLinkedinMode; label: string; what: string }[] = [
  { key: 'manual', label: 'Button only', what: 'The “Find LinkedIn” button on a job. Always on.' },
  { key: 'approved', label: 'Approved jobs', what: 'When a job is approved, by you or by auto-approve.' },
  { key: 'recruiter_action', label: 'Recruiter acted', what: 'When a recruiter viewed, shortlisted or contacted you on a job.' },
  { key: 'all', label: 'Every job', what: 'Every job that comes in with a named recruiter. Uses the most search credits.' },
];

export default function DiscoveryKeysCard() {
  const toast = useToast();
  const [cfg, setCfg] = useState<DiscoveryConfigView | null>(null);
  const [values, setValues] = useState<Partial<Record<DiscoveryProvider, string>>>({});
  const [busy, setBusy] = useState<DiscoveryProvider | null>(null);

  useEffect(() => { discoveryConfigApi().then(setCfg).catch(() => setCfg(null)); }, []);

  const save = async (p: DiscoveryProvider) => {
    const v = (values[p] || '').trim();
    if (!v) return;
    setBusy(p);
    try {
      setCfg(await saveDiscoveryKeysApi({ [p]: v }));
      setValues(prev => ({ ...prev, [p]: '' }));
      toast('Key saved', 'success');
    } catch (err: any) {
      toast(err.message || 'Could not save the key', 'error');
    } finally { setBusy(null); }
  };

  const [cap, setCap] = useState('');
  useEffect(() => { if (cfg) setCap(String(cfg.recruiterLinkedin.dailyCap)); }, [cfg]);

  const saveLi = async (patch: { modes?: RecruiterLinkedinMode[]; dailyCap?: number }) => {
    try { setCfg(await saveRecruiterLinkedinApi(patch)); toast('Saved', 'success'); }
    catch (err: any) { toast(err.message || 'Could not save', 'error'); }
  };
  const toggleMode = (m: RecruiterLinkedinMode) => {
    if (!cfg || m === 'manual') return;
    const on = cfg.recruiterLinkedin.modes.includes(m);
    saveLi({ modes: on ? cfg.recruiterLinkedin.modes.filter(x => x !== m) : [...cfg.recruiterLinkedin.modes, m] });
  };

  const remove = async (p: DiscoveryProvider) => {
    if (!window.confirm('Remove this key?')) return;
    setBusy(p);
    try { setCfg(await removeDiscoveryKeyApi(p)); toast('Key removed', 'success'); }
    catch (err: any) { toast(err.message || 'Could not remove it', 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="s-card" style={{ animationDelay: '.1s' }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--blue-bg)', color: 'var(--blue)' }}><i className="ti ti-building" /></div>
          <div>
            <div className="s-title">Discover — free services</div>
            <div className="s-sub">Your own free keys for finding people and email formats</div>
          </div>
        </div>
      </div>
      <div className="s-body">
        {cfg && !cfg.canStoreKeys && (
          <div className="info-box danger" style={{ marginBottom: 14 }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>CREDENTIAL_KEY isn’t set on the server, so keys can’t be stored safely yet.</div>
          </div>
        )}
        <div className="sr-keylist">
        {PROVIDERS.map(p => {
          const has = !!cfg?.keys[p.key];
          const used = p.usage && cfg ? cfg.usage[p.usage] : null;
          const cap = cfg?.caps[p.key] ?? null;
          return (
            <div className="form-group sr-keyrow" key={p.key}>
              <label className="form-label sr-keyhead">
                <span className="sr-keyname">{p.name}</span>
                {has
                  ? <span className="sr-ml badge badge-sent"><i className="ti ti-lock" /> stored</span>
                  : <span className="sr-ml badge badge-pending">not set</span>}
                {used !== null && cap !== null && has && (
                  <span className="sr-ml sr-tag">{used} of {cap} used this month</span>
                )}
              </label>
              <div className="sr-keynote">
                {p.what} <a href={p.url} target="_blank" rel="noreferrer" className="sr-link">Get a free key</a>
              </div>
              <div className="sr-keyinput">
                <input type="password" autoComplete="off"
                  value={values[p.key] || ''} onChange={e => setValues(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={has ? 'Enter a new one to replace it' : 'Paste the key'}
                  disabled={!cfg?.canStoreKeys}
                  onKeyDown={e => { if (e.key === 'Enter') save(p.key); }} />
                <button className="btn btn-primary" type="button" disabled={busy !== null || !(values[p.key] || '').trim()} onClick={() => save(p.key)}>
                  {busy === p.key ? <><i className="ti ti-loader" /> Saving…</> : has ? 'Replace' : 'Save'}
                </button>
                {has && <button className="btn btn-danger" type="button" disabled={busy !== null} onClick={() => remove(p.key)}>Remove</button>}
              </div>
            </div>
          );
        })}
        </div>
        {cfg && (
          <div className="form-group" style={{ marginTop: 16 }}>
            <label className="form-label"><span className="sr-keyname">Recruiter LinkedIn lookups</span></label>
            <div className="sr-keynote">
              When a job names its recruiter, search for their LinkedIn profile (one search credit each, using the keys above).
              Tick any mix; each runs in the background.
            </div>
            {LI_MODES.map(m => {
              const all = cfg.recruiterLinkedin.modes.includes('all');
              const checked = m.key === 'manual' || cfg.recruiterLinkedin.modes.includes(m.key);
              return (
                <label key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0', opacity: all && m.key !== 'all' && m.key !== 'manual' ? 0.5 : 1 }}>
                  <input type="checkbox" checked={checked} disabled={m.key === 'manual' || (all && m.key !== 'all')}
                    onChange={() => toggleMode(m.key)} style={{ marginTop: 3 }} />
                  <span><strong>{m.label}</strong> — {m.what}</span>
                </label>
              );
            })}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span className="sr-keynote" style={{ margin: 0 }}>Automatic lookups per day, all triggers together</span>
              <input type="number" min={1} max={200} value={cap} style={{ width: 80 }}
                onChange={e => setCap(e.target.value)}
                onBlur={() => { const n = Math.floor(Number(cap)); if (n >= 1 && n !== cfg.recruiterLinkedin.dailyCap) saveLi({ dailyCap: n }); }} />
            </div>
          </div>
        )}
        <div className="info-box sr-note">
          <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0 }} />
          <div>
            Keys are stored <strong>encrypted</strong> and only used for your own searches. Without any key the
            tab still checks GitHub and the company website, and still uses what your past emails taught it.
          </div>
        </div>
      </div>
    </div>
  );
}
