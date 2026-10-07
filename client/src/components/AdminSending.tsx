import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtAgo } from '../lib/analytics';
import { RefreshBar, Refreshing } from './RefreshBar';
import SendingTimeline from './campaigns/SendingTimeline';
import {
  adminSendingApi, adminSendingTimelineApi,
  type SendingView, type SendingBatch, type SendingAlert,
} from '../lib/api';

const AUTO_REFRESH_MS = 30_000;
const IST = { timeZone: 'Asia/Kolkata' } as const;

const ago = (v: string | null) => (v ? fmtAgo(new Date(v).getTime()) : '—');
const when = (v: string | null) => (v
  ? new Date(v).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
  : '—');
const mins = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const until = (v: string | null) => {
  if (!v) return '—';
  const ms = new Date(v).getTime() - Date.now();
  return ms <= 0 ? 'now' : `in ${mins(ms)}`;
};
const duration = (a: string | null, b: string | null) => (a && b ? mins(new Date(b).getTime() - new Date(a).getTime()) : '—');

const LEVEL: Record<SendingAlert['level'], { icon: string; color: string; label: string }> = {
  critical: { icon: 'ti-alert-octagon', color: 'var(--red)', label: 'Critical' },
  warning: { icon: 'ti-alert-triangle', color: 'var(--amber)', label: 'Warning' },
  info: { icon: 'ti-info-circle', color: 'var(--text2)', label: 'Note' },
};

/** Sent · failed · skipped · still queued, as one segmented bar with a 2px gap between segments. */
function BatchBar({ b }: { b: Pick<SendingBatch, 'sent' | 'failed' | 'skipped' | 'pending' | 'total'> }) {
  const segs = [
    { n: b.sent, color: 'var(--green)', label: 'sent' },
    { n: b.failed, color: 'var(--red)', label: 'failed' },
    { n: b.skipped, color: 'var(--amber)', label: 'skipped' },
    { n: b.pending, color: 'var(--border-md)', label: 'queued' },
  ].filter(s => s.n > 0);
  const total = Math.max(1, b.total);
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ display: 'flex', gap: 2, height: 7, borderRadius: 4, overflow: 'hidden', background: 'var(--bg3)' }}
        title={segs.map(s => `${s.n} ${s.label}`).join(' · ')}>
        {segs.map(s => <div key={s.label} style={{ width: `${(s.n / total) * 100}%`, background: s.color }} />)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
        {b.sent} sent
        {b.failed > 0 && <span style={{ color: 'var(--red)' }}> · {b.failed} failed</span>}
        {b.skipped > 0 && <> · {b.skipped} skipped</>}
        {b.pending > 0 && <> · {b.pending} queued</>}
        <span style={{ color: 'var(--text3)' }}> of {b.total}</span>
      </div>
    </div>
  );
}

const source = (b: SendingBatch) => (b.campaignName
  ? <><i className="ti ti-speakerphone" style={{ color: 'var(--text3)' }} /> {b.campaignName}</>
  : <><i className="ti ti-send" style={{ color: 'var(--text3)' }} /> Send wizard</>);

const mode = (b: SendingBatch) => (b.sendMode === 'drip' ? `drip · ${b.ratePerHour}/h` : b.sendMode);

function Card({ icon, title, sub, children, right }: { icon: string; title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="an-card" style={{ marginTop: 16 }}>
      <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="an-card-title"><i className={`ti ${icon}`} /> {title}</div>
          {sub && <div className="an-card-sub">{sub}</div>}
        </div>
        {right}
      </div>
      <div className="an-card-body">{children}</div>
    </div>
  );
}

type TileKey = 'sending' | 'stuck' | 'sentToday' | 'scheduled' | 'paused' | 'past';
interface WhoRow { userId: string; email: string; n: number; detail: string; alert?: boolean }

