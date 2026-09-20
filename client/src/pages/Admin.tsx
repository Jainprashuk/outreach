import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import { useSession } from '../context/SessionContext';
import { fmtAgo } from '../lib/analytics';
import {
  adminOverviewApi, adminInviteApi, adminUpdateUserApi, adminRevokeSessionsApi,
  type AdminOverview, type AdminUserRow,
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
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    try {
      setData(await adminOverviewApi(d));
      setError('');
    } catch (e: any) {
      setError(e.message || 'Could not load');
    }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      await adminInviteApi(email);
      setInviteEmail('');
      toast(`${email} can now sign in — they'll get a code by email.`, 'success');
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

  const tiles = data ? [
    { label: 'Accounts', value: data.totals.users, sub: `${data.totals.active} active · ${data.totals.invited} invited` },
    { label: 'Set up', value: data.totals.onboarded, sub: `${data.totals.withGmail} with Gmail connected`, cls: data.totals.onboarded < data.totals.users ? 'amber' : 'green' },
    { label: 'Contacts', value: data.totals.contacts, sub: `${data.totals.leads} leads` },
    { label: 'Emails sent', value: data.totals.everSent, sub: `${data.totals.campaigns} campaign(s)`, cls: 'green' },
    { label: 'Replies', value: data.totals.everReplied, sub: `${data.totals.replyRate}% reply rate` },
    { label: 'Live sessions', value: data.totals.activeSessions },
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
              <div className="info-box" style={{ borderColor: 'var(--red)', marginBottom: 14 }}>
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
                          <button
                            className="btn btn-xs" type="button" disabled={busy || u.activeSessions === 0}
                            title="Sign this account out on every device"
                            onClick={() => act(u, () => adminRevokeSessionsApi(u.id!), 'Sessions ended')}
                          >
                            <i className="ti ti-logout" />
                          </button>{' '}
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
