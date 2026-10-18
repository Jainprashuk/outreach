// Analytics → Outreach cards for the parts of the send flow the summary doesn't
// cover: the Mailbox "Needs you" queue (from the summary's `queue`) and campaigns
// (GET /api/campaigns/analytics) — skip reasons, replies per campaign, Gmail's
// daily limit, and which campaigns the Action Center started.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, HBar } from './AnalyticsCards';
import { Skeleton } from './Skeleton';
import { campaignAnalyticsApi, type CampaignAnalytics, type QueueAnalytics } from '../lib/api';
import { cvar } from '../lib/analytics';

const BUCKET_LABEL: Record<string, string> = {
  'needs-you': 'Needs you', 'follow-up': 'Follow up', waiting: 'Waiting on them', snoozed: 'Snoozed', done: 'Done',
};
const STATUS_BADGE: Record<string, string> = {
  running: 'badge-sent', paused: 'badge-pending', completed: 'badge-closed', draft: 'badge-queued', failed: 'badge-rejected',
};
const AC_KIND: Record<string, string> = {
  followup: 'Follow-ups', ready: 'Ready contacts', pending: 'New contacts', leads: 'Leads', prospects: 'Discover',
};
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

export function NeedsYouCard({ queue, delay }: { queue?: QueueAnalytics; delay?: string }) {
  const teal = cvar('--teal') || '#085041';
  const amber = cvar('--amber') || '#8a5c00';
  const muted = cvar('--text3') || '#8a8a8a';
  if (!queue) return null;
  const open = queue.buckets['needs-you'] + queue.buckets['follow-up'];
  const all = Object.values(queue.buckets).reduce((a, b) => a + b, 0);
  return (
    <Card title="Needs you" icon="ti-inbox" delay={delay}
      sub="Everyone who replied, by whose move it is — the same buckets as the Mailbox tabs"
      right={open > 0 ? <Link to="/mailbox" className="btn btn-sm">Open Mailbox</Link> : undefined}>
      {all === 0 ? <div className="an-empty"><i className="ti ti-inbox" />No replies to act on yet</div> : (
        <>
          {(['needs-you', 'follow-up', 'waiting', 'snoozed', 'done'] as const).map(b => (
            <HBar key={b} label={BUCKET_LABEL[b]} n={queue.buckets[b]} d={all}
              fill={b === 'needs-you' ? amber : b === 'follow-up' ? amber : b === 'done' ? teal : muted}
              opacity={b === 'follow-up' ? 0.55 : 0.85} />
          ))}
          {queue.reasons.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="an-card-sub" style={{ marginTop: 0 }}>Why they're waiting:</span>
              {queue.reasons.map(r => (
                <Link key={`${r.bucket}:${r.reason}`} to={`/mailbox?tab=${r.bucket}`} className="contact-count-badge">{r.label} · {r.n}</Link>
              ))}
            </div>
          )}
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            {queue.resolved.total
              ? `${queue.resolved.total} closed in the last ${queue.days} days — ${queue.resolved.by.map(b => `${b.n} ${b.label.toLowerCase()}`).join(', ')}.`
              : `Nothing closed in the last ${queue.days} days.`}
          </div>
        </>
      )}
    </Card>
  );
}