/** Group rows by account; `n` decides the order, `detail` is what the row says. */
function byAccount<T extends { userId: string | null; userEmail: string }>(
  rows: T[], n: (rs: T[]) => number, detail: (rs: T[]) => string, alert?: (rs: T[]) => boolean,
): WhoRow[] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.userId || '';
    m.set(k, [...(m.get(k) || []), r]);
  }
  return [...m].map(([userId, rs]) => ({ userId, email: rs[0].userEmail, n: n(rs), detail: detail(rs), alert: alert?.(rs) }))
    .sort((a, b) => b.n - a.n);
}
const sumOf = <T,>(rs: T[], f: (r: T) => number) => rs.reduce((n, r) => n + f(r), 0);
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : /(s|sh|ch|x)$/.test(w) ? `${w}es` : `${w}s`}`;

/** "a@x.com, b@y.com +3 more" — who is behind a tile, readable without clicking. */
function WhoLine({ rows }: { rows: WhoRow[] }) {
  if (!rows.length) return null;
  const shown = rows.slice(0, 2);
  return (
    <div style={{ fontSize: 11.5, color: 'var(--text2)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={rows.map(r => r.email).join('\n')}>
      <i className="ti ti-users" style={{ color: 'var(--text3)' }} /> {shown.map(r => r.email.split('@')[0]).join(', ')}
      {rows.length > 2 && <span style={{ color: 'var(--text3)' }}> +{rows.length - 2} more</span>}
    </div>
  );
}

export default function AdminSending({ onAlertCount }: { onAlertCount?: (n: number) => void }) {
  const [data, setData] = useState<SendingView | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  // One account filter for the whole tab, set from the dropdown or from a tile's breakdown.
  const [account, setAccount] = useState('');
  const [openTile, setOpenTile] = useState<TileKey | null>(null);
  const [pastOnlyFailed, setPastOnlyFailed] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const d = await adminSendingApi(days);
      setData(d);
      setError('');
      setLoadedAt(Date.now());
      onAlertCount?.(d.alerts.filter(a => a.level === 'critical').length);
    } catch (e: any) {
      if (!quiet) setError(e.message || 'Could not load');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [days, onAlertCount]);
  useEffect(() => { load(); }, [load]);

  // Live view: refresh while the tab is visible, never in the background — an
  // idle open tab must not become a polling cost (see the Vercel CPU work).
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, load]);

  const mine = <T extends { userId: string | null }>(rows: T[]) => (account ? rows.filter(r => r.userId === account) : rows);
  const live = useMemo(() => mine(data?.live || []), [data, account]);
  const upcoming = useMemo(() => mine(data?.upcoming || []), [data, account]);
  const accounts = useMemo(() => mine(data?.accounts || []), [data, account]);
  const past = useMemo(() => mine(data?.past || []).filter(b => !pastOnlyFailed || b.failed > 0), [data, account, pastOnlyFailed]);
  // Everyone who appears anywhere on the tab, for the account filter.
  const everyone = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...(data?.live || []), ...(data?.past || []), ...(data?.upcoming || []), ...(data?.accounts || [])]) {
      if (r.userId) m.set(r.userId, r.userEmail);
    }
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  if (error && !data) {
    return (
      <div className="login-error" style={{ textAlign: 'left' }}>
        {error} <button className="btn btn-xs" type="button" onClick={() => load()}>Try again</button>
      </div>
    );
  }
  if (!data) return <div className="skeleton" style={{ height: 160 }} />;

  // Every tile is computed from the same rows the tables show, so a number and
  // the accounts listed behind it can never disagree.
  const sending = live.filter(b => b.status !== 'paused');
  const stuck = live.filter(b => b.stalled);
  const paused = live.filter(b => b.status === 'paused');
  const istDay = (v: string | number) => new Date(new Date(v).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const today = istDay(Date.now());
  const dueToday = upcoming.filter(u => u.dueNow || istDay(u.nextAt) === today);
  const allPast = mine(data.past);
  const pastSent = sumOf(allPast, b => b.sent);
  const pastFailed = sumOf(allPast, b => b.failed);
  const failPct = (f: number, s2: number) => (f + s2 ? Math.round((f / (f + s2)) * 100) : 0);

  const tiles: Array<{ key: TileKey; label: string; value: number; sub: string; cls?: string; who: WhoRow[]; empty: string }> = [
    {
      key: 'sending', label: 'Sending now', value: sending.length, cls: sending.length ? 'green' : '',
      sub: `${sumOf(sending, b => b.pending)} email(s) queued`, empty: 'Nobody is sending right now.',
      who: byAccount(sending, rs => sumOf(rs, b => b.pending),
        rs => `${plural(rs.length, 'batch')} · ${sumOf(rs, b => b.sent)} sent · ${sumOf(rs, b => b.pending)} queued`,
        rs => rs.some(b => b.stalled)),
    },
    {
      key: 'stuck', label: 'Stuck batches', value: stuck.length, cls: stuck.length ? 'red' : 'green',
      sub: 'nothing sent for too long', empty: 'No batch is stuck.',
      who: byAccount(stuck, rs => Math.max(...rs.map(b => b.idleMs)),
        rs => `${plural(rs.length, 'batch')} · ${sumOf(rs, b => b.pending)} queued · idle up to ${mins(Math.max(...rs.map(b => b.idleMs)))}`
          + (rs.find(b => b.topError) ? ` · ${rs.find(b => b.topError)!.topError!.slice(0, 60)}` : ''),
        () => true),
    },
    {
      key: 'sentToday', label: 'Sent today', value: sumOf(accounts, a => a.sentToday),
      cls: sumOf(accounts, a => a.failedToday) ? 'amber' : '',
      sub: `${sumOf(accounts, a => a.failedToday)} failed · ${accounts.length} account(s)`, empty: 'Nothing sent today.',
      who: accounts.filter(a => a.sentToday || a.failedToday).map(a => ({
        userId: a.userId, email: a.userEmail, n: a.sentToday,
        detail: `${a.sentToday} sent · ${a.failedToday} failed (${a.failRate}%) · ${a.usedPct}% of cap${a.topError && a.failedToday ? ` · ${a.topError.slice(0, 60)}` : ''}`,
        alert: a.failRate >= 50 && a.failedToday >= 5,
      })).sort((x, y) => y.n - x.n),
    },
    {
      key: 'scheduled', label: 'Scheduled today', value: sumOf(dueToday, u => u.batch),
      sub: 'from campaign releases', empty: 'No campaign release is due today.',
      who: byAccount(dueToday, rs => sumOf(rs, u => u.batch),
        rs => `${plural(rs.length, 'campaign')} (${rs.map(u => u.name).join(', ').slice(0, 60)}) · ${sumOf(rs, u => u.batch)} emails`
          + (rs.some(u => u.dueNow) ? ' · due now' : ''),
        rs => rs.some(u => u.overdueMs > 2 * 3_600_000)),
    },
    {
      key: 'paused', label: 'Paused', value: paused.length, cls: paused.length ? 'amber' : '',
      sub: 'batches waiting on a person', empty: 'Nothing is paused.',
      who: byAccount(paused, rs => sumOf(rs, b => b.pending),
        rs => `${plural(rs.length, 'batch')} · ${sumOf(rs, b => b.pending)} unsent · paused since ${ago(rs.map(b => b.updatedAt).sort()[0])}`),
    },
    {
      key: 'past', label: `Last ${data.days} day(s)`, value: allPast.length,
      sub: `batches · ${failPct(pastFailed, pastSent)}% failed`,
      cls: failPct(pastFailed, pastSent) > 10 ? 'red' : '', empty: 'No finished batches in this window.',
      who: byAccount(allPast, rs => rs.length,
        rs => `${plural(rs.length, 'batch')} · ${sumOf(rs, b => b.sent)} sent · ${sumOf(rs, b => b.failed)} failed (${failPct(sumOf(rs, b => b.failed), sumOf(rs, b => b.sent))}%)`,
        rs => failPct(sumOf(rs, b => b.failed), sumOf(rs, b => b.sent)) >= 50),
    },
  ];
  const open = tiles.find(x => x.key === openTile) || null;
  // Scheduler alerts carry no account: they concern everyone, so they stay.
  const alerts = account ? data.alerts.filter(a => !a.userId || a.userId === account) : data.alerts;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: 'var(--text2)' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          Live — refresh every 30s while this tab is open
        </label>
        <span style={{ color: 'var(--text3)' }}>Updated {loadedAt ? fmtAgo(loadedAt) : '—'}</span>
        <button className="btn btn-xs" type="button" onClick={() => load()} disabled={loading} title="Refresh now">
          <i className={`ti ${loading ? 'ti-loader' : 'ti-refresh'}`} />
        </button>
        <span style={{ flex: 1 }} />
        <select value={account} onChange={e => setAccount(e.target.value)} aria-label="Account" style={{ width: 'auto' }}>
          <option value="">Every account</option>
          {everyone.map(([idv, email]) => <option key={idv} value={idv}>{email}</option>)}
        </select>
      </div>
      {account && (
        <div className="info-box" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-filter" /> Showing only <strong>{everyone.find(([idv]) => idv === account)?.[1] || 'this account'}</strong>
          <button className="btn btn-xs" type="button" onClick={() => setAccount('')}>Show everyone</button>
        </div>
      )}

      {error && <div className="login-error" style={{ textAlign: 'left' }}>Could not refresh: {error}. Showing the last good data.</div>}
      <RefreshBar active={loading} />
      <Refreshing active={loading}>
        <div className="stat-grid">
          {tiles.map(x => (
            <button
              type="button" className="stat-card" key={x.key} aria-expanded={openTile === x.key}
              title="Show which accounts"
              onClick={() => setOpenTile(openTile === x.key ? null : x.key)}
              style={{ textAlign: 'left', cursor: 'pointer', minWidth: 0, outline: openTile === x.key ? '2px solid var(--accent)' : undefined }}
            >
              <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                {x.label}
                <i className={`ti ti-chevron-${openTile === x.key ? 'up' : 'down'}`} style={{ color: 'var(--text3)' }} />
              </div>
              <div className={`stat-value ${x.cls || ''}`}>{x.value}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{x.sub}</div>
              <WhoLine rows={x.who} />
            </button>
          ))}
        </div>

        {open && (
          <Card icon="ti-users" title={`${open.label} — by account`}
            sub="Click an account to filter the whole tab to it."
            right={<button className="btn btn-xs" type="button" onClick={() => setOpenTile(null)} aria-label="Close"><i className="ti ti-x" /></button>}>
            {open.who.length === 0 ? <div className="an-empty">{open.empty}</div> : open.who.map(w => (
              <div key={w.userId} style={{ display: 'flex', alignItems: 'center', gap: '6px 10px', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                {w.alert && <i className="ti ti-alert-octagon" style={{ color: 'var(--red)' }} title="Needs attention" />}
                <button type="button" className="btn btn-xs" onClick={() => { setAccount(w.userId); setOpenTile(null); }}
                  title="Filter the tab to this account" style={{ fontWeight: 500 }}>{w.email}</button>
                <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 12.5, color: 'var(--text2)' }}>{w.detail}</div>
              </div>
            ))}
          </Card>
        )}

        <Card icon="ti-urgent" title="Needs attention"
          sub="Worked out from the numbers below: stuck batches, accounts failing or near the Gmail cap, overdue campaign releases, a scheduler that is not firing.">
          {alerts.length === 0 ? (
            <div className="an-empty"><i className="ti ti-circle-check" />Everything is sending as expected.</div>
          ) : alerts.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <i className={`ti ${LEVEL[a.level].icon}`} style={{ color: LEVEL[a.level].color, fontSize: 16, marginTop: 1 }} />
              <div style={{ flex: 1, fontSize: 12.5 }}>
                <strong style={{ marginRight: 6 }}>{LEVEL[a.level].label}</strong>
                <span className="badge" style={{ marginRight: 6 }}>{a.area}</span>
                {a.text}
              </div>
            </div>
          ))}
        </Card>

        <Card icon="ti-player-play" title="Running now"
          sub="Every batch that has not finished, across all accounts. A batch is marked stuck when nothing has gone out for longer than its own pace allows.">
          {live.length === 0 ? <div className="an-empty">Nothing is sending right now.</div> : (
            <div className="table-card" style={{ boxShadow: 'none' }}>
              <table>
                <thead>
                  <tr><th>Account</th><th>Batch</th><th>Progress</th><th>State</th><th>Last send</th><th>Finishes</th></tr>
                </thead>
                <tbody>
                  {live.map(b => (
                    <tr key={b.id}>
                      <td style={{ fontSize: 12.5 }}>
                        {b.userEmail}
                        {b.senderEmail && b.senderEmail !== b.userEmail && (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>via {b.senderEmail}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {source(b)}
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{mode(b)} · started {ago(b.createdAt)}</div>
                      </td>
                      <td><BatchBar b={b} /></td>
                      <td>
                        {b.stalled ? <span className="badge badge-rejected"><i className="ti ti-alert-octagon" /> stuck {mins(b.idleMs)}</span>
                          : b.status === 'paused' ? <span className="badge badge-pending"><i className="ti ti-player-pause" /> paused {ago(b.updatedAt)}</span>
                          : b.status === 'pending' ? <span className="badge">waiting to start</span>
                          : <span className="badge badge-sent"><i className="ti ti-player-play" /> sending</span>}
                        {b.topError && (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 3, maxWidth: 260 }} title={b.topError}>
                            {b.topErrorCount}× {b.topError.slice(0, 80)}{b.topError.length > 80 ? '…' : ''}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{ago(b.lastAt)}</td>
                      <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                        {b.status === 'paused' ? '—' : b.stalled ? <span style={{ color: 'var(--red)' }}>behind schedule</span> : <>{until(b.etaAt)}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{when(b.etaAt)}</div></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card icon="ti-calendar-time" title="Coming up"
          sub="Running campaigns and their next daily release (IST). A release becomes due at its hour, then goes out on the next scheduler run — which GitHub does not run on time.">
          {upcoming.length === 0 ? <div className="an-empty">No campaign has anything left to release.</div> : (
            <div className="table-card" style={{ boxShadow: 'none' }}>
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th><th>Account</th><th>Next release</th>
                    <th style={{ textAlign: 'right' }}>Batch</th><th style={{ textAlign: 'right' }}>Left</th><th>Last release</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map(u => (
                    <tr key={u.campaignId}>
                      <td style={{ fontSize: 12.5, fontWeight: 500 }}>
                        {u.name}
                        {u.lastError && <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 400 }} title={u.lastError}>Last error: {u.lastError.slice(0, 80)}</div>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{u.userEmail}</td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {u.dueNow
                          ? <span className={`badge ${u.overdueMs > 2 * 3_600_000 ? 'badge-rejected' : 'badge-pending'}`}>due {mins(u.overdueMs)} ago</span>
                          : <>{when(u.nextAt)}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{until(u.nextAt)}</div></>}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                        {u.batch}
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{u.ratePerHour}/h · ~{u.batchHours} h</div>
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                        {u.pending}
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>~{u.daysLeft} day(s)</div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{ago(u.lastReleaseAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card icon="ti-chart-bar" title="Sent and scheduled, all accounts"
          sub="What went out and what is lined up, every account on one timeline. No cap line here — the cap is per Gmail account, shown below.">
          <SendingTimeline load={adminSendingTimelineApi} />
        </Card>

        <Card icon="ti-gauge" title="Gmail load today"
          sub={`Per account, against the ${data.dailyCap}/day cap. Queued emails count, since they will go out today.`}>
          {accounts.length === 0 ? <div className="an-empty">No account has sent or queued anything today.</div> : (
            accounts.map(a => {
              const sentPct = Math.min(100, (a.sentToday / a.cap) * 100);
              const queuedPct = Math.min(100 - sentPct, (a.inFlight / a.cap) * 100);
              const color = a.usedPct >= 100 ? 'var(--red)' : a.usedPct >= 80 ? 'var(--amber)' : 'var(--green)';
              return (
                <div key={a.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 210, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.userEmail}>{a.userEmail}</div>
                  <div style={{ flex: 1, display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--bg3)' }}
                    title={`${a.sentToday} sent · ${a.inFlight} queued · cap ${a.cap}`}>
                    <div style={{ width: `${sentPct}%`, background: color }} />
                    <div style={{ width: `${queuedPct}%`, background: color, opacity: 0.35 }} />
                  </div>
                  <div style={{ width: 190, textAlign: 'right', fontSize: 12, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
                    {a.sentToday} sent + {a.inFlight} queued · <strong style={{ color: 'var(--text)' }}>{a.usedPct}%</strong>
                    {a.failedToday > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--red)' }} title={a.topError || ''}>{a.failedToday} failed ({a.failRate}%)</div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </Card>

        <Card icon="ti-clock-play" title="Scheduler"
          sub="The GitHub cron jobs that drive mailbox checks and campaign releases, as they actually fire. Recorded from when this tab was added.">
          <div className="table-card" style={{ boxShadow: 'none' }}>
            <table>
              <thead>
                <tr><th>Job</th><th>Asked for</th><th>Last run</th><th style={{ textAlign: 'right' }}>Runs (24h)</th><th>Typical gap</th><th>Last result</th></tr>
              </thead>
              <tbody>
                {data.crons.map(c => {
                  const slow = c.runs24h < c.expected24h / 2;
                  return (
                    <tr key={c.name}>
                      <td style={{ fontSize: 12.5, fontWeight: 500 }}>{c.label}<div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}><code>{c.name}</code></div></td>
                      <td style={{ fontSize: 12 }}>every {c.everyMin < 60 ? `${c.everyMin} min` : `${c.everyMin / 60} h`}</td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{c.lastAt ? ago(c.lastAt) : 'not seen yet'}</td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: slow ? 'var(--amber)' : undefined }}>
                        {c.runs24h} <span style={{ color: 'var(--text3)' }}>/ {c.expected24h}</span>
                      </td>
                      <td style={{ fontSize: 12 }}>{c.medianGapMin == null ? '—' : c.medianGapMin < 60 ? `${c.medianGapMin} min` : `${(c.medianGapMin / 60).toFixed(1)} h`}</td>
                      <td style={{ fontSize: 12 }}>
                        {c.lastStatus == null ? '—' : c.lastStatus < 400
                          ? <span className="badge badge-sent">HTTP {c.lastStatus}</span>
                          : <span className="badge badge-rejected">HTTP {c.lastStatus}</span>}
                        {c.lastMs != null && <span style={{ color: 'var(--text3)', marginLeft: 6 }}>{(c.lastMs / 1000).toFixed(1)}s</span>}
                        {c.lastSummary && (
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                            {Object.entries(c.lastSummary).map(([k, v]) => `${k} ${v}`).join(' · ')}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card icon="ti-history" title="Past batches"
          sub="Finished or cancelled batches, newest first. Failure text is the most common reason in that batch."
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="seg-toggle">
                {[1, 7, 30].map(d => (
                  <button key={d} type="button" className={`btn btn-xs${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>{d}d</button>
                ))}
              </div>
              <label style={{ fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={pastOnlyFailed} onChange={e => setPastOnlyFailed(e.target.checked)} /> With failures
              </label>
            </div>
          }>
          {past.length === 0 ? <div className="an-empty">No finished batches in this window.</div> : (
            <div className="table-card" style={{ boxShadow: 'none' }}>
              <table>
                <thead>
                  <tr><th>Account</th><th>Batch</th><th>Result</th><th>Ran</th><th>Took</th><th>Ended</th></tr>
                </thead>
                <tbody>
                  {past.map(b => (
                    <tr key={b.id}>
                      <td style={{ fontSize: 12.5 }}>{b.userEmail}</td>
                      <td style={{ fontSize: 12.5 }}>{source(b)}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{mode(b)}</div></td>
                      <td>
                        <BatchBar b={b} />
                        {b.topError && (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2, maxWidth: 300 }} title={b.topError}>
                            {b.topErrorCount}× {b.topError.slice(0, 90)}{b.topError.length > 90 ? '…' : ''}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{when(b.firstAt || b.createdAt)}</td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{duration(b.firstAt, b.lastAt)}</td>
                      <td>
                        {b.status === 'cancelled'
                          ? <span className="badge badge-rejected">cancelled</span>
                          : <span className="badge badge-sent">done</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.past.length >= 300 && (
            <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 8 }}>Showing the 300 most recent. Pick a shorter window to see the rest.</p>
          )}
        </Card>
      </Refreshing>
    </>
  );
}
