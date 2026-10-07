import { useState } from 'react';
import { useToast } from '../context/ToastContext';
import { fmtAgo } from '../lib/analytics';
import { adminSetEmailSwitchApi, adminSendSampleApi, adminSendDigestNowApi, type AdminEmailsView, type LifecycleType } from '../lib/api';
import { EMAIL_TYPES } from '../lib/lifecycleTypes';
import InfoTip from './InfoTip';
import Switch from './Switch';

const REASON_LABELS: Record<string, string> = {
  'type-off': 'type off', 'user-blocked': 'off for user', 'opted-out': 'opted out', disabled: 'disabled account',
};

const fieldLabel = (field: string) => {
  if (field === 'enabled') return 'All lifecycle emails';
  if (field === 'testMode') return 'Test mode';
  if (field === 'types:all') return 'Every email type';
  return EMAIL_TYPES.find(x => `type:${x.key}` === field)?.label || field;
};

/** App-wide lifecycle email switches. Per-account switches open from the accounts table. */
export default function AdminEmailsCard({ data, reload }: { data: AdminEmailsView | null; reload: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const flip = async (field: string, value: boolean) => {
    const cfg = data?.config;
    const goingLive = cfg && (
      (field === 'enabled' && value && !cfg.testMode) ||
      (field === 'testMode' && !value && cfg.enabled)
    );
    if (field === 'enabled' && value && cfg?.testMode
      && !window.confirm('Turn lifecycle emails on in TEST MODE? Only your own emails are sent (to you); everyone else’s are recorded, not sent.')) return;
    if (goingLive && !window.confirm('This makes emails go to REAL users from the next run, for the types switched on below. Run scripts/lifecycle-preview.js --env=prod first to see who. Continue?')) return;
    setBusy(field);
    try {
      await adminSetEmailSwitchApi(field, value);
      await reload();
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

  const digestNow = async () => {
    setBusy('digest-now');
    try {
      const r = await adminSendDigestNowApi();
      toast(`Today's digest sent to ${r.to}`, 'success');
      await reload();
    } catch (e: any) {
      toast(e.message || 'Could not send the digest', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="skeleton" style={{ height: 160, marginTop: 16 }} />;
  const { config } = data;
  const live = config.enabled && !config.testMode;
  const onCount = EMAIL_TYPES.filter(t => config.types[t.key]).length;

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
          Everything starts off. An email goes out only when the master switch AND that email’s switch are on.
          You can also switch emails off for one account from the accounts table below. A user’s own opt-out always wins,
          and turning a switch back on never sends what was missed.
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          <div className="em-row" style={{ borderTop: 0, background: 'var(--bg3)', borderRadius: 8, padding: 12, gridTemplateColumns: '1fr auto' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>All lifecycle emails</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Master switch. Off = nothing is sent and nothing is used up.</div>
            </div>
            <Switch checked={config.enabled} disabled={busy === 'enabled'} label="All lifecycle emails" onChange={v => flip('enabled', v)} />
          </div>
          <div className="em-row" style={{ borderTop: 0, background: 'var(--bg3)', borderRadius: 8, padding: 12, gridTemplateColumns: '1fr auto' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                Test mode: send only to me
                <InfoTip label="What is test mode?">
                  <strong>Send only to me</strong>
                  Only {config.testRecipient || 'the admin who turns it on'} gets their own emails. Everyone else’s are
                  recorded as “test only” and not sent. They are not redirected to you, because reports contain the
                  user’s contacts. Each still gets the real email once test mode is off.
                </InfoTip>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>{config.testMode ? `Only ${config.testRecipient || 'you'} gets mail` : 'Off: real users get mail'}</div>
            </div>
            <Switch checked={config.testMode} disabled={busy === 'testMode'} label="Test mode" onChange={v => flip('testMode', v)} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '16px 0 4px' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Email types <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· {onCount} of {EMAIL_TYPES.length} on</span></div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-xs btn-success" type="button" disabled={!!busy || onCount === EMAIL_TYPES.length} onClick={() => flip('types:all', true)}>
              <i className="ti ti-checks" /> Enable all
            </button>
            <button className="btn btn-xs btn-danger" type="button" disabled={!!busy || onCount === 0} onClick={() => flip('types:all', false)}>
              <i className="ti ti-ban" /> Disable all
            </button>
          </div>
        </div>

        <div>
          {EMAIL_TYPES.map(t => {
            const c = data.counts[t.key];
            const on = config.types[t.key];
            const skipped = c.skipped ? Object.entries(c.skippedBy).map(([r, v]) => `${v} ${REASON_LABELS[r] || r}`).join(' · ') : '';
            return (
              <div className="em-row" key={t.key}>
                <div className="em-ico" style={{ color: on ? 'var(--green)' : 'var(--text3)' }}><i className={`ti ${t.icon}`} /></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 13, flexWrap: 'wrap' }}>
                    {t.label}
                    <InfoTip label={`What is ${t.label}?`}><strong>{t.label}</strong>{t.what}<br /><br /><strong>When</strong>{t.when}</InfoTip>
                    <button className="btn btn-xs" type="button" disabled={busy === `sample:${t.key}` || !data.readiness.sender}
                      title="Send this email to yourself, built from your own data. Ignores the switches."
                      onClick={() => sample(t.key)} style={{ marginLeft: 4 }}>
                      <i className="ti ti-send" /> Sample
                    </button>
                    {t.key === 'admin-daily' && (
                      <button className="btn btn-xs btn-primary" type="button" disabled={busy === 'digest-now' || !data.readiness.sender}
                        title="Email you today's digest so far, right now. Ignores the switches. Up to 5 a day."
                        onClick={digestNow}>
                        <i className="ti ti-mail-bolt" /> Send today's digest now
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>
                    30 days: <span style={{ color: 'var(--text2)' }}>{c.sent} sent</span>
                    {c.testOnly > 0 && <> · {c.testOnly} test only</>}
                    {skipped && <> · skipped {skipped}</>}
                    {c.failed > 0 && <span style={{ color: 'var(--red)' }}> · {c.failed} failed</span>}
                  </div>
                </div>
                <Switch checked={on} disabled={busy === `type:${t.key}` || busy === 'types:all'} label={`${t.label} app-wide`} onChange={v => flip(`type:${t.key}`, v)} />
              </div>
            );
          })}
        </div>

        {data.recentFailures.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 4 }}>Recent failures</div>
            {data.recentFailures.map(f => (
              <div key={`${f.email}${f.at}`} style={{ fontSize: 12, color: 'var(--text2)' }}>
                {f.email} · {EMAIL_TYPES.find(t => t.key === f.type)?.label || f.type} · {f.attempts} attempt(s) · {fmtAgo(new Date(f.at).getTime())}
              </div>
            ))}
          </div>
        )}

        {data.changes.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>Recent changes ({data.changes.length})</summary>
            <div style={{ marginTop: 6 }}>
              {data.changes.slice(0, 15).map(c => (
                <div key={`${c.field}${c.at}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '2px 0' }}>
                  {fieldLabel(c.field)} turned <strong>{c.value ? 'on' : 'off'}</strong> by {c.byEmail} · {fmtAgo(new Date(c.at).getTime())}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
