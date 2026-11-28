// Admin → Accounts. Find an account fast (search, filter, sort), add one, and
// act on it from the row; click the row for everything else (the drawer).
import { useMemo, useState } from 'react';
import { RefreshBar, Refreshing } from '../RefreshBar';
import Avatar from '../Avatar';
import InfoTip from '../InfoTip';
import { fmtAgo } from '../../lib/analytics';
import { EMAIL_TYPES, effectiveState, TONE_COLOR } from '../../lib/lifecycleTypes';
import {
  adminRevokeSessionsApi, adminUpdateUserApi,
  type AdminOverview, type AdminUserRow, type AdminEmailsView,
} from '../../lib/api';

export type AccountFilter = 'all' | 'active' | 'invited' | 'setup' | 'disabled' | 'admins';
type Sort = 'recent' | 'sent' | 'contacts' | 'newest' | 'email';

const FILTERS: Array<{ id: AccountFilter; label: string; test: (u: AdminUserRow) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'active', label: 'Active', test: u => u.status === 'active' },
  { id: 'invited', label: 'Never signed in', test: u => u.status === 'invited' },
  { id: 'setup', label: 'Setup incomplete', test: u => u.status === 'active' && !u.onboarding.completedAt },
  { id: 'disabled', label: 'Disabled', test: u => u.status === 'disabled' },
  { id: 'admins', label: 'Admins', test: u => u.isAdmin },
];

const seen = (u: AdminUserRow) => u.lastActiveAt || u.lastLoginAt;
const ts = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0);
const SORTS: Record<Sort, { label: string; cmp: (a: AdminUserRow, b: AdminUserRow) => number }> = {
  recent: { label: 'Last seen', cmp: (a, b) => ts(seen(b)) - ts(seen(a)) },
  sent: { label: 'Most emails sent', cmp: (a, b) => b.contacts.everSent - a.contacts.everSent },
  contacts: { label: 'Most contacts', cmp: (a, b) => b.contacts.total - a.contacts.total },
  newest: { label: 'Newest first', cmp: (a, b) => ts(b.createdAt) - ts(a.createdAt) },
  email: { label: 'Email A–Z', cmp: (a, b) => a.email.localeCompare(b.email) },
};

const ago = (v: string | null | undefined) => (v ? fmtAgo(new Date(v).getTime()) : '—');

/** Health pills. Present/absent only — never what the thing actually contains. */
function ConfigPills({ row }: { row: AdminUserRow }) {
  const pills = [
    { on: row.config.hasGmail, icon: 'ti-mail', label: 'Gmail connected' },
    { on: row.config.templates > 0, icon: 'ti-file-text', label: `${row.config.templates} template(s)` },
    { on: row.config.hasWorkerToken, icon: 'ti-robot', label: 'Scrape worker token' },
    { on: row.config.hasShareToken, icon: 'ti-share', label: 'Share link' },
  ];
  return (
    <span style={{ display: 'inline-flex', gap: 5 }}>
      {pills.map(p => (
        <i
          key={p.icon} className={`ti ${p.icon}`} title={`${p.label}: ${p.on ? 'yes' : 'no'}`}
          style={{ fontSize: 14, color: p.on ? 'var(--green)' : 'var(--border-md)' }}
        />
      ))}
    </span>
  );
}

function InviteForm({ invite, onClose }: { invite: (email: string, notify: boolean) => Promise<boolean>; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!v) return;
    setBusy(true);
    if (await invite(v, notify)) setEmail('');
    setBusy(false);
  };
  return (
    <div className="adm-invite">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="adm-invite-title"><i className="ti ti-user-plus" /> Whitelist an address</div>
          <div className="adm-invite-sub">That is the whole of account creation — they sign in with a code emailed to them. No password is ever issued.</div>
        </div>
        <button type="button" className="btn btn-xs" onClick={onClose} aria-label="Close"><i className="ti ti-x" /></button>
      </div>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="login-input" type="email" required placeholder="person@example.com" autoFocus
          value={email} onChange={e => setEmail(e.target.value)} style={{ flex: 1, minWidth: 220 }}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? <><i className="ti ti-loader" /> Adding…</> : <><i className="ti ti-plus" /> Whitelist</>}
        </button>
      </form>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 12.5, color: 'var(--text2)', cursor: 'pointer', flexWrap: 'wrap' }}>
        <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
        Email them to say their access is ready
        <span style={{ color: 'var(--text3)' }}>— otherwise they have no way of knowing the account exists.</span>
      </label>
    </div>
  );
}

