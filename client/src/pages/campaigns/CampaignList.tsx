import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import SendingTimeline from '../../components/campaigns/SendingTimeline';
import { useToast } from '../../context/ToastContext';
import {
  loadCampaignsApi, loadCampaignMetaApi, pauseCampaignApi, resumeCampaignApi, runCampaignNowApi,
  type Campaign, type CampaignMeta,
} from '../../lib/api';
import {
  CAMPAIGN_STATUS_LABEL, daysRemaining, dueSince, fmtCountdown,
  fmtHour, fmtIst, fromNow, isCronStale, nextRunAt, projectedFinish,
} from '../../lib/campaigns';

type CampaignTab = 'all' | 'active' | 'finished' | 'sending';

export default function CampaignList() {
  const toast = useToast();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [meta, setMeta] = useState<CampaignMeta | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<CampaignTab>('active');
  // Same in-page confirm as the detail page — a release can't be recalled.
  const [runTarget, setRunTarget] = useState<Campaign | null>(null);
  useEffect(() => {
    if (!runTarget) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRunTarget(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runTarget]);
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

  async function runNow() {
    const c = runTarget;
    if (!c) return;
    setRunTarget(null);
    setBusy(c.id);
    try {
      const r = await runCampaignNowApi(c.id);
      if (!r.ok && r.reason === 'locked_or_already_released') {
        throw new Error("Today's batch has already gone out.");
      }
      if (r.error) throw new Error(r.error);
      if (r.released === 0) {
        toast(
          r.retryable
            ? `Nobody was released — the scan ${r.timedOut ? 'timed out' : 'hit its row limit'} before finding anyone. Today's release is still scheduled.`
            : `Nobody was released — ${r.skipped} rows were skipped as duplicates or invalid.`,
          r.retryable ? 'error' : 'info',
        );
      } else {
        toast(`Released ${r.released} contacts — they'll go out over the next few hours.`, 'success');
      }
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const running = (campaigns || []).filter((c) => c.status === 'running');
  const visibleCampaigns = (campaigns || []).filter(c => {
    if (tab === 'all') return true;
    if (tab === 'sending') return !!c.sending;
    if (tab === 'finished') return c.status === 'completed' && !c.sending;
    return c.status !== 'completed' || !!c.sending;
  });
  const tabCounts = {
    all: (campaigns || []).length,
    active: (campaigns || []).filter(c => c.status !== 'completed' || !!c.sending).length,
    finished: (campaigns || []).filter(c => c.status === 'completed' && !c.sending).length,
    sending: (campaigns || []).filter(c => !!c.sending).length,
  };
  const committed = running.reduce((n, c) => n + c.contactsPerDay, 0);
  const overCap = !!meta && committed > meta.dailyCap;

  // Rolled up across every campaign, so the row answers "is my sending healthy"
  // without opening each one.
  const all = (campaigns || []).reduce((a, c) => {
    const o = c.outcomes;
    if (!o) return a;
    return {
      total: a.total + o.total, bounced: a.bounced + o.bounced,
      replied: a.replied + o.replied, delivered: a.delivered + o.delivered,
    };
  }, { total: 0, bounced: 0, replied: 0, delivered: 0 });
  const bouncePct = all.total ? Math.round((all.bounced / all.total) * 100) : 0;
  // Mailbox providers start treating a sender as suspect around 5%.
  const bounceColor = bouncePct >= 8 ? 'var(--red)' : bouncePct >= 4 ? 'var(--amber)' : undefined;

  return (
    <Layout
      title="Campaigns"
      subtitle="Drip a spreadsheet into outreach, a few contacts a day"
      actions={<Link to="/campaigns/new" className="btn btn-primary"><i className="ti ti-plus" /> New campaign</Link>}
    >
      {meta && (() => {
        // Used, not remaining, so the meter reads as consumption. Both numbers
        // are still shown — headroom is what you act on.
        const used = Math.max(0, meta.dailyCap - meta.headroom);
        const pctUsed = Math.min(100, Math.round((used / Math.max(1, meta.dailyCap)) * 100));
        const level = pctUsed >= 90 ? 'red' : pctUsed >= 70 ? 'amber' : 'green';
        return (
          <div className="stat-grid cmp-stats-5">
            <div className="stat-card">
              <div className="stat-label">Active campaigns</div>
              <div className="stat-value">{meta.running}</div>
              <div className="stat-sub">
                {meta.paused > 0 ? `${meta.paused} paused` : 'none paused'}
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Committed per day</div>
              <div className="stat-value" style={overCap ? { color: 'var(--red)' } : undefined}>
                {committed.toLocaleString()}
              </div>
              <div className="stat-sub">
                across {meta.running} running campaign{meta.running === 1 ? '' : 's'}
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Sent today</div>
              <div className="stat-value" style={{ color: 'var(--green)' }}>
                {meta.sentToday.toLocaleString()}
              </div>
              <div className="stat-sub">
                {meta.inFlight > 0
                  ? `${meta.inFlight.toLocaleString()} still scheduled`
                  : 'nothing left in the queue'}
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Bounced</div>
              <div className="stat-value" style={{ color: bounceColor }}>
                {all.bounced.toLocaleString()}
                {all.total > 0 && <span className="stat-of"> · {bouncePct}%</span>}
              </div>
              <div className="stat-sub">
                {all.total === 0
                  ? 'nothing emailed yet'
                  : bouncePct >= 4
                    ? 'high — check list quality'
                    : `${all.replied.toLocaleString()} replied`}
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Gmail budget</div>
              <div className="stat-value">
                {used.toLocaleString()}
                <span className="stat-of"> / {meta.dailyCap.toLocaleString()}</span>
              </div>
              {/* Fill carries severity; the track is a lighter step of the same
                  hue so the state reads across the whole bar. */}
              <div className={`cmp-meter ${level}`} role="img"
                aria-label={`${pctUsed}% of the daily allowance used`}>
                <i style={{ width: `${pctUsed}%` }} />
              </div>
              <div className="stat-sub">
                {meta.headroom.toLocaleString()} left today
              </div>
            </div>
          </div>
        );
      })()}

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

      <section className="cmpx-card" aria-label="Sending timeline">
        <h2 className="cmpx-eyebrow">Sending timeline</h2>
        <SendingTimeline />
      </section>

      <div className="section-head" style={{ marginTop: 4 }}>
        <div className="nav-tabs cmpx-tabs">
          {(['all', 'active', 'finished', 'sending'] as CampaignTab[]).map(key => (
            <button type="button" key={key} className={`nav-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {key === 'all' ? 'All' : key === 'active' ? 'Active' : key === 'finished' ? 'Finished' : 'Sending now'}
              <span className="cmpx-count">{tabCounts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="cmpx-list">
        {campaigns === null && <div className="empty-state"><i className="ti ti-loader-2" /> Loading…</div>}
        {campaigns?.length === 0 && (
          <div className="empty-state">
            <i className="ti ti-calendar-repeat" />
            No campaigns yet. Upload a spreadsheet and it'll be emailed a few contacts a day.
          </div>
        )}
        {campaigns && campaigns.length > 0 && visibleCampaigns.length === 0 && (
          <div className="empty-state"><i className="ti ti-filter" />No {tab} campaigns</div>
        )}
        {visibleCampaigns.map((c) => {
          const displayStatus = c.sending ? 'sending' : c.status;
          const o = c.outcomes;
          const total = Math.max(1, c.stats.total);
          const replied = o?.replied || 0;
          const bounced = o?.bounced || 0;
          const sentOnly = Math.max(0, c.stats.released - replied - bounced);
          const w = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
          const pillTone = c.sending ? 'blue'
            : c.status === 'running' ? 'green'
            : c.status === 'paused' ? 'amber'
            : c.status === 'failed' ? 'red' : '';
          const od = dueSince(c);
          const n = nextRunAt(c);
          const fin = c.status === 'running' ? projectedFinish(c) : null;
          return (
            <article key={c.id} className="cmpx-camp" onClick={() => navigate(`/campaigns/${c.id}`)}>
              <div className="cmpx-camp-main">
                <div className="cmpx-camp-head">
                  <Link to={`/campaigns/${c.id}`} className="cmpx-camp-name" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                  <span className={`cmpx-pill ${pillTone}`}>
                    {displayStatus === 'sending' ? 'Sending mails' : CAMPAIGN_STATUS_LABEL[c.status]}
                  </span>
                  {!c.sending && isCronStale(c) && (
                    <span style={{ fontSize: 11, color: 'var(--amber)' }} title="The scheduled release may have stopped running">
                      <i className="ti ti-alert-triangle" /> no release in 36h
                    </span>
                  )}
                </div>
                <span className="cmpx-camp-meta">{c.fileName || 'spreadsheet'} · {c.stats.total.toLocaleString()} rows</span>
                <div>
                  <div className="cmpx-seg" aria-hidden="true">
                    <span className="s-sent" style={{ width: w(sentOnly) }} />
                    <span className="s-rep" style={{ width: w(replied) }} />
                    <span className="s-bnc" style={{ width: w(bounced) }} />
                  </div>
                  <div className="cmpx-prog-line" style={{ marginTop: 6 }}>
                    <b>{c.stats.released.toLocaleString()}</b> of {c.stats.total.toLocaleString()} released · {c.stats.pending.toLocaleString()} queued
                    {c.status === 'running' && c.stats.pending > 0 && ` · ~${daysRemaining(c)}d`}
                    {o && o.total > 0 && <>
                      {' · '}<span style={{ color: 'var(--teal)' }}>{replied} replied</span>
                      {' · '}<span style={{ color: bounced > 0 ? (Math.round((bounced / o.total) * 100) >= 4 ? 'var(--red)' : 'var(--amber)') : undefined }}>
                        {bounced} bounced{bounced > 0 && ` (${Math.round((bounced / o.total) * 100)}%)`}
                      </span>
                    </>}
                  </div>
                </div>
              </div>
              <dl className="cmpx-dl">
                <dt>Schedule</dt>
                <dd>{c.contactsPerDay}/day · {c.ratePerHour}/hr · from {fmtHour(c.runHourIst)}</dd>
                <dt>Next run</dt>
                <dd>
                  {od ? (
                    <span style={{ color: 'var(--amber)' }}>due now · waiting {fmtCountdown(Date.now() - od.getTime())}</span>
                  ) : c.sending ? (
                    <span style={{ color: 'var(--amber)' }}>sending mails</span>
                  ) : n ? (
                    <>{fmtIst(n)} <span style={{ color: 'var(--amber)', fontVariantNumeric: 'tabular-nums' }}>· in {fmtCountdown(n.getTime() - Date.now())}</span></>
                  ) : (
                    <span style={{ color: 'var(--text3)' }}>
                      {c.status === 'completed' ? 'finished' : 'not scheduled'} · last {fromNow(c.lastReleaseAt)}
                    </span>
                  )}
                </dd>
                <dt>Finishes</dt>
                <dd>{fin ? fmtIst(fin).replace(/,.*/, '') : '—'}</dd>
              </dl>
              <div className="cmpx-camp-actions" onClick={(e) => e.stopPropagation()}>
                {c.status === 'running' && (
                  <button className="btn btn-sm" type="button" disabled={busy === c.id} onClick={() => setRunTarget(c)}>
                    <i className="ti ti-player-track-next" /> Run now
                  </button>
                )}
                {(c.status === 'running' || c.status === 'paused' || c.status === 'failed') && (
                  <button className="btn btn-sm" type="button" disabled={busy === c.id} onClick={() => toggle(c)}>
                    {c.status === 'running'
                      ? <><i className="ti ti-player-pause" /> Pause</>
                      : <><i className="ti ti-player-play" /> Continue</>}
                  </button>
                )}
                <Link to={`/campaigns/${c.id}`} className="btn btn-sm btn-primary">Open <i className="ti ti-arrow-right" /></Link>
              </div>
            </article>
          );
        })}
      </div>

      {runTarget && createPortal(
        <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) setRunTarget(null); }}>
          <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 480 }}>
            <div className="reply-modal-header">
              <div style={{ fontWeight: 600, fontSize: 15 }}>Send {runTarget.contactsPerDay} emails now?</div>
              <button aria-label="Close" className="btn btn-sm" onClick={() => setRunTarget(null)} type="button">
                <i className="ti ti-x" />
              </button>
            </div>
            <div style={{ padding: '14px 0', fontSize: 13, lineHeight: 1.6, color: 'var(--text2)' }}>
              This releases “{runTarget.name}” today&apos;s batch immediately instead of waiting for its scheduled time.
              The emails go out one every {Math.round(60 / Math.max(1, runTarget.ratePerHour))} minutes and cannot be
              recalled once sent, and today&apos;s scheduled release will not run again.
            </div>
            <div className="reply-modal-footer">
              <button className="btn btn-sm" onClick={() => setRunTarget(null)} type="button">
                <i className="ti ti-x" /> Cancel
              </button>
              <button className="btn btn-primary" onClick={runNow} type="button">
                <i className="ti ti-player-track-next" /> Send now
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </Layout>
  );
}
