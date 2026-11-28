// Admin → Email activity. Per account: what it has sent, how it went, and each
// send batch in the window. Counts, campaign names and sender only — never a
// recipient, subject or body.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshBar, Refreshing } from '../RefreshBar';
import Avatar from '../Avatar';
import { fmtAgo } from '../../lib/analytics';
import { adminSendingApi, type AdminUserRow, type SendingView, type SendingBatch } from '../../lib/api';

const RANGES = [7, 30];
const STATUS_BADGE: Record<SendingBatch['status'], string> = {
  done: 'badge-sent', processing: 'badge-queued', pending: 'badge-queued', paused: 'badge-pending', cancelled: 'badge-rejected',
};
const ago = (v: string | null | undefined) => (v ? fmtAgo(new Date(v).getTime()) : '—');
const when = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

export default function AdminMailActivity({ users, openDrawer }: { users: AdminUserRow[]; openDrawer: (id: string) => void }) {
  const [days, setDays] = useState(7);
  const [view, setView] = useState<SendingView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try { setView(await adminSendingApi(d)); setError(''); }
    catch (e: any) { setError(e.message || 'Could not load sending'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(days); }, [load, days]);

  const rows = useMemo(() => {
    const batches = new Map<string, SendingBatch[]>();
    for (const b of [...(view?.live || []), ...(view?.past || [])]) {
      if (!b.userId) continue;
      batches.set(b.userId, [...(batches.get(b.userId) || []), b]);
    }
    const today = new Map((view?.accounts || []).map(a => [a.userId, a]));
    const needle = q.trim().toLowerCase();
    return users
      .filter(u => u.id && (!needle || u.email.toLowerCase().includes(needle) || (u.name || '').toLowerCase().includes(needle)))
      .map(u => {
        const bs = (batches.get(u.id!) || []).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        return {
          u, batches: bs, today: today.get(u.id!) || null,
          win: bs.reduce((t, b) => ({ sent: t.sent + b.sent, failed: t.failed + b.failed, skipped: t.skipped + b.skipped }), { sent: 0, failed: 0, skipped: 0 }),
        };
      })
      .sort((a, b) => b.win.sent - a.win.sent || b.u.contacts.everSent - a.u.contacts.everSent);
  }, [users, view, q]);

  const tot = rows.reduce((t, r) => ({ sent: t.sent + r.win.sent, failed: t.failed + r.win.failed, batches: t.batches + r.batches.length }), { sent: 0, failed: 0, batches: 0 });

  return (
    <>
      <div className="adm-toolbar">
        <div className="adm-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input className="login-input" type="search" placeholder="Search email or name" aria-label="Search accounts"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="adm-toolbar-end">
          <span className="adm-resultline">
            {tot.sent.toLocaleString()} sent · {tot.failed.toLocaleString()} failed · {tot.batches} batch(es) in {days} days
          </span>
          <div className="seg-toggle" role="group" aria-label="Range">
            {RANGES.map(d => (
              <button key={d} type="button" className={`btn btn-xs${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
                {days === d && loading && view && <i className="ti ti-loader" aria-hidden="true" />}{d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
      {!view && !error && <div className="skeleton" style={{ height: 200 }} />}

      {view && (
        <>
          <RefreshBar active={loading} />
          <Refreshing active={loading}>
            <div className="table-card adm-table">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="adm-num">In {days} days</th>
                    <th className="adm-num">Today</th>
                    <th className="adm-num">All time</th>
                    <th>Last sent</th>
                    <th><span className="adm-vh">Expand</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={6}><div className="an-empty"><i className="ti ti-mail-off" />No accounts match.</div></td></tr>
                  )}
                  {rows.map(({ u, batches, today, win }) => {
                    const isOpen = open === u.id;
                    const rate = u.contacts.everSent ? Math.round((u.contacts.everReplied / u.contacts.everSent) * 1000) / 10 : 0;
                    return (
                      <Fragment key={u.id}>
                        <tr className="tr-clickable" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : u.id)}>
                          <td>
                            <div className="adm-acct">
                              <Avatar name={u.name || u.email} />
                              <div style={{ minWidth: 0 }}>
                                <div className="adm-acct-name">{u.email}</div>
                                <div className="adm-sub">{batches.length} batch(es) · {u.campaigns.total} campaign(s)</div>
                              </div>
                            </div>
                          </td>
                          <td className="adm-num">
                            <b>{win.sent.toLocaleString()}</b> sent
                            {win.failed > 0 && <div style={{ fontSize: 11, color: 'var(--red)' }}>{win.failed} failed</div>}
                            {win.skipped > 0 && <div className="adm-sub">{win.skipped} skipped</div>}
                          </td>
                          <td className="adm-num">
                            {today ? <>{today.sentToday}<span className="adm-sub"> / {today.cap}</span></> : <span className="adm-sub">0</span>}
                            {today && today.failedToday > 0 && <div style={{ fontSize: 11, color: 'var(--red)' }}>{today.failedToday} failed</div>}
                          </td>
                          <td className="adm-num">
                            {u.contacts.everSent.toLocaleString()}
                            <div className="adm-sub">{u.contacts.everReplied} replied · {rate}%</div>
                            <div className="adm-sub">{u.contacts.everFollowedUp} follow-up(s)</div>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{ago(u.contacts.lastSentAt)}</td>
                          <td style={{ textAlign: 'right' }}><i className={`ti ti-chevron-${isOpen ? 'up' : 'down'}`} style={{ color: 'var(--text3)' }} /></td>
                        </tr>
                        {isOpen && (
                          <tr className="adm-expand">
                            <td colSpan={6}>
                              <div className="adm-expand-head">
                                <strong>Send batches in the last {days} days</strong>
                                <span style={{ display: 'flex', gap: 6 }}>
                                  <Link className="btn btn-xs" to={`/analytics?user=${u.id}`}><i className="ti ti-chart-line" /> Full report</Link>
                                  <button type="button" className="btn btn-xs" onClick={() => openDrawer(u.id!)}><i className="ti ti-user-cog" /> Account details</button>
                                </span>
                              </div>
                              {today?.topError && (
                                <div className="info-box danger" style={{ margin: '8px 0' }}>
                                  <strong>Most common error today:</strong> {today.topError}
                                </div>
                              )}
                              {batches.length === 0 ? (
                                <div className="adm-sub" style={{ padding: '8px 0' }}>No send batches in this window.</div>
                              ) : (
                                <table className="adm-subtable">
                                  <thead>
                                    <tr><th>Campaign</th><th>Status</th><th className="adm-num">Sent</th><th className="adm-num">Failed</th><th className="adm-num">Skipped</th><th className="adm-num">Left</th><th>Started</th><th>Last send</th></tr>
                                  </thead>
                                  <tbody>
                                    {batches.map(b => (
                                      <Fragment key={b.id}>
                                        <tr>
                                          <td>
                                            {b.campaignName || <span className="adm-sub">Direct send</span>}
                                            <div className="adm-sub">from {b.senderEmail} · {b.sendMode}</div>
                                          </td>
                                          <td>
                                            <span className={`badge ${STATUS_BADGE[b.status]}`}>{b.status}</span>
                                            {b.stalled && <span className="badge badge-rejected" style={{ marginLeft: 4 }}>stalled</span>}
                                          </td>
                                          <td className="adm-num">{b.sent}<span className="adm-sub"> / {b.total}</span></td>
                                          <td className="adm-num" style={{ color: b.failed ? 'var(--red)' : undefined }}>{b.failed}</td>
                                          <td className="adm-num">{b.skipped}</td>
                                          <td className="adm-num">{b.pending}</td>
                                          <td style={{ whiteSpace: 'nowrap' }}>{when(b.createdAt)}</td>
                                          <td style={{ whiteSpace: 'nowrap' }}>{when(b.lastAt)}</td>
                                        </tr>
                                        {b.topError && (
                                          <tr><td colSpan={8} className="adm-suberr"><i className="ti ti-alert-circle" /> {b.topError}{b.topErrorCount > 1 ? ` (×${b.topErrorCount})` : ''}</td></tr>
                                        )}
                                      </Fragment>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Refreshing>
          <div className="adm-resultline">
            Counts, campaign names and the sending address only — recipients, subjects and bodies are never shown here.
            "All time" comes from each contact's latest send, so a follow-up replaces the send it followed.
          </div>
        </>
      )}
    </>
  );
}
