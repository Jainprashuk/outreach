// The strip under the top bar that tells an account with no Groq key of its own
// (the required one) and no admin fallback that AI is moving to their own free
// key — amber with a countdown during the grace period, red once it is over.
// Failing keys show only on the Settings card and in the bell.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { aiAccessApi, AI_KEYS_CHANGED_EVENT, type AiAccess } from '../lib/api';

const DISMISS_KEY = 'aiKeyBannerDismissed';
const today = () => new Date().toISOString().slice(0, 10);
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

// Shared across page changes: every page mounts its own Layout, and one check a minute is plenty.
let cached: { at: number; value: AiAccess } | null = null;
const TTL_MS = 60_000;

function dismissedToday() {
  try { return localStorage.getItem(DISMISS_KEY) === today(); } catch { return false; }
}

export default function AiKeyBanner() {
  const { pathname } = useLocation();
  const [access, setAccess] = useState<AiAccess | null>(cached?.value ?? null);
  const [hidden, setHidden] = useState(dismissedToday);

  useEffect(() => {
    let live = true;
    const load = (force = false) => {
      if (!force && cached && Date.now() - cached.at < TTL_MS) { setAccess(cached.value); return; }
      aiAccessApi()
        .then(v => { cached = { at: Date.now(), value: v }; if (live) setAccess(v); })
        .catch(() => {});
    };
    load();
    const onChange = () => load(true);
    window.addEventListener(AI_KEYS_CHANGED_EVENT, onChange);
    return () => { live = false; window.removeEventListener(AI_KEYS_CHANGED_EVENT, onChange); };
  }, []);

  if (!access || hidden || pathname.startsWith('/settings')) return null;
  if (!access.enforce || access.ready || access.ownerFallback) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, today()); } catch { /* private mode: hide for this page only */ }
    setHidden(true);
  };

  const grace = access.inGrace && access.graceUntil;
  const daysLeft = grace ? Math.max(1, Math.ceil((new Date(access.graceUntil!).getTime() - Date.now()) / 86_400_000)) : 0;
  const tone = grace
    ? { bg: 'var(--amber-bg)', fg: 'var(--amber)', icon: 'ti-alert-triangle' }
    : { bg: 'var(--red-bg)', fg: 'var(--red)', icon: 'ti-circle-x' };

  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '10px 16px', background: tone.bg, color: tone.fg, fontSize: 13, lineHeight: 1.45,
      borderBottom: `1px solid color-mix(in srgb, ${tone.fg} 25%, transparent)`,
    }}>
      <i className={`ti ${tone.icon}`} style={{ fontSize: 16, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        {grace ? (
          <>
            <strong>From {day(access.graceUntil!)}, AI features need your own free Groq key.</strong>{' '}
            About 2 minutes, no card. <span style={{ opacity: 0.8 }}>({daysLeft} day{daysLeft === 1 ? '' : 's'} left)</span>
          </>
        ) : (
          <>
            <strong>AI features are off for your account.</strong>{' '}
            Add your free Groq key to turn reply sorting and drafts back on.
          </>
        )}
      </div>
      <Link to="/settings#ai-keys" className="btn btn-primary btn-sm" style={{ flexShrink: 0 }}>Add key</Link>
      <button type="button" aria-label="Hide for today" onClick={dismiss}
        style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
        <i className="ti ti-x" />
      </button>
    </div>
  );
}
