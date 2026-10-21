import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import Switch from './Switch';
import { fmtAgo } from '../lib/analytics';
import {
  adminCheckMailboxApi, adminPauseSendingApi, adminResumeSendingApi, adminRevokeSessionsApi,
  adminRemoveCloudWorkerApi, adminSetCloudWorkerApi, adminSendEmailNowApi, adminSetLibraryAccessApi, adminSetAiFallbackApi, adminUpdateUserApi, type AdminSendNowType, type AdminUserRow,
} from '../lib/api';

// Admin → Overview → click an account. Everything an admin can do to ONE
// account, in one place. Every number here comes from the fleet row (counts
// only); every action answers with counts too.

const SEND_NOW: Array<{ key: AdminSendNowType; label: string }> = [
  { key: 'weekly-report', label: 'Weekly report (last week, with PDF)' },
  { key: 'welcome', label: 'Welcome email' },
  { key: 'setup-reminder', label: 'Setup reminder' },
  { key: 'inactive', label: "We haven't seen you" },
];

// What deliver() answers when an email was not sent, in words.
const SKIP_REASON: Record<string, string> = {
  'opted-out': 'they opted out of this email',
  'user-blocked': 'you turned this email off for them',
  'master-off': 'lifecycle emails are switched off app-wide',
  'type-off': 'this email type is switched off app-wide',
  disabled: 'the account is disabled',
  'sender-not-configured': 'the system sender is not configured',
  'links-not-configured': 'OUTREACH_URL is not set',
  'test-mode': 'test mode is on, so only the test recipient gets email',
  'test-mode-no-recipient': 'test mode is on with no test recipient',
  'already-handled': 'one is already in flight',
};

const ago = (v: string | null | undefined) => (v ? fmtAgo(new Date(v).getTime()) : 'never');

