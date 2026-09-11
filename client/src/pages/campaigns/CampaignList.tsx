import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import { SkeletonRows } from '../../components/Skeleton';
import SendingTimeline from '../../components/campaigns/SendingTimeline';
import { useToast } from '../../context/ToastContext';
import {
  loadCampaignsApi, loadCampaignMetaApi, pauseCampaignApi, resumeCampaignApi,
  type Campaign, type CampaignMeta,
} from '../../lib/api';
import {
  CAMPAIGN_STATUS_BADGE, CAMPAIGN_STATUS_LABEL, daysRemaining, fmtCountdown, fmtHour,
  fmtIst, fromNow, isCronStale, nextRunAt, pct,
} from '../../lib/campaigns';

export default function CampaignList() {
  const toast = useToast();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [meta, setMeta] = useState<CampaignMeta | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Ticks the per-row countdowns without re-fetching anything.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const load = async () => {
    const [list, m] = await Promise.all([
      loadCampaignsApi(),
      loadCampaignMetaApi().catch(() => null),
    ]);
    setCampaigns(list);
    if (m) setMeta(m);
  };

  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, []);

  async function toggle(c: Campaign) {
    setBusy(c.id);
    try {
      if (c.status === 'running') {
        const { inFlightJobs } = await pauseCampaignApi(c.id);
        const pending = inFlightJobs.reduce((n, j) => n + j.pending, 0);
        toast(pending > 0
          ? `Paused. ${pending} emails from the batch already sending will still go out.`
          : 'Paused — no more contacts will be released.', 'success');
      } else {
        await resumeCampaignApi(c.id);
        toast('Campaign resumed.', 'success');
      }
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const running = (campaigns || []).filter((c) => c.status === 'running');
  const committed = running.reduce((n, c) => n + c.contactsPerDay, 0);
  const overCap = !!meta && committed > meta.dailyCap;

  return (
    <Layout
      title="Campaigns"
      subtitle="Drip a spreadsheet into outreach, a few contacts a day"
      actions={<Link to="/campaigns/new" className="btn btn-primary"><i className="ti ti-plus" /> New campaign</Link>}
    >
      {meta && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label">Running</div>
            <div className="stat-value">{meta.running}</div>
            <div className="stat-sub">{meta.paused} paused</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Committed per day</div>
            <div className="stat-value" style={overCap ? { color: 'var(--red)' } : undefined}>{committed}</div>
            <div className="stat-sub">across running campaigns</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Sent today</div>
            <div className="stat-value">{meta.sentToday}</div>
            <div className="stat-sub">{meta.inFlight} still scheduled</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Gmail headroom</div>
            <div className="stat-value" style={meta.headroom === 0 ? { color: 'var(--red)' } : undefined}>
              {meta.headroom}
            </div>
            <div className="stat-sub">of {meta.dailyCap} you allow per day</div>
          </div>
        </div>
      )}

      {overCap && (
        <div className="info-box" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', marginBottom: 14 }}>
          <i className="ti ti-mail-exclamation" />
          <span>
            Your running campaigns commit <strong>{committed} emails a day</strong>, over the {meta!.dailyCap} you've
            set as safe for Gmail. Nothing is capped automatically — lower a daily count if you want to stay under.
          </span>
        </div>
      )}

      {meta && !meta.cronConfigured && (
        <div className="info-box" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', marginBottom: 14 }}>
          <i className="ti ti-clock-off" />
          <span>
            <strong>CRON_SECRET isn't set</strong>, so the daily release can't run by itself. Set it in the server
            environment and as a GitHub secret, or release each batch with “Run now”.
          </span>
        </div>
      )}

      <div className="section-head" style={{ marginTop: 6 }}>
        <div className="section-title">Sending timeline</div>
      </div>
      <SendingTimeline />

      <div className="section-head" style={{ marginTop: 22 }}>
        <div className="section-title">All campaigns</div>
        <span className="contact-count-badge">{campaigns?.length ?? 0}</span>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th style={{ width: 190 }}>Progress</th>
              <th style={{ width: 120 }}>Status</th>
              <th style={{ width: 150 }}>Schedule</th>
              <th style={{ width: 190 }}>Next run</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {campaigns === null && <SkeletonRows rows={4} cols={6} />}
            {campaigns?.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty-state">
                  <i className="ti ti-calendar-repeat" />
                  No campaigns yet. Upload a spreadsheet and it'll be emailed a few contacts a day.
                </div>
              </td></tr>
            )}
            {campaigns?.map((c) => {
              const done = c.stats.released + c.stats.skipped;
              return (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/campaigns/${c.id}`)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                      {c.fileName || 'spreadsheet'} · {c.stats.total.toLocaleString()} rows
                    </div>
                  </td>
                  <td>
                    <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct(done, c.stats.total)}%` }} /></div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                      {c.stats.released.toLocaleString()} sent · {c.stats.pending.toLocaleString()} to go
                      {c.status === 'running' && c.stats.pending > 0 && ` · ~${daysRemaining(c)}d`}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${CAMPAIGN_STATUS_BADGE[c.status]}`}>{CAMPAIGN_STATUS_LABEL[c.status]}</span>
                    {isCronStale(c) && (
                      <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }} title="The scheduled release may have stopped running">
                        <i className="ti ti-alert-triangle" /> no release in 36h
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {c.contactsPerDay}/day at {fmtHour(c.runHourIst)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {(() => {
                      const n = nextRunAt(c);
                      if (!n) {
                        return (
                          <span style={{ color: 'var(--text3)' }}>
                            {c.status === 'completed' ? 'finished' : 'not scheduled'}
                            <div style={{ fontSize: 11 }}>last {fromNow(c.lastReleaseAt)}</div>
                          </span>
                        );
                      }
                      const ms = n.getTime() - Date.now();
                      return (
                        <>
                          <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                            {ms <= 0 ? 'due now' : `in ${fmtCountdown(ms)}`}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtIst(n)}</div>
                        </>
                      );
                    })()}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {(c.status === 'running' || c.status === 'paused' || c.status === 'failed') && (
                      <button className="btn btn-sm" type="button" disabled={busy === c.id} onClick={() => toggle(c)}>
                        {c.status === 'running'
                          ? <><i className="ti ti-player-pause" /> Pause</>
                          : <><i className="ti ti-player-play" /> Continue</>}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
