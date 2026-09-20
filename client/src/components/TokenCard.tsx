import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';

/**
 * Issue / show-once / revoke, for the two per-account bearer tokens.
 *
 * Only a hash of each is stored, so the value genuinely cannot be shown again
 * later. That shapes the whole component: the secret stays on screen until it is
 * dismissed on purpose, rather than disappearing on the next re-render.
 */
export default function TokenCard({
  title, icon, description, registeredLabel, issueLabel, secretLabel, secretHint,
  loadStatus, issue, revoke, revokeWarning, format,
}: {
  title: string;
  icon: string;
  description: string;
  registeredLabel: string;
  issueLabel: string;
  secretLabel: string;
  secretHint: string;
  loadStatus: () => Promise<{ registered: boolean }>;
  issue: () => Promise<{ token: string; path?: string }>;
  revoke: () => Promise<unknown>;
  revokeWarning: string;
  /** Turns the issued value into what the user actually needs to copy. */
  format?: (r: { token: string; path?: string }) => string;
}) {
  const toast = useToast();
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadStatus().then(s => setRegistered(s.registered)).catch(() => setRegistered(false));
  }, [loadStatus]);

  const doIssue = async () => {
    if (registered && !window.confirm(
      `This replaces the existing one, which stops working immediately. Continue?`)) return;
    setBusy(true);
    try {
      const r = await issue();
      setSecret(format ? format(r) : r.token);
      setRegistered(true);
    } catch (e: any) {
      toast(e.message || 'Could not generate that', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async () => {
    if (!window.confirm(revokeWarning)) return;
    setBusy(true);
    try {
      await revoke();
      setSecret('');
      setRegistered(false);
      toast('Revoked', 'success');
    } catch (e: any) {
      toast(e.message || 'Could not revoke that', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast('Copied', 'success');
    } catch {
      // Clipboard access is blocked outside a secure context, which includes
      // plain-http local development. The value is on screen either way.
      toast('Could not copy — select the text and copy it manually', 'info');
    }
  };

  return (
    <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <i className={`ti ${icon}`} style={{ fontSize: 16, color: 'var(--text2)' }} />
        <strong style={{ fontSize: 13.5 }}>{title}</strong>
        {registered === true && <span className="badge badge-sent">{registeredLabel}</span>}
        {registered === false && <span className="badge badge-pending">not set up</span>}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text2)', margin: '0 0 10px' }}>{description}</p>

      {secret && (
        <div className="info-box" style={{ borderColor: 'var(--amber)', marginBottom: 10, display: 'block' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {secretLabel} — shown once, and never again.
          </div>
          <code
            style={{
              display: 'block', wordBreak: 'break-all', fontSize: 12,
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 8,
            }}
          >{secret}</code>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>{secretHint}</div>
          <button className="btn btn-xs" type="button" onClick={copy}>
            <i className="ti ti-copy" /> Copy
          </button>{' '}
          <button className="btn btn-xs" type="button" onClick={() => setSecret('')}>
            Done
          </button>
        </div>
      )}

      <button className="btn btn-sm" type="button" onClick={doIssue} disabled={busy}>
        <i className="ti ti-refresh" /> {registered ? `Replace ${issueLabel}` : `Generate ${issueLabel}`}
      </button>{' '}
      {registered && (
        <button className="btn btn-sm btn-danger" type="button" onClick={doRevoke} disabled={busy}>
          Revoke
        </button>
      )}
    </div>
  );
}