// Their job-platform workers on the cloud VM (deploy/cloud-worker). The link is
// fixed by the name given to `cw add` (screen-<name>.<domain>), so the admin
// saves it here first, issues the token `cw add` asks for, then runs cw. The
// token is shown here once and never again.
function CloudWorker({ row, busy, setBusy, onChanged }: {
  row: AdminUserRow;
  busy: string | null;
  setBusy: (k: string | null) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const id = row.id!;
  const [url, setUrl] = useState(row.cloudScreenUrl || '');
  const [token, setToken] = useState<string | null>(null);
  const saved = row.cloudScreenUrl || null;

  const save = async (issueToken: boolean) => {
    if (issueToken && row.config.hasWorkerToken && !window.confirm(
      `Issue a new worker token for ${row.email}? It replaces their current one, so a worker on their own computer stops claiming runs.`)) return;
    setBusy(issueToken ? 'cw-token' : 'cw-save');
    try {
      const r = await adminSetCloudWorkerApi(id, url, issueToken);
      setUrl(r.cloudScreenUrl);
      if (r.token) setToken(r.token);
      toast(issueToken ? 'Link saved and token issued — copy it now' : 'Cloud browser link saved', 'success');
      onChanged();
    } catch (e: any) {
      toast(e.message || 'That did not work', 'error');
    } finally { setBusy(null); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the cloud browser for ${row.email} and revoke their worker token? Their cloud workers stop claiming runs.`)) return;
    setBusy('cw-rm');
    try {
      await adminRemoveCloudWorkerApi(id, true);
      setUrl(''); setToken(null);
      toast('Cloud browser removed and token revoked. Run: sudo cw rm <user> on the VM.', 'success');
      onChanged();
    } catch (e: any) {
      toast(e.message || 'That did not work', 'error');
    } finally { setBusy(null); }
  };

  const copy = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); toast('Token copied', 'success'); }
    catch { toast('Select the token and copy it by hand', 'error'); }
  };

  return (
    <>
      <h3>Cloud worker</h3>
      <div className="ud-action" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 8 }}>
        <div className="ud-action-text">
          <div>Job platforms in the cloud</div>
          <div>{saved
            ? <>Naukri, Instahyre and Hirist run on the cloud VM. Their browser: <a href={saved} target="_blank" rel="noreferrer">{saved.replace('https://', '')}</a></>
            : <>Their workers run on their own computer. To host them on the VM: enter <code>https://screen-&lt;name&gt;.jainprashuk.in</code>, issue a token, then run <code>sudo cw add &lt;name&gt; {row.email}</code> on the VM and paste the token.</>}</div>
        </div>
        <input type="url" value={url} placeholder="https://screen-name.jainprashuk.in" onChange={e => setUrl(e.target.value)}
          aria-label="Cloud browser link" style={{ width: '100%' }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-xs" type="button" disabled={!!busy || !url.trim()} onClick={() => save(false)}>
            <i className="ti ti-device-floppy" /> Save link
          </button>
          <button className="btn btn-xs btn-primary" type="button" disabled={!!busy || !url.trim()} onClick={() => save(true)}>
            <i className="ti ti-key" /> Save + issue token
          </button>
          {saved && (
            <button className="btn btn-xs btn-danger" type="button" disabled={!!busy} onClick={remove}>
              <i className="ti ti-cloud-off" /> Remove
            </button>
          )}
        </div>
        {token && (
          <div className="info-box" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span><strong>Worker token — shown once.</strong> Paste it where <code>sudo cw add</code> (or <code>cw token</code>) asks for it. Don't send it anywhere else.</span>
            <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{token}</code>
            <div><button className="btn btn-xs" type="button" onClick={copy}><i className="ti ti-copy" /> Copy</button></div>
          </div>
        )}
      </div>
    </>
  );
}

export default function AdminUserDrawer({ row, isSelf, onClose, onChanged, onOpenEmails }: {
  row: AdminUserRow;
  isSelf: boolean;
  onClose: () => void;
  /** Re-read the fleet overview after an action changed something. */
  onChanged: () => void;
  onOpenEmails: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [sendType, setSendType] = useState<AdminSendNowType>('weekly-report');
  const id = row.id!;

  useEffect(() => {
    // The email switches open as a modal on top; Escape closes that first.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.edit-modal-wrap.open')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (key: string, fn: () => Promise<string>, { reload = true, confirm }: { reload?: boolean; confirm?: string } = {}) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(key);
    try {
      toast(await fn(), 'success');
      if (reload) onChanged();
    } catch (e: any) {
      toast(e.message || 'That did not work', 'error');
    } finally {
      setBusy(null);
    }
  };

  const spin = (key: string, icon: string) => <i className={`ti ${busy === key ? 'ti-loader-2' : icon}`} style={busy === key ? { animation: 'spin 1s linear infinite' } : undefined} />;
  const pausedJobs = row.sendJobs.by?.paused || 0;
  const liveJobs = (row.sendJobs.by?.pending || 0) + (row.sendJobs.by?.processing || 0);
  const runningCampaigns = row.campaigns.by?.running || 0;

  return createPortal(
    <div className="user-drawer-wrap" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="user-drawer" role="dialog" aria-modal="true" aria-label={`Account ${row.email}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.email}</div>
            {row.name && <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>{row.name}</div>}
            <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
              {row.isAdmin && <span className="badge badge-approved">admin</span>}
              {!row.isAdmin && row.libraryAccess && <span className="badge" title="Can see the shared Library">library</span>}
              {row.status === 'active' && <span className="badge badge-sent">active</span>}
              {row.status === 'invited' && <span className="badge badge-pending">never signed in</span>}
              {row.status === 'disabled' && <span className="badge badge-rejected">disabled</span>}
              {isSelf && <span className="badge">you</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 5 }}>
              Last seen {ago(row.lastActiveAt || row.lastLoginAt)} · {row.activeSessions} session(s) · joined {ago(row.createdAt)}
            </div>
          </div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /></button>
        </div>

        <h3>At a glance</h3>
        <div className="ud-stats">
          {([
            ['Contacts', row.contacts.total], ['Emailed', row.contacts.everSent], ['Replied', row.contacts.everReplied],
            ['Leads', row.leads.total], ['Campaigns', row.campaigns.total], ['Interviews', row.interviews.total],
          ] as const).map(([label, v]) => (
            <div className="ud-stat" key={label}><b>{(v || 0).toLocaleString('en-IN')}</b><span>{label}</span></div>
          ))}
        </div>
        <Link className="btn btn-sm" style={{ marginTop: 10 }} to={`/analytics?user=${id}`} onClick={onClose}>
          <i className="ti ti-chart-bar" /> View their analytics (numbers only)
        </Link>

        <h3>Sending</h3>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Pause all sending</div>
            <div>{liveJobs} live batch(es), {runningCampaigns} running campaign(s). They can still resume it themselves.</div>
          </div>
          <button className="btn btn-xs" type="button" disabled={!!busy}
            onClick={() => run('pause', async () => {
              const r = await adminPauseSendingApi(id);
              return r.jobs || r.campaigns ? `Paused ${r.jobs} batch(es) and ${r.campaigns} campaign(s)` : 'Nothing was sending';
            }, { confirm: `Pause every live batch and running campaign for ${row.email}?` })}
          >{spin('pause', 'ti-player-pause')} Pause</button>
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Resume sending</div>
            <div>Only what an admin paused. {pausedJobs} batch(es) paused in total.</div>
          </div>
          <button className="btn btn-xs" type="button" disabled={!!busy}
            onClick={() => run('resume', async () => {
              const r = await adminResumeSendingApi(id);
              const parts = [`Resumed ${r.jobs} batch(es) and ${r.campaigns} campaign(s)`];
              if (r.jobsDone || r.campaignsCompleted) parts.push(`${r.jobsDone + r.campaignsCompleted} had nothing left and finished`);
              if (r.jobsNoCredentials) parts.push(`${r.jobsNoCredentials} need their Gmail password re-entered by them`);
              return parts.join(' · ');
            })}
          >{spin('resume', 'ti-player-play')} Resume</button>
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Check their mailbox now</div>
            <div>{row.config.hasGmail ? `Last checked ${ago(row.config.lastMailboxCheckAt)}. Can take up to a minute.` : 'Gmail is not connected.'}</div>
          </div>
          <button className="btn btn-xs" type="button" disabled={!!busy || !row.config.hasGmail}
            onClick={() => run('mailbox', async () => {
              const r = await adminCheckMailboxApi(id);
              if (r.skipped) return 'Gmail is not connected for this account';
              return `Mailbox checked: ${r.replied} new repl${r.replied === 1 ? 'y' : 'ies'}, ${r.bounced} bounce(s)`;
            })}
          >{spin('mailbox', 'ti-mail-search')} Check</button>
        </div>

        <h3>Emails</h3>
        <div className="ud-action">
          <div className="ud-action-text" style={{ flex: 1 }}>
            <div>Send now</div>
            <select value={sendType} onChange={e => setSendType(e.target.value as AdminSendNowType)} style={{ marginTop: 5, width: '100%' }}>
              {SEND_NOW.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <button className="btn btn-xs" type="button" disabled={!!busy}
            onClick={() => run('send', async () => {
              const r = await adminSendEmailNowApi(id, sendType);
              if (r.status === 'sent') return `Sent to ${r.to}${r.testMode ? ' (test mode)' : ''}`;
              throw new Error(`Not sent: ${SKIP_REASON[r.reason || ''] || r.reason || r.status}`);
            }, { reload: false })}
          >{spin('send', 'ti-send')} Send</button>
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Email switches</div>
            <div>Turn individual lifecycle emails on or off for this account.</div>
          </div>
          <button className="btn btn-xs" type="button" onClick={onOpenEmails}><i className="ti ti-mail-cog" /> Open</button>
        </div>

        <CloudWorker row={row} busy={busy} setBusy={setBusy} onChanged={onChanged} />

        <h3>Access</h3>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>{row.isAdmin ? 'Remove admin' : 'Make admin'}</div>
            <div>{row.isAdmin ? 'They keep their account, without the Admin panel.' : 'They can see every account\'s counts and act on them.'}</div>
          </div>
          <button className={`btn btn-xs${row.isAdmin ? ' btn-danger' : ''}`} type="button"
            disabled={!!busy || (isSelf && row.isAdmin)} title={isSelf && row.isAdmin ? 'You cannot remove your own admin access' : undefined}
            onClick={() => run('admin', async () => {
              await adminUpdateUserApi(id, { isAdmin: !row.isAdmin });
              return row.isAdmin ? 'Admin access removed' : 'Now an admin';
            }, { confirm: row.isAdmin ? `Remove admin access from ${row.email}?` : `Make ${row.email} an admin? They will see every account's counts and can act on them.` })}
          >{spin('admin', row.isAdmin ? 'ti-shield-off' : 'ti-shield-check')} {row.isAdmin ? 'Remove' : 'Make admin'}</button>
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Library tab</div>
            <div>{row.isAdmin
              ? 'Admins always see the shared Library.'
              : row.libraryAccess ? 'They can see and copy from the shared Library.' : 'Hidden. Turn on to let them see and copy from the shared Library.'}
              {row.librarySharing === false && ' Their own data is kept out of it (their choice).'}</div>
          </div>
          <Switch label="Library tab" checked={row.isAdmin || row.libraryAccess === true} disabled={!!busy || row.isAdmin}
            onChange={on => run('library', async () => {
              await adminSetLibraryAccessApi(id, on);
              return on ? 'Library turned on for them' : 'Library hidden for them';
            })} />
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Use my AI keys (fallback)</div>
            <div>{(() => {
              const n = row.config?.aiKeyCount ?? 0;
              const own = n ? `Their own keys: ${n} of 3 (always used first).` : 'No AI keys of their own.';
              return row.aiOwnerFallback
                ? `${own} When they have none, AI runs on your keys.`
                : `${own} Turn on to let AI run on your keys when they have none.`;
            })()}</div>
          </div>
          <Switch label="Use my AI keys (fallback)" checked={row.aiOwnerFallback === true} disabled={!!busy}
            onChange={on => run('aifallback', async () => {
              await adminSetAiFallbackApi(id, on);
              return on ? 'They can now use your AI keys as a fallback' : 'Your AI keys are off for them';
            }, on ? { confirm: `Let ${row.email} use your AI keys when they have none of their own? Their usage counts against your free limits.` } : undefined)} />
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>Sign out everywhere</div>
            <div>{row.activeSessions} active session(s).</div>
          </div>
          <button className="btn btn-xs" type="button" disabled={!!busy || row.activeSessions === 0}
            onClick={() => run('revoke', async () => `Ended ${(await adminRevokeSessionsApi(id)).revoked} session(s)`)}
          >{spin('revoke', 'ti-logout')} Sign out</button>
        </div>
        <div className="ud-action">
          <div className="ud-action-text">
            <div>{row.status === 'disabled' ? 'Re-enable account' : 'Disable account'}</div>
            <div>{row.status === 'disabled' ? 'They can sign in again.' : 'Revokes access and signs them out. Their data is kept.'}</div>
          </div>
          {row.status === 'disabled' ? (
            <button className="btn btn-xs" type="button" disabled={!!busy}
              onClick={() => run('status', async () => { await adminUpdateUserApi(id, { status: 'active' }); return 'Account re-enabled'; })}
            >{spin('status', 'ti-lock-open')} Enable</button>
          ) : (
            <button className="btn btn-xs btn-danger" type="button" disabled={!!busy || isSelf}
              title={isSelf ? 'You cannot disable your own account' : undefined}
              onClick={() => run('status', async () => { await adminUpdateUserApi(id, { status: 'disabled' }); return 'Account disabled'; },
                { confirm: `Disable ${row.email}? Their data is kept, but they are signed out everywhere and cannot sign back in.` })}
            >{spin('status', 'ti-lock')} Disable</button>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
