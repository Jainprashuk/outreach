// Analytics → (admin) one account. Numbers only: GET /api/admin/users/:id/analytics
// strips every name, company and text field on the server, so nothing here can
// show another person's contacts. The Outreach and Leads views are built in the
// browser from raw rows, which is exactly what this view must not fetch — so it
// shows that account's report, pipeline counts and Discover totals instead.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReportsPanel from './ReportsPanel';
import { NaukriAnalyticsView } from './NaukriAnalytics';
import { Card, HBar } from './AnalyticsCards';
import { Skeleton } from './Skeleton';
import { cvar, STATUS_META } from '../lib/analytics';
import {
  adminUserAnalyticsApi, type AdminUserAnalytics as Data, type ReportPeriodQuery, type ReportStats,
} from '../lib/api';

type Tab = 'report' | 'pipeline' | 'discover' | 'naukri';

const n = (v: number) => (v || 0).toLocaleString('en-IN');
const pretty = (k: string) => (k === 'none' ? 'Not set' : k.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()));
const sum = (r: Record<string, number> = {}) => Object.values(r).reduce((a, b) => a + b, 0);

function Breakdown({ rows, labels, color }: { rows: Record<string, number>; labels?: Record<string, { label: string; c: string }>; color: string }) {
  const entries = Object.entries(rows || {}).sort((a, b) => b[1] - a[1]);
  const total = sum(rows);
  if (!entries.length) return <div className="an-empty">None yet.</div>;
  return (
    <>
      {entries.map(([k, v]) => (
        <HBar key={k} label={labels?.[k]?.label || pretty(k)} n={v} d={total}
          fill={labels?.[k] ? (cvar(labels[k].c) || color) : color} />
      ))}
    </>
  );
}

