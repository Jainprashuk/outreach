import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { fmtAgo } from '../lib/analytics';
import {
  adminEmailsApi, adminSetEmailSwitchApi, adminSendSampleApi,
  type AdminEmailsView, type LifecycleType,
} from '../lib/api';

const REASON_LABELS: Record<string, string> = {
  'type-off': 'type off', 'user-blocked': 'off for user', 'opted-out': 'opted out', disabled: 'disabled account',
};

const fieldLabel = (field: string, types: AdminEmailsView['types']) => {
  if (field === 'enabled') return 'All lifecycle emails';
  if (field === 'testMode') return 'Test mode';
  const t = types.find(x => `type:${x.key}` === field);
  return t ? t.label : field;
};

/** App-wide lifecycle email switches. Per-user switches live on the accounts table. */
export default function AdminEmailsCard() {
  const toast = useToast();
  const [data, setData] = useState<AdminEmailsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await adminEmailsApi()); } catch (e: any) { toast(e.message || 'Could not load email settings', 'error'); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const flip = async (field: string, value: boolean) => {
    if (field === 'enabled' && value) {
      const test = data?.config.testMode;
      const msg = test
        ? 'Turn lifecycle emails on in TEST MODE? Only your own emails will be sent (to you). Everyone else’s are recorded, not sent.'
        : 'Turn lifecycle emails on for EVERYONE? Real users will start getting the email types ticked below.';
      if (!window.confirm(msg)) return;
    }
    if (field === 'testMode' && !value && data?.config.enabled) {
      if (!window.confirm('Turn test mode off? Real users will start getting emails from the next run. Run scripts/lifecycle-preview.js --env=prod first to see who.')) return;
    }
    setBusy(field);
    try {
      await adminSetEmailSwitchApi(field, value);
      await load();
    } catch (e: any) {
      toast(e.message || 'Could not change that', 'error');
    } finally {
      setBusy(null);
    }
  };

  const sample = async (type: LifecycleType) => {
    setBusy(`sample:${type}`);
    try {
      const r = await adminSendSampleApi(type);
      toast(`Sample sent to ${r.to}`, 'success');
    } catch (e: any) {
      toast(e.message || 'Could not send the sample', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="skeleton" style={{ height: 160, marginTop: 16 }} />;
  const { config } = data;
  const live = config.enabled && !config.testMode;

  return (
    <div className="an-card" style={{ marginTop: 16 }}>
      <div className="an-card-head">
        <div className="an-card-title">
          <i className="ti ti-mail-cog" /> Lifecycle emails
          <span className={`badge ${live ? 'badge-sent' : config.enabled ? 'badge-pending' : ''}`} style={{ marginLeft: 8 }}>
            {live ? 'live' : config.enabled ? 'test mode' : 'off'}
          </span>
        </div>
        <div className="an-card-sub">
          Everything starts off: an email goes out only once you turn on the master switch AND that email’s own switch.
          A user’s own opt-out always wins. Turning a switch back on never sends what was missed.
        </div>
      </div>
      <div className="an-card-body">
        {(!data.readiness.sender || !data.readiness.links) && (
          <div className="info-box danger" style={{ marginBottom: 12 }}>
            <strong>This deployment cannot send lifecycle email yet.</strong>{' '}
            {!data.readiness.sender && <>Set <code>LIFECYCLE_FROM_EMAIL</code> (and <code>RESEND_API_KEY</code>). </>}
            {!data.readiness.links && <>Set <code>OUTREACH_URL</code> and <code>CREDENTIAL_KEY</code>. </>}
            Until then nothing is sent, whatever the switches say.
          </div>
        )}

        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={config.enabled} disabled={busy === 'enabled'} onChange={e => flip('enabled', e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>All lifecycle emails</span>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>Master switch. Off = nothing below is sent and nothing is used up. On = only the emails ticked below.</div>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={config.testMode} disabled={busy === 'testMode'} onChange={e => flip('testMode', e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Test mode: send only to me</span>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              Only {config.testRecipient || 'the admin who turns it on'} gets their own emails. Everyone else’s are recorded as
              “test only” and not sent, and they still get the real one once test mode is off.
            </div>
          </span>
        </label>

        <table className="an-table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Email</th><th>On</th><th style={{ textAlign: 'right' }}>Sent</th><th style={{ textAlign: 'right' }}>Test only</th><th>Skipped</th><th style={{ textAlign: 'right' }}>Failed</th><th /></tr>
          </thead>
          <tbody>
            {data.types.map(t => {
              const c = data.counts[t.key];
              return (
                <tr key={t.key}>
                  <td>{t.label}</td>
                  <td>
                    <input type="checkbox" aria-label={`${t.label} on`} checked={config.types[t.key]} disabled={busy === `type:${t.key}`}
                      onChange={e => flip(`type:${t.key}`, e.target.checked)} />
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.sent}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text3)' }}>{c.testOnly}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--text2)' }}>
                    {c.skipped ? Object.entries(c.skippedBy).map(([r, v]) => `${v} ${REASON_LABELS[r] || r}`).join(' · ') : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.failed ? 'var(--red)' : undefined }}>{c.failed}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-xs" type="button" disabled={busy === `sample:${t.key}` || !data.readiness.sender}
                      title="Send this email to yourself, built from your own data. Ignores the switches."
                      onClick={() => sample(t.key)}>
                      <i className="ti ti-send" /> Send me a sample
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Counts cover the last 30 days.</div>

        {data.recentFailures.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 4 }}>Recent failures</div>
            {data.recentFailures.map(f => (
              <div key={`${f.email}${f.at}`} style={{ fontSize: 12, color: 'var(--text2)' }}>
                {f.email} · {data.types.find(t => t.key === f.type)?.label || f.type} · {f.attempts} attempt(s) · {fmtAgo(new Date(f.at).getTime())}
              </div>
            ))}
          </div>
        )}

        {data.changes.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 4 }}>Recent changes</div>
            {data.changes.slice(0, 8).map(c => (
              <div key={`${c.field}${c.at}`} style={{ fontSize: 12, color: 'var(--text2)' }}>
                {fieldLabel(c.field, data.types)} turned <strong>{c.value ? 'on' : 'off'}</strong> by {c.byEmail} · {fmtAgo(new Date(c.at).getTime())}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