export default function AdminAccountsPanel({
  data, loading, selfId, busyId, emailsConfig, filter, setFilter, inviteOpen, setInviteOpen, invite, act, openDrawer, openEmails,
}: {
  data: AdminOverview;
  loading: boolean;
  selfId: string | undefined;
  busyId: string | null;
  emailsConfig: AdminEmailsView['config'] | null;
  filter: AccountFilter;
  setFilter: (f: AccountFilter) => void;
  inviteOpen: boolean;
  setInviteOpen: (v: boolean) => void;
  invite: (email: string, notify: boolean) => Promise<boolean>;
  act: (row: AdminUserRow, fn: () => Promise<any>, done: string) => void;
  openDrawer: (id: string) => void;
  openEmails: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(f => [f.id, data.users.filter(f.test).length])) as Record<AccountFilter, number>,
    [data.users],
  );
  const rows = useMemo(() => {
    const test = FILTERS.find(f => f.id === filter)!.test;
    const needle = q.trim().toLowerCase();
    return data.users
      .filter(u => test(u) && (!needle || u.email.toLowerCase().includes(needle) || (u.name || '').toLowerCase().includes(needle)))
      .sort(SORTS[sort].cmp);
  }, [data.users, filter, q, sort]);

  return (
    <>
      {inviteOpen && <InviteForm invite={invite} onClose={() => setInviteOpen(false)} />}

      <div className="adm-toolbar">
        <div className="adm-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input className="login-input" type="search" placeholder="Search email or name" aria-label="Search accounts"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="adm-toolbar-end">
          <select className="login-input" aria-label="Sort accounts" value={sort} onChange={e => setSort(e.target.value as Sort)} style={{ width: 'auto' }}>
            {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{SORTS[s].label}</option>)}
          </select>
          {!inviteOpen && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setInviteOpen(true)}>
              <i className="ti ti-user-plus" /> Add account
            </button>
          )}
        </div>
      </div>

      <div className="adm-chips" role="group" aria-label="Filter accounts">
        {FILTERS.map(f => (counts[f.id] > 0 || f.id === 'all' || f.id === filter) && (
          <button key={f.id} type="button" className={'adm-chip' + (filter === f.id ? ' on' : '')}
            aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="adm-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      <RefreshBar active={loading} />
      <Refreshing active={loading}>
        <div className="table-card adm-table">
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Setup</th><th>Activity</th>
                <th>
                  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                    Emails
                    <InfoTip label="What do the email icons mean?">
                      <strong>One icon per email</strong>
                      {EMAIL_TYPES.map(t => t.label).join(' · ')}.<br /><br />
                      <strong>Colour = what will actually happen</strong>
                      Green: will send · Blue: test mode, recorded only · Red: you turned it off for this user ·
                      Amber: they opted out · Grey: off app-wide, master off, or account disabled.
                      Click to change.
                    </InfoTip>
                  </span>
                </th>
                <th><span className="adm-vh">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="an-empty">
                    <i className="ti ti-user-search" />
                    No accounts match{q ? <> “{q}”</> : null}.{' '}
                    <button type="button" className="adm-linkbtn" onClick={() => { setQ(''); setFilter('all'); }}>Clear filters</button>
                  </div>
                </td></tr>
              )}
              {rows.map(u => {
                const isSelf = u.id === selfId;
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className={u.id ? 'tr-clickable' : undefined}
                    title={u.id ? 'Open this account — details and actions' : undefined}
                    // Buttons inside the row keep their own job.
                    onClick={e => { if (u.id && !(e.target as HTMLElement).closest('button, a, input, select')) openDrawer(u.id); }}>
                    <td>
                      <div className="adm-acct">
                        <Avatar name={u.name || u.email} />
                        <div style={{ minWidth: 0 }}>
                          <div className="adm-acct-name">{u.email}</div>
                          {u.name && <div className="adm-sub">{u.name}</div>}
                          <div className="adm-acct-badges">
                            {u.isAdmin && <span className="badge badge-approved">admin</span>}
                            {!u.isAdmin && u.libraryAccess && <span className="badge" title="Can see the shared Library">library</span>}
                            {(u.config.aiKeyCount ?? 0) > 0
                              ? <span className="badge" title="How many of their own AI keys are saved (Groq is the required one)">keys {u.config.aiKeyCount}/3</span>
                              : u.aiOwnerFallback
                                ? <span className="badge badge-queued" title="AI runs on your keys">AI fallback</span>
                                : <span className="badge" title="No AI keys of their own and no fallback" style={{ opacity: 0.7 }}>no AI keys</span>}
                            {u.status === 'invited' && <span className="badge badge-pending">never signed in</span>}
                            {u.status === 'disabled' && <span className="badge badge-rejected">disabled</span>}
                            {isSelf && <span className="badge">you</span>}
                          </div>
                          <div className="adm-sub" style={{ marginTop: 5 }}>
                            Seen {ago(seen(u))} · {u.activeSessions} session(s)
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {u.onboarding.completedAt
                        ? <span className="badge badge-sent">done</span>
                        : <span className="badge badge-pending" style={{ whiteSpace: 'nowrap' }}>step {u.onboarding.step + 1} of 3</span>}
                      <div style={{ marginTop: 6 }}><ConfigPills row={u} /></div>
                    </td>
                    <td>
                      <div className="adm-pipe">
                        <span><b>{u.contacts.total}</b> contacts</span>
                        <span><b>{u.contacts.everSent}</b> sent · <b>{u.contacts.everReplied}</b> replied</span>
                        <span><b>{u.leads.total}</b> leads · <b>{u.campaigns.total}</b> campaigns</span>
                        <span>
                          <b>{u.scrapes.total}</b> scrapes
                          {(u.scrapes.by.failed || 0) > 0 && <em> · {u.scrapes.by.failed} failed</em>}
                        </span>
                      </div>
                    </td>
                    <td>
                      {u.id && (
                        <button className="em-strip" type="button" onClick={() => openEmails(u.id!)}
                          aria-label={`Lifecycle emails for ${u.email}`} title="How many emails will actually be sent to this account. Click to change.">
                          {EMAIL_TYPES.map(t => {
                            const eff = effectiveState(t, u, emailsConfig);
                            return <i key={t.key} className={`ti ${t.icon}`} style={{ color: TONE_COLOR[eff.tone] }} title={`${t.label}: ${eff.label}`} />;
                          })}
                          <span style={{ fontSize: 11, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', marginLeft: 2 }}>
                            {EMAIL_TYPES.filter(t => effectiveState(t, u, emailsConfig).tone === 'on').length}/{EMAIL_TYPES.length}
                          </span>
                          <i className="ti ti-chevron-right" style={{ fontSize: 12, color: 'var(--text3)' }} />
                        </button>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button aria-label="Sign this account out on every device"
                        className="btn btn-xs" type="button" disabled={busy || u.activeSessions === 0}
                        title="Sign this account out on every device"
                        onClick={() => act(u, () => adminRevokeSessionsApi(u.id!), 'Sessions ended')}
                      ><i className="ti ti-logout" /></button>{' '}
                      {u.status === 'disabled' ? (
                        <button
                          className="btn btn-xs" type="button" disabled={busy}
                          onClick={() => act(u, () => adminUpdateUserApi(u.id!, { status: 'active' }), 'Account re-enabled')}
                        ><i className="ti ti-user-check" /> Enable</button>
                      ) : (
                        <button
                          className="btn btn-xs btn-danger" type="button"
                          // Self-disable is refused server-side too; hiding
                          // the button just avoids offering a dead action.
                          disabled={busy || isSelf}
                          title={isSelf ? 'You cannot disable your own account' : 'Disable: revoke access, keep their data'}
                          aria-label={`Disable ${u.email}`}
                          onClick={() => {
                            if (!window.confirm(`Disable ${u.email}? Their data is kept, but they are signed out everywhere and cannot sign back in.`)) return;
                            act(u, () => adminUpdateUserApi(u.id!, { status: 'disabled' }), 'Account disabled');
                          }}
                        ><i className="ti ti-user-off" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Refreshing>

      <div className="adm-resultline">
        Showing {rows.length} of {data.users.length} account{data.users.length === 1 ? '' : 's'}.
        {' '}Deleting an account is deliberately not possible here — it would have to cascade sixteen collections
        with no undo. Disable revokes access and keeps the data; <code>scripts/delete-account.js</code> is the offline path.
      </div>
    </>
  );
}
