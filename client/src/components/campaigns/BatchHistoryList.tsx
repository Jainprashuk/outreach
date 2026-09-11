import { Fragment, useState } from 'react';
import Avatar from '../Avatar';
import { getJobApi, type Campaign, type CampaignJobSummary, type SendJob } from '../../lib/api';
import { fmtDateTime, pct } from '../../lib/campaigns';

/**
 * One row per day the campaign released, newest first.
 *
 * Expanding fetches that day's SendJob through the EXISTING getJobApi and
 * renders its items — a released batch is an ordinary send job, so there is no
 * separate job model here.
 */
export default function BatchHistoryList({ campaign, jobSummaries }: {
  campaign: Campaign;
  jobSummaries: CampaignJobSummary[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, SendJob>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const byId = new Map(jobSummaries.map((j) => [j.id, j]));
  const releases = [...(campaign.releases || [])].reverse();

  async function toggle(jobId: string | null) {
    if (!jobId) return;
    if (open === jobId) { setOpen(null); return; }
    setOpen(jobId);
    if (jobs[jobId]) return;
    setLoading(jobId);
    try {
      const job = await getJobApi(jobId);
      setJobs((m) => ({ ...m, [jobId]: job }));
    } catch { /* the summary row still shows the counts */ }
    finally { setLoading(null); }
  }

  if (releases.length === 0) {
    return (
      <div className="empty-state">
        <i className="ti ti-history" />
        No batches released yet. The first goes out at the campaign's daily send time.
      </div>
    );
  }

  const badgeFor = (r: typeof releases[number], s?: CampaignJobSummary) => {
    if (r.error) return <span className="badge badge-rejected">Failed</span>;
    if (!s) return <span className="badge badge-queued">Released</span>;
    if (s.pending > 0) return <span className="badge badge-pending">Sending</span>;
    if (s.failed > 0 && s.sent > 0) return <span className="badge badge-followup">Partly sent</span>;
    if (s.failed > 0) return <span className="badge badge-rejected">Failed</span>;
    return <span className="badge badge-sent">Sent</span>;
  };

  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th style={{ width: 130 }}>Day</th>
            <th style={{ width: 100 }}>Released</th>
            <th style={{ width: 110 }}>Status</th>
            <th>Outcome</th>
            <th style={{ width: 160 }}>Ran at</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {releases.map((r, i) => {
            const s = r.jobId ? byId.get(r.jobId) : undefined;
            const job = r.jobId ? jobs[r.jobId] : undefined;
            return (
              <Fragment key={`${r.releasedOn}-${i}`}>
                <tr style={{ cursor: r.jobId ? 'pointer' : 'default' }} onClick={() => toggle(r.jobId)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.releasedOn}</div>
                    {r.trigger === 'manual' && <div style={{ fontSize: 11, color: 'var(--text3)' }}>run manually</div>}
                  </td>
                  <td>{r.released}{r.skipped > 0 && <span style={{ color: 'var(--text3)' }}> +{r.skipped} skipped</span>}</td>
                  <td>{badgeFor(r, s)}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.error
                      ? <span style={{ color: 'var(--red)' }}>{r.error}</span>
                      : s
                        ? <>
                            <span style={{ color: 'var(--green)' }}>{s.sent} sent</span>
                            {s.failed > 0 && <span style={{ color: 'var(--red)' }}> · {s.failed} failed</span>}
                            {s.skipped > 0 && <span style={{ color: 'var(--text3)' }}> · {s.skipped} skipped</span>}
                            {s.pending > 0 && <span style={{ color: 'var(--text2)' }}> · {s.pending} still to go</span>}
                          </>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDateTime(r.finishedAt)}</td>
                  <td>{r.jobId && <i className={`ti ti-chevron-${open === r.jobId ? 'up' : 'down'}`} />}</td>
                </tr>
                {open === r.jobId && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg)', padding: 12 }}>
                      {loading === r.jobId && <div style={{ fontSize: 12, color: 'var(--text2)' }}>Loading the batch…</div>}
                      {job && (
                        <>
                          <div className="progress-bar" style={{ marginBottom: 10 }}>
                            <div className="progress-fill" style={{
                              width: `${pct(job.items.filter((it) => it.status !== 'pending').length, job.items.length)}%`,
                            }} />
                          </div>
                          {job.items.map((it) => (
                            <div key={it.contactId} className="batch-row">
                              <Avatar name={it.name} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13 }}>{it.name}</div>
                                <div style={{ fontSize: 11, color: 'var(--text3)' }}>{it.to}</div>
                                {it.error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{it.error}</div>}
                              </div>
                              <span className={`badge ${
                                it.status === 'sent' ? 'badge-sent'
                                : it.status === 'failed' ? 'badge-rejected'
                                : it.status === 'skipped' ? 'badge-closed' : 'badge-queued'}`}>
                                {it.status}
                              </span>
                            </div>
                          ))}
                        </>
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
  );
}
