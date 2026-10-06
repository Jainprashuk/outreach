// Settings card for the Discover tab's free services. Each key is your own,
// stored encrypted, and never sent back to this page — only whether one is set.
import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import {
  discoveryConfigApi, removeDiscoveryKeyApi, saveDiscoveryKeysApi,
  type DiscoveryConfigView, type DiscoveryProvider,
} from '../lib/api';

const PROVIDERS: { key: DiscoveryProvider; name: string; what: string; url: string; usage?: 'tavily' | 'serpapi' | 'hunter' }[] = [
  { key: 'tavily', name: 'Tavily', what: 'Finds people at a company (1,000 free searches a month, no card).', url: 'https://app.tavily.com', usage: 'tavily' },
  { key: 'serpapi', name: 'SerpApi', what: 'Backup people search when Tavily is used up (250 free a month).', url: 'https://serpapi.com/users/sign_up', usage: 'serpapi' },
  { key: 'hunter', name: 'Hunter', what: 'Last resort for a company’s email format, once per company (50 free a month).', url: 'https://hunter.io/users/sign_up', usage: 'hunter' },
  { key: 'github', name: 'GitHub token', what: 'Optional. Raises GitHub’s limit from 60 to 5,000 requests an hour. No scopes needed.', url: 'https://github.com/settings/personal-access-tokens/new' },
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
        {PROVIDERS.map(p => {
          const has = !!cfg?.keys[p.key];
          const used = p.usage && cfg ? cfg.usage[p.usage] : null;
          const cap = cfg?.caps[p.key] ?? null;
          return (
            <div className="form-group" style={{ marginBottom: 14 }} key={p.key}>
              <label className="form-label">
                {p.name}
                {has
                  ? <span className="badge badge-sent" style={{ marginLeft: 8 }}><i className="ti ti-lock" /> stored</span>
                  : <span className="badge badge-pending" style={{ marginLeft: 8 }}>not set</span>}
                {used !== null && cap !== null && has && (
                  <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text3)', fontSize: 11 }}>{used} of {cap} used this month</span>
                )}
              </label>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>
                {p.what} <a href={p.url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>Get a free key</a>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input type="password" autoComplete="off" style={{ flex: 1, minWidth: 200 }}
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
        <div className="info-box" style={{ marginBottom: 0 }}>
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