export function CampaignsCard({ refreshToken, delay }: { refreshToken?: number; delay?: string }) {
  const [data, setData] = useState<CampaignAnalytics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    campaignAnalyticsApi(30)
      .then(d => { if (alive) { setData(d); setError(''); } })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [refreshToken]);

  const muted = cvar('--text3') || '#8a8a8a';
  const red = cvar('--red') || '#c0392b';

  return (
    <Card title="Campaigns" icon="ti-send" delay={delay}
      sub="Campaigns running or active in the last 30 days: what went out, what was skipped and who replied"
      right={data && data.quota.pausedNow.gmailLimit > 0
        ? <span className="badge badge-pending" title="Gmail's daily sending limit — retried hourly">{data.quota.pausedNow.gmailLimit} paused by Gmail's limit</span>
        : undefined}>
      {error ? <div className="an-empty"><i className="ti ti-alert-triangle" />{error}</div>
        : !data ? [0, 1, 2, 3].map(r => <Skeleton key={r} w={`${90 - r * 12}%`} h={11} style={{ marginBottom: 10 }} />)
          : data.campaigns.length === 0 && data.actionCenter.length === 0 ? <div className="an-empty"><i className="ti ti-send-off" />No campaigns in the last {data.days} days</div>
        : (
          <>
            {data.campaigns.length > 0 && <div style={{ overflowX: 'auto' }}>
              <table className="an-table">
                <thead><tr><th>Campaign</th><th>Status</th><th className="num">Released</th><th className="num">Skipped</th><th className="num">Left</th><th className="num">Replied</th></tr></thead>
                <tbody>
                  {data.campaigns.slice(0, 12).map(c => (
                    <tr key={c.id}>
                      <td style={{ maxWidth: 240 }}>
                        <Link to={`/campaigns/${c.id}`} style={{ color: 'var(--text)', fontWeight: 500 }}>{c.name}</Link>
                        {c.origin === 'action-center' && (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            <i className="ti ti-bolt" /> {c.originLabel}{c.actionKind && AC_KIND[c.actionKind] ? ` · ${AC_KIND[c.actionKind]}` : ''}
                          </div>
                        )}
                      </td>
                      <td><span className={`badge ${STATUS_BADGE[c.status] || 'badge-queued'}`}>{c.pausedByAdmin ? 'paused by admin' : c.status}</span></td>
                      <td className="num">{c.released.toLocaleString()}</td>
                      <td className="num" style={{ color: 'var(--text2)' }}>{c.skipped.toLocaleString()}</td>
                      <td className="num" style={{ color: 'var(--text2)' }}>{c.pending.toLocaleString()}</td>
                      <td className="num">{c.replied}{c.released ? <span style={{ color: 'var(--text3)', fontSize: 11 }}> {c.replyRate}%</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
            {data.campaigns.length > 12 && <div className="an-card-sub" style={{ marginTop: 6 }}>And {data.campaigns.length - 12} more on the <Link to="/campaigns">Campaigns</Link> page.</div>}
            {data.skipReasons.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>Why rows were skipped</div>
                {data.skipReasons.slice(0, 6).map(r => (
                  <HBar key={r.key} label={r.label} n={r.n} d={data.totals.skipped || 1}
                    fill={r.key === 'bounced' || r.key === 'invalid_email' ? red : muted} />
                ))}
              </div>
            )}
            {data.actionCenter.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}><i className="ti ti-bolt" /> Started from the Action Center</div>
                <table className="an-table">
                  <thead><tr><th>Action</th><th className="num">Campaigns</th><th className="num">Step-wise</th><th className="num">Reached</th><th className="num">Replied</th></tr></thead>
                  <tbody>
                    {data.actionCenter.map(a => (
                      <tr key={a.kind}>
                        <td>{AC_KIND[a.kind] || 'Other'}</td>
                        <td className="num">{a.campaigns}</td>
                        <td className="num">{a.batches}</td>
                        <td className="num">{a.contacts.toLocaleString()}</td>
                        <td className="num">{a.replied}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="an-card-sub" style={{ marginTop: 10 }}>
              {data.quota.pauses
                ? `Gmail's daily limit paused your batches ${data.quota.pauses} time${data.quota.pauses === 1 ? '' : 's'} in the last ${data.days} days (last ${when(data.quota.lastPausedAt)}). Paused batches resume on their own.`
                : `Gmail's daily limit didn't pause anything in the last ${data.days} days.`}
              {data.quota.pausedNow.admin > 0 && ` ${data.quota.pausedNow.admin} batch${data.quota.pausedNow.admin === 1 ? ' is' : 'es are'} paused by an admin.`}
            </div>
          </>
        )}
    </Card>
  );
}
