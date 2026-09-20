import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import { useSession } from '../context/SessionContext';
import { fmtAgo } from '../lib/analytics';
import {
  adminOverviewApi, adminInviteApi, adminUpdateUserApi, adminRevokeSessionsApi,
  accessRequestsApi, approveAccessApi, rejectAccessApi, clearAccessRequestApi,
  type AdminOverview, type AdminUserRow, type AccessRequestRow,
} from '../lib/api';

const RANGES = [7, 30, 90];

const ago = (v: string | null) => (v ? fmtAgo(new Date(v).getTime()) : '—');

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

export default function Admin() {
  const toast = useToast();
  const { user } = useSession();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [notifyInvite, setNotifyInvite] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [reqFilter, setReqFilter] = useState<'pending' | 'all'>('pending');

  const load = useCallback(async (d: number) => {
    try {
      setData(await adminOverviewApi(d));
      setError('');
    } catch (e: any) {
      setError(e.message || 'Could not load');
    }
  }, []);

  const loadRequests = useCallback(async (f: 'pending' | 'all') => {
    try {
      setRequests((await accessRequestsApi(f)).requests);
    } catch { /* the overview tile still shows the count */ }
  }, []);

  useEffect(() => { load(days); }, [load, days]);
  useEffect(() => { loadRequests(reqFilter); }, [loadRequests, reqFilter]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const r = await adminInviteApi(email, { notify: notifyInvite });
      setInviteEmail('');
      toast(
        r.warning ? `${email} was added, but the email did not send — tell them yourself.`
          : r.emailed ? `${email} was added and emailed.`
          : `${email} was added. They have not been told.`,
        r.warning ? 'info' : 'success',
      );
      await load(days);
    } catch (err: any) {
      toast(err.message || 'Could not whitelist that address', 'error');
    } finally {
      setInviting(false);
    }
  };

  const act = async (row: AdminUserRow, fn: () => Promise<any>, done: string) => {
    if (!row.id) return;
    setBusyId(row.id);
    try {
      const r = await fn();
      toast(typeof r?.revoked === 'number' ? `${done} (${r.revoked} session(s) ended)` : done, 'success');
      await load(days);
    } catch (err: any) {
      toast(err.message || 'That did not work', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (row: AccessRequestRow, fn: () => Promise<any>, done: string) => {
    setBusyId(row.id);
    try {
      const r = await fn();
      // An approval whose email failed still granted access — say so, rather
      // than letting the admin assume the person was notified.
      toast(r?.warning ? `${done} — but the email did not send, so tell them yourself.` : done,
        r?.warning ? 'info' : 'success');
      await Promise.all([loadRequests(reqFilter), load(days)]);
    } catch (err: any) {
      toast(err.message || 'That did not work', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const tiles = data ? [
    { label: 'Accounts', value: data.totals.users, sub: `${data.totals.active} active · ${data.totals.invited} invited` },
    { label: 'Set up', value: data.totals.onboarded, sub: `${data.totals.withGmail} with Gmail connected`, cls: data.totals.onboarded < data.totals.users ? 'amber' : 'green' },
    { label: 'Contacts', value: data.totals.contacts, sub: `${data.totals.leads} leads` },
    { label: 'Emails sent', value: data.totals.everSent, sub: `${data.totals.campaigns} campaign(s)`, cls: 'green' },
    { label: 'Replies', value: data.totals.everReplied, sub: `${data.totals.replyRate}% reply rate` },
    { label: 'Live sessions', value: data.totals.activeSessions },
    ...(data.totals.pendingRequests > 0
      ? [{ label: 'Access requests', value: data.totals.pendingRequests, sub: 'waiting for you', cls: 'amber' }]
      : []),
  ] : [];

  return (
    <Layout
      title="Admin"
      subtitle="Every account, in aggregate. No one else's contacts or emails are shown here."
      wide
      actions={
        <div className="seg-toggle">
          {RANGES.map(d => (
            <button
              key={d} type="button" className={`btn btn-xs${days === d ? ' active' : ''}`}
              onClick={() => setDays(d)}
            >{d}d</button>
          ))}
        </div>
      }
    >
      <div className="section" style={{ flex: 1 }}>
        {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 120 }} />}

        {data && (
          <>
            {/* Only appears when it is actually true: the unique index on
                Settings.userId is gone and someone has two rows. */}
            {data.totals.duplicateSettings > 0 && (
              <div className="info-box danger" style={{ marginBottom: 14 }}>
                <strong>{data.totals.duplicateSettings} account(s) have duplicate settings documents.</strong>{' '}
                The unique index on <code>settings.userId</code> is missing — run{' '}
                <code>scripts/dedupe-settings.js</code>.
              </div>
            )}
            {data.unassigned && (
              <div className="info-box" style={{ borderColor: 'var(--amber)', marginBottom: 14 }}>
                <strong>Some documents belong to no account.</strong>{' '}
                {data.unassigned.contacts.total} contact(s), {data.unassigned.leads.total} lead(s).
                They predate the multi-tenant migration and are invisible to every user.
              </div>
            )}

            <div className="stat-grid">
              {tiles.map(t => (
                <div className="stat-card" key={t.label}>
                  <div className="stat-label">{t.label}</div>
                  <div className={`stat-value ${t.cls || ''}`}>{t.value}</div>
                  {t.sub && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{t.sub}</div>}
                </div>
              ))}
            </div>

            {/* Accounts ranked by volume. A bar list rather than a chart: at
                fifty accounts a fifty-column chart is unreadable, and this
                reuses a component class that already exists. */}
            <div className="an-card" style={{ marginTop: 16 }}>
              <div className="an-card-head">
                <div className="an-card-title"><i className="ti ti-chart-bar" /> Sending by account</div>
                <div className="an-card-sub">Emails ever sent. A trend, not an audit — a follow-up overwrites the send date it replaces.</div>
              </div>
              <div className="an-card-body">
                {(() => {
                  const max = Math.max(1, ...data.users.map(u => u.contacts.everSent));
                  const ranked = [...data.users].sort((a, b) => b.contacts.everSent - a.contacts.everSent);
                  if (!ranked.some(u => u.contacts.everSent > 0)) return <div className="an-empty">Nothing sent yet.</div>;
                  return ranked.map(u => (
                    <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <div style={{ width: 200, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                      <div className="progress-bar" style={{ flex: 1 }}>
                        <div className="progress-fill" style={{ width: `${(u.contacts.everSent / max) * 100}%` }} />
                      </div>
                      <div style={{ width: 90, textAlign: 'right', fontSize: 12, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
                        {u.contacts.everSent} sent
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>

            <div className="an-card" style={{ marginTop: 16 }}>
              <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div className="an-card-title">
                    <i className="ti ti-inbox" /> Access requests
                    {data.totals.pendingRequests > 0 && (
                      <span className="tab-badge" style={{ marginLeft: 6 }}>{data.totals.pendingRequests}</span>
                    )}
                  </div>
                  <div className="an-card-sub">
                    People who tried to sign in and weren't on the list. Approving one creates
                    their account and emails them; declining is final, and they are not emailed.
                  </div>
                </div>
                <div className="seg-toggle">
                  {(['pending', 'all'] as const).map(f => (
                    <button
                      key={f} type="button" className={`btn btn-xs${reqFilter === f ? ' active' : ''}`}
                      onClick={() => setReqFilter(f)}
                    >{f}</button>
                  ))}
                </div>
              </div>
              <div className="an-card-body">
                {requests.length === 0 ? (
                  <div className="an-empty">
                    {reqFilter === 'pending' ? 'Nothing waiting.' : 'No requests yet.'}
                  </div>
                ) : requests.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {r.email}
                        {r.name && <span style={{ color: 'var(--text2)', fontWeight: 400 }}> · {r.name}</span>}
                        {r.status !== 'pending' && (
                          <span className={`badge ${r.status === 'approved' ? 'badge-sent' : 'badge-rejected'}`} style={{ marginLeft: 6 }}>
                            {r.status}
                          </span>
                        )}
                        {r.requestCount > 1 && (
                          <span className="badge badge-pending" style={{ marginLeft: 6 }}>asked {r.requestCount}×</span>
                        )}
                      </div>
                      {/* Free text from a stranger. React escapes it; it is never
                          inserted as HTML anywhere. */}
                      {r.note && (
                        <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{r.note}</div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{ago(r.createdAt)}</div>
                    </div>
                    <div style={{ whiteSpace: 'nowrap' }}>
                      {r.status === 'pending' ? (
                        <>
                          <button
                            className="btn btn-xs btn-success" type="button" disabled={busyId === r.id}
                            onClick={() => decide(r, () => approveAccessApi(r.id), `${r.email} approved`)}
                          >Approve</button>{' '}
                          <button
                            className="btn btn-xs btn-danger" type="button" disabled={busyId === r.id}
                            onClick={() => {
                              if (!window.confirm(`Decline ${r.email}? They are told plainly, and asking again will not reopen it.`)) return;
                              decide(r, () => rejectAccessApi(r.id), `${r.email} declined`);
                            }}
                          >Decline</button>
                        </>
                      ) : (
                        <button
                          className="btn btn-xs" type="button" disabled={busyId === r.id}
                          title={r.status === 'rejected'
                            ? 'Remove this row. That address can then ask again.'
                            : 'Remove this row from the list.'}
                          onClick={() => decide(r, () => clearAccessRequestApi(r.id), 'Cleared')}
                        >Clear</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="an-card" style={{ marginTop: 16 }}>
              <div className="an-card-head">
                <div className="an-card-title"><i className="ti ti-user-plus" /> Whitelist an address</div>
                <div className="an-card-sub">That is the whole of account creation — they sign in with a code emailed to them. No password is ever issued.</div>
              </div>
              <div className="an-card-body">
                <form onSubmit={invite} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    className="login-input" type="email" required placeholder="person@example.com"
                    value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <button className="btn btn-primary" type="submit" disabled={inviting}>
                    {inviting ? <><i className="ti ti-loader" /> Adding…</> : <><i className="ti ti-plus" /> Whitelist</>}
                  </button>
                </form>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 12.5, color: 'var(--text2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={notifyInvite} onChange={e => setNotifyInvite(e.target.checked)} />
                  Email them to say their access is ready
                  <span style={{ color: 'var(--text3)' }}>
                    — otherwise they have no way of knowing the account exists.
                  </span>
                </label>
              </div>
            </div>

            <div className="table-card" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Account</th><th>Setup</th><th>Config</th>
                    <th style={{ textAlign: 'right' }}>Contacts</th>
                    <th style={{ textAlign: 'right' }}>Leads</th>
                    <th style={{ textAlign: 'right' }}>Campaigns</th>
                    <th style={{ textAlign: 'right' }}>Scrapes</th>
                    <th>Last seen</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.users.map(u => {
                    const isSelf = u.id === user?.id;
                    const busy = busyId === u.id;
                    return (
                      <tr key={u.id}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{u.email}</div>
                          <div style={{ display: 'flex', gap: 5, marginTop: 3 }}>
                            {u.isAdmin && <span className="badge badge-approved">admin</span>}
                            {u.status === 'invited' && <span className="badge badge-pending">never signed in</span>}
                            {u.status === 'disabled' && <span className="badge badge-rejected">disabled</span>}
                            {isSelf && <span className="badge">you</span>}
                          </div>
                        </td>
                        <td>
                          {u.onboarding.completedAt
                            ? <span className="badge badge-sent">done</span>
                            : <span className="badge badge-pending">step {u.onboarding.step + 1} of 3</span>}
                        </td>
                        <td><ConfigPills row={u} /></td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {u.contacts.total}
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{u.contacts.everSent} sent · {u.contacts.everReplied} replied</div>
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.leads.total}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.campaigns.total}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {u.scrapes.total}
                          {(u.scrapes.by.failed || 0) > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--red)' }}>{u.scrapes.by.failed} failed</div>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                          {ago(u.lastLoginAt)}
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{u.activeSessions} session(s)</div>
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
                            >Enable</button>
                          ) : (
                            <button
                              className="btn btn-xs btn-danger" type="button"
                              // Self-disable is refused server-side too; hiding
                              // the button just avoids offering a dead action.
                              disabled={busy || isSelf}
                              title={isSelf ? 'You cannot disable your own account' : 'Revoke access, keep their data'}
                              onClick={() => {
                                if (!window.confirm(`Disable ${u.email}? Their data is kept, but they are signed out everywhere and cannot sign back in.`)) return;
                                act(u, () => adminUpdateUserApi(u.id!, { status: 'disabled' }), 'Account disabled');
                              }}
                            >Disable</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 12 }}>
              Deleting an account is deliberately not possible here — it would have to
              cascade sixteen collections with no undo. Disable revokes access and keeps
              the data; <code>scripts/delete-account.js</code> is the offline path.
            </p>
          </>
        )}
      </div>
    </Layout>
  );
}
