// Admin → Overview. What needs the admin first, then the fleet in numbers.
// Every row here leads somewhere: a section, a filtered account list, or one
// account's drawer.
import { useState, type ReactNode } from 'react';
import { RefreshBar, Refreshing } from '../RefreshBar';
import AdminSendChart from './AdminSendChart';
import { fmtAgo } from '../../lib/analytics';
import type { AdminOverview, SendingAlert } from '../../lib/api';
import type { AccountFilter } from './AdminAccountsPanel';

type Sec = 'overview' | 'accounts' | 'requests' | 'mail' | 'sending' | 'platform-runs' | 'emails' | 'issues' | 'ai' | 'server-logs' | 'perf';
const RANGES = [7, 30, 90];
const TOP = 8;

interface Attn { tone: 'bad' | 'warn' | 'info'; icon: string; text: ReactNode; sub?: ReactNode; action?: { label: string; run: () => void } }

export default function AdminOverviewPanel({ data, days, setDays, loading, openIssues, sendAlerts, go, goAccounts, openDrawer }: {
  data: AdminOverview;
  days: number;
  setDays: (d: number) => void;
  loading: boolean;
  openIssues: number | null;
  sendAlerts: SendingAlert[];
  go: (s: Sec) => void;
  goAccounts: (f: AccountFilter) => void;
  openDrawer: (id: string) => void;
}) {
  const [allSenders, setAllSenders] = useState(false);
  const t = data.totals;
  const neverSignedIn = data.users.filter(u => u.status === 'invited').length;
  const setupIncomplete = data.users.filter(u => u.status === 'active' && !u.onboarding.completedAt).length;

  const attn: Attn[] = [];
  if (t.duplicateSettings > 0) attn.push({
    tone: 'bad', icon: 'ti-database-exclamation',
    // Only appears when it is actually true: the unique index on
    // Settings.userId is gone and someone has two rows.
    text: <><strong>{t.duplicateSettings} account(s) have duplicate settings documents.</strong></>,
    sub: <>The unique index on <code>settings.userId</code> is missing — run <code>scripts/dedupe-settings.js</code>.</>,
  });
  for (const a of sendAlerts.filter(a => a.level === 'critical')) attn.push({
    tone: 'bad', icon: 'ti-alert-octagon', text: <><strong>Sending:</strong> {a.text}</>,
    action: { label: 'Open Sending', run: () => go('sending') },
  });
  if (openIssues) attn.push({
    tone: 'bad', icon: 'ti-bug', text: <><strong>{openIssues} open issue{openIssues === 1 ? '' : 's'}</strong></>,
    sub: 'Failures someone hit, with the raw error.',
    action: { label: 'Review', run: () => go('issues') },
  });
  if (t.pendingRequests > 0) attn.push({
    tone: 'warn', icon: 'ti-user-question',
    text: <><strong>{t.pendingRequests} {t.pendingRequests === 1 ? 'person is' : 'people are'} asking for access</strong></>,
    action: { label: 'Review', run: () => go('requests') },
  });
  for (const a of sendAlerts.filter(a => a.level === 'warning').slice(0, 3)) attn.push({
    tone: 'warn', icon: 'ti-alert-triangle', text: <><strong>Sending:</strong> {a.text}</>,
    action: { label: 'Open Sending', run: () => go('sending') },
  });
  if (data.unassigned) attn.push({
    tone: 'warn', icon: 'ti-folder-question',
    text: <><strong>Some documents belong to no account.</strong></>,
    sub: <>{data.unassigned.contacts.total} contact(s), {data.unassigned.leads.total} lead(s). They predate the multi-tenant migration and are invisible to every user.</>,
  });
  if (neverSignedIn > 0) attn.push({
    tone: 'info', icon: 'ti-mail-forward', text: <><strong>{neverSignedIn} invited account{neverSignedIn === 1 ? ' has' : 's have'} never signed in</strong></>,
    action: { label: 'Show', run: () => goAccounts('invited') },
  });
  if (setupIncomplete > 0) attn.push({
    tone: 'info', icon: 'ti-progress', text: <><strong>{setupIncomplete} account{setupIncomplete === 1 ? ' has' : 's have'} not finished setup</strong></>,
    action: { label: 'Show', run: () => goAccounts('setup') },
  });

  const kpis: Array<{ icon: string; label: string; value: ReactNode; sub?: string; run?: () => void }> = [
    { icon: 'ti-users', label: 'Accounts', value: t.users, sub: `${t.active} active · ${t.invited} invited`, run: () => goAccounts('all') },
    { icon: 'ti-checklist', label: 'Set up', value: t.onboarded, sub: `${t.withGmail} with Gmail connected`, run: () => goAccounts('onboarded') },
    { icon: 'ti-address-book', label: 'Contacts', value: t.contacts.toLocaleString(), sub: `${t.leads.toLocaleString()} leads` },
    { icon: 'ti-send', label: 'Emails sent', value: t.everSent.toLocaleString(), sub: `${t.campaigns} campaign(s)`, run: () => go('mail') },
    { icon: 'ti-message-reply', label: 'Replies', value: t.everReplied.toLocaleString(), sub: `${t.replyRate}% reply rate` },
    { icon: 'ti-device-laptop', label: 'Live sessions', value: t.activeSessions, sub: t.scrapeFailures ? `${t.scrapeFailures} failed scrape(s)` : undefined },
  ];

  const ranked = [...data.users].filter(u => u.id).sort((a, b) => b.contacts.everSent - a.contacts.everSent);
  const max = Math.max(1, ...ranked.map(u => u.contacts.everSent));
  const shown = allSenders ? ranked : ranked.slice(0, TOP);
  const recent = [...data.users].filter(u => u.id && (u.lastActiveAt || u.lastLoginAt))
    .sort((a, b) => +new Date(b.lastActiveAt || b.lastLoginAt!) - +new Date(a.lastActiveAt || a.lastLoginAt!))
    .slice(0, 6);

  return (
    <>
      <div className="an-card">
        <div className="an-card-head">
          <div className="an-card-title"><i className="ti ti-bell-ringing" /> Needs attention</div>
        </div>
        <div className="an-card-body">
          {attn.length === 0 ? (
            <div className="adm-allclear">
              <span className="adm-attn-ico"><i className="ti ti-circle-check" /></span>
              All clear — no requests waiting, no open issues and sending looks healthy.
            </div>
          ) : (
            <div className="adm-attn">
              {attn.map((a, i) => (
                <div className="adm-attn-row" key={i}>
                  <span className={`adm-attn-ico ${a.tone}`}><i className={`ti ${a.icon}`} aria-hidden="true" /></span>
                  <div className="adm-attn-text">
                    {a.text}
                    {a.sub && <div className="adm-attn-sub">{a.sub}</div>}
                  </div>
                  {a.action && <button type="button" className="btn btn-xs" onClick={a.action.run}>{a.action.label} <i className="ti ti-arrow-right" /></button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="adm-kpis">
        {kpis.map(k => {
          const inner = (
            <>
              <span className="adm-kpi-label"><i className={`ti ${k.icon}`} aria-hidden="true" />{k.label}</span>
              <span className="adm-kpi-value">{k.value}</span>
              {k.sub && <span className="adm-kpi-sub">{k.sub}</span>}
            </>
          );
          return k.run
            ? <button key={k.label} type="button" className="adm-kpi" onClick={k.run}>{inner}</button>
            : <div key={k.label} className="adm-kpi">{inner}</div>;
        })}
      </div>

      <div className="adm-grid-2">
        <div className="an-card">
          <div className="an-card-head adm-card-head">
            <div>
              <div className="an-card-title"><i className="ti ti-chart-bar" /> Sent and replies per day</div>
              <div className="an-card-sub">Every account. From each contact's status history, in IST.</div>
            </div>
            <div className="seg-toggle" role="group" aria-label="Range">
              {RANGES.map(d => (
                <button key={d} type="button" className={`btn btn-xs${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
                  {days === d && loading && <i className="ti ti-loader" aria-hidden="true" />}{d}d
                </button>
              ))}
            </div>
          </div>
          <div className="an-card-body">
            <RefreshBar active={loading} />
            <Refreshing active={loading}>
              <AdminSendChart series={data.series} days={days} />
            </Refreshing>
          </div>
        </div>

        <div className="an-card">
          <div className="an-card-head">
            <div className="an-card-title"><i className="ti ti-clock" /> Recently active</div>
            <div className="an-card-sub">Click one to open it.</div>
          </div>
          <div className="an-card-body">
            {recent.length === 0 ? <div className="an-empty">No one has signed in yet.</div> : (
              <div className="adm-rank">
                {recent.map(u => (
                  <button key={u.id} type="button" className="adm-rank-row plain" onClick={() => openDrawer(u.id!)}>
                    <span className="adm-rank-email">{u.email}</span>
                    <span className="adm-rank-num">{fmtAgo(new Date(u.lastActiveAt || u.lastLoginAt!).getTime())}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Accounts ranked by volume. A bar list rather than a chart: at fifty
          accounts a fifty-column chart is unreadable. */}
      <div className="an-card">
        <div className="an-card-head">
          <div className="an-card-title"><i className="ti ti-trophy" /> Sending by account</div>
          <div className="an-card-sub">Emails ever sent. A trend, not an audit — a follow-up overwrites the send date it replaces. Click one to open it.</div>
          <button type="button" className="btn btn-xs" style={{ marginTop: 8 }} onClick={() => go('mail')}>Email activity by account <i className="ti ti-arrow-right" /></button>
        </div>
        <div className="an-card-body">
          {!ranked.some(u => u.contacts.everSent > 0) ? <div className="an-empty">Nothing sent yet.</div> : (
            <>
              <div className="adm-rank">
                {shown.map(u => (
                  <button key={u.id} type="button" className="adm-rank-row" onClick={() => openDrawer(u.id!)}>
                    <span className="adm-rank-email">{u.email}</span>
                    <span className="progress-bar"><span className="progress-fill" style={{ display: 'block', width: `${(u.contacts.everSent / max) * 100}%` }} /></span>
                    <span className="adm-rank-num">{u.contacts.everSent.toLocaleString()} sent</span>
                  </button>
                ))}
              </div>
              {ranked.length > TOP && (
                <button type="button" className="btn btn-xs adm-more" onClick={() => setAllSenders(v => !v)}>
                  {allSenders ? 'Show top 8' : `Show all ${ranked.length}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