export default function AdminUserAnalytics({ userId }: { userId: string }) {
  const [tab, setTab] = useState<Tab>('report');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  // The report tab's period picker drives the fetch; the other tabs reuse the
  // last answer and only fetch themselves when opened first.
  const fetcher = async (q: ReportPeriodQuery): Promise<ReportStats> => {
    const d = await adminUserAnalyticsApi(userId, q);
    setData(d);
    setError('');
    return { ...d.report, label: d.label, topReplies: [], waiting: { count: d.report.waiting.count, items: [] }, upcomingInterviews: [] };
  };

  useEffect(() => { setData(null); }, [userId]);
  useEffect(() => {
    if (tab !== 'report' && !data) {
      adminUserAnalyticsApi(userId, { period: 'last-week' }).then(setData).catch(e => setError(e.message || 'Could not load'));
    }
  }, [tab, userId, data]);

  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';

  return (
    <>
      <div className="section-head" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div className="nav-tabs">
          {([['report', 'ti-file-analytics', 'Report'], ['pipeline', 'ti-list-check', 'Pipeline'], ['discover', 'ti-compass', 'Discover'], ['naukri', 'ti-briefcase', 'Naukri']] as const).map(([k, icon, label]) => (
            <button key={k} type="button" className={`nav-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
              <i className={`ti ${icon}`} /> {label}
            </button>
          ))}
        </div>
        <Link className="btn btn-sm" to={`/admin?user=${userId}`}><i className="ti ti-user-cog" /> Actions for this account</Link>
      </div>

      {error && <div className="login-error" style={{ textAlign: 'left', marginBottom: 12 }}>{error}</div>}

      {tab === 'report' && (
        <ReportsPanel key={userId} fetcher={fetcher} adminMode upcomingInterviewCount={data?.report.upcomingInterviewCount || 0} />
      )}

      {tab !== 'report' && !data && !error && (
        <div className="an-grid an-cards-2" aria-busy="true">
          {[0, 1].map(i => (
            <div className="an-card" key={i} style={{ padding: 18 }}>
              <Skeleton w="40%" h={13} style={{ marginBottom: 16 }} />
              {[0, 1, 2, 3].map(r => <Skeleton key={r} w={`${88 - r * 11}%`} h={10} style={{ marginBottom: 10 }} />)}
            </div>
          ))}
        </div>
      )}

      {tab === 'pipeline' && data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            {([
              ['Contacts', n(sum(data.pipeline.contacts))],
              ['Ever replied', n(sum(data.pipeline.replies))],
              ['Leads', n(sum(data.pipeline.leads))],
              ['Interviews', n(sum(data.pipeline.interviews))],
              ['Gmail connected', data.sending.hasGmail ? 'Yes' : 'No'],
            ] as const).map(([label, value]) => (
              <div className="stat-card" key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{value}</div>
              </div>
            ))}
          </div>
          <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
            <Card title="Contacts by status" icon="ti-users" sub="Where every contact is right now">
              <Breakdown rows={data.pipeline.contacts} labels={STATUS_META} color={accent} />
            </Card>
            <Card title="Replies by type" icon="ti-message-2" sub="Every contact that ever replied">
              <Breakdown rows={data.pipeline.replies} color={teal} />
            </Card>
            <Card title="Approval" icon="ti-checks" sub="Contacts approved to send">
              <Breakdown rows={data.pipeline.approval} color={accent} />
            </Card>
            <Card title="Interviews by stage" icon="ti-calendar-event" sub="Tracked in Interviews">
              <Breakdown rows={data.pipeline.interviews} color={teal} />
            </Card>
            <Card title="Leads by status" icon="ti-target-arrow" sub="Harvested leads">
              <Breakdown rows={data.pipeline.leads} color={accent} />
            </Card>
            {data.pipeline.leadsByApply && (
              <Card title="Direct applications" icon="ti-briefcase" sub="Leads by apply status">
                <Breakdown rows={data.pipeline.leadsByApply} color={teal} />
              </Card>
            )}
            <Card title="Sending" icon="ti-send"
              sub={data.sending.lastMailboxCheckAt ? `Mailbox last checked ${new Date(data.sending.lastMailboxCheckAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'Mailbox never checked'}>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>Batches</div>
              <Breakdown rows={data.sending.jobs} color={accent} />
              <div style={{ fontSize: 12, color: 'var(--text2)', margin: '10px 0 6px' }}>Campaigns</div>
              <Breakdown rows={data.sending.campaigns} color={teal} />
              {(data.sending.pausedByAdmin.jobs + data.sending.pausedByAdmin.campaigns) > 0 && (
                <div className="info-box" style={{ marginTop: 10 }}>
                  An admin paused {data.sending.pausedByAdmin.jobs} batch(es) and {data.sending.pausedByAdmin.campaigns} campaign(s).
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      {tab === 'discover' && data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            {([
              ['People found', data.discover.totals.found],
              ['With an email', data.discover.totals.withEmail],
              ['Moved to outreach', data.discover.totals.moved],
              ['Emailed', data.discover.totals.emailed],
              ['Replied', data.discover.totals.replied],
              ['Bounced', data.discover.totals.bounced],
            ] as const).map(([label, v]) => (
              <div className="stat-card" key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{n(v)}</div>
              </div>
            ))}
          </div>
          <div className="an-grid an-cards-2">
            <Card title="Guessed emails by confidence" icon="ti-shield-check" sub="Emailed, replied and bounced per label">
              <table className="an-table">
                <thead><tr><th>Label</th><th style={{ textAlign: 'right' }}>Emailed</th><th style={{ textAlign: 'right' }}>Replied</th><th style={{ textAlign: 'right' }}>Bounced</th></tr></thead>
                <tbody>{data.discover.byLabel.map(r => (
                  <tr key={r.label}><td>{pretty(r.label)}</td>
                    <td style={{ textAlign: 'right' }}>{n(r.emailed)}</td><td style={{ textAlign: 'right' }}>{n(r.replied)}</td><td style={{ textAlign: 'right' }}>{n(r.bounced)}</td></tr>
                ))}</tbody>
              </table>
            </Card>
            <Card title="Searches" icon="ti-search" sub={`Last ${data.discover.days} days · ${data.discover.totals.companies} companies`}>
              <table className="an-table"><tbody>
                <tr><td>Searches run</td><td style={{ textAlign: 'right' }}>{n(data.discover.totals.searchesLastDays)}</td></tr>
                <tr><td>Finished</td><td style={{ textAlign: 'right' }}>{n(data.discover.runs.done)}</td></tr>
                <tr><td>Failed</td><td style={{ textAlign: 'right' }}>{n(data.discover.runs.failed)}</td></tr>
                <tr><td>Found via search / GitHub / website</td><td style={{ textAlign: 'right' }}>{n(data.discover.via.search)} / {n(data.discover.via.github)} / {n(data.discover.via.website)}</td></tr>
                {data.discover.allowance.map(a => (
                  <tr key={a.provider}><td>{pretty(a.provider)} ({data.discover.month})</td>
                    <td style={{ textAlign: 'right' }}>{a.hasKey ? `${n(a.used)} / ${n(a.cap)}` : 'no key'}</td></tr>
                ))}
              </tbody></table>
            </Card>
          </div>
        </>
      )}
      {tab === 'naukri' && data && (
        data.naukri ? <NaukriAnalyticsView data={data.naukri} admin /> : <div className="an-empty">No Naukri numbers for this account.</div>
      )}
    </>
  );
}
