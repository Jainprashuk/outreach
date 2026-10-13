import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { fmtAgo } from '../lib/analytics';
import {
  adminCheckMailboxApi, adminPauseSendingApi, adminResumeSendingApi, adminRevokeSessionsApi,
  adminSendEmailNowApi, adminUpdateUserApi, type AdminSendNowType, type AdminUserRow,
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
