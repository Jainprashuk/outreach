import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import UpcomingBatchTable from '../../components/campaigns/UpcomingBatchTable';
import BatchHistoryList from '../../components/campaigns/BatchHistoryList';
import SkippedRowsPanel from '../../components/campaigns/SkippedRowsPanel';
import NextRunPanel from '../../components/campaigns/NextRunPanel';
import UpcomingSchedule from '../../components/campaigns/UpcomingSchedule';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { useCampaignPoll } from '../../hooks/useCampaignPoll';
import {
  deleteCampaignApi, loadCampaignMetaApi, pauseCampaignApi, resumeCampaignApi,
  runCampaignNowApi, updateCampaignApi, type CampaignMeta,
} from '../../lib/api';
import {
  CAMPAIGN_STATUS_BADGE, CAMPAIGN_STATUS_LABEL, daysRemaining, dripDuration,
  dueSince, fmtCountdown, fmtHour, fmtIst, fromNow, nextRunAt, pct, totalBatches,
} from '../../lib/campaigns';

type Tab = 'upcoming' | 'history' | 'skipped' | 'removed' | 'setup';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, refresh, lastUpdated } = useCampaignPoll(id);
  const [tab, setTab] = useState<Tab>('upcoming');
  // Two questions live under Upcoming: who goes next, and when does this finish.
  const [upcomingView, setUpcomingView] = useState<'batch' | 'schedule'>('batch');
  const [busy, setBusy] = useState(false);
  // Without this, the page shows a precise countdown for a release that can
  // never fire, which is worse than showing nothing.
  const [meta, setMeta] = useState<CampaignMeta | null>(null);
  useEffect(() => { loadCampaignMetaApi().then(setMeta).catch(() => {}); }, []);
  // Only the templates — init() would also pull every contact, which this page
  // never reads.
  const templatesLoaded = Object.keys(app.templates).length > 0;
  useEffect(() => {
    if (!templatesLoaded) app.loadTemplates().catch(() => {});
  }, [templatesLoaded]);
  // Ticks the countdown once a second, independently of the 10s data poll.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (loading && !data) {
    return <Layout title="Campaign"><div className="empty-state"><i className="ti ti-loader-2" /> Loading…</div></Layout>;
  }
  if (!data) {
    return (
      <Layout title="Campaign">
        <div className="empty-state"><i className="ti ti-alert-triangle" /> {error || 'Campaign not found'}</div>
      </Layout>
    );
  }

  const c = data.campaign;
  const s = c.stats;
  const handled = s.released + s.skipped + s.removed;
  const next = nextRunAt(c);
  const overdue = dueSince(c);
  const countdownMs = next ? next.getTime() - Date.now() : 0;
  const lastBatch = [...(c.releases || [])].reverse().find((r) => r.kind !== 'reconcile');
  const lastJob = lastBatch?.jobId ? data.jobSummaries.find((j) => j.id === lastBatch.jobId) : undefined;
  const lastBatchState = (() => {
    if (!lastBatch) return null;
    if (lastBatch.error) return { text: 'could not be queued', color: 'var(--red)' };
    if (!lastJob) return { text: 'queued', color: 'var(--text3)' };
    if (lastJob.pending > 0) return { text: `sending · ${lastJob.pending} to go`, color: 'var(--amber)' };
    if (lastJob.failed > 0 && lastJob.sent > 0) return { text: `${lastJob.failed} failed`, color: 'var(--amber)' };
    if (lastJob.failed > 0) return { text: 'all failed', color: 'var(--red)' };
    return { text: 'all sent', color: 'var(--green)' };
  })();
  const o = data.outcomes;
  // Rate over what actually left, not over the whole sheet — a 4% bounce rate on
  // 75 sent is the deliverability signal; 4% of 3,371 queued is meaningless.
  const denom = Math.max(1, o.total);
  const bouncePct = Math.round((o.bounced / denom) * 100);
  const replyPct = Math.round((o.replied / denom) * 100);
  // Mailbox providers start treating a sender as suspect around 5%.
  const bounceLevel = bouncePct >= 8 ? 'var(--red)' : bouncePct >= 4 ? 'var(--amber)' : 'var(--text)';
  const jobTotals = data.jobSummaries.reduce(
    (acc, j) => ({ sent: acc.sent + j.sent, failed: acc.failed + j.failed }), { sent: 0, failed: 0 },
  );

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done, 'success'); await refresh(); }
    catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const pause = () => act(async () => {
    const { inFlightJobs } = await pauseCampaignApi(c.id);
    const pending = inFlightJobs.reduce((n, j) => n + j.pending, 0);
    if (pending > 0) toast(`${pending} emails already scheduled will still go out.`, 'info');
  }, 'Paused — no more contacts will be released.');

  const resume = () => act(() => resumeCampaignApi(c.id), 'Campaign resumed.');

  const runNow = async () => {
    const n = nextRunAt(c);
    const ok = window.confirm(
      `Send ${c.contactsPerDay} emails now?\n\n`
      + `This releases today's batch immediately instead of waiting`
      + `${n ? ` for ${fmtIst(n)}` : ''}. The emails go out one every `
      + `${Math.round(60 / Math.max(1, c.ratePerHour))} minutes and cannot be recalled once sent, `
      + `and today's scheduled release will not run again.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runCampaignNowApi(c.id);
      if (!r.ok && r.reason === 'locked_or_already_released') {
        throw new Error("Today's batch has already gone out.");
      }
      if (r.error) throw new Error(r.error);
      if (r.released === 0) {
        // Saying "released 0" as a success would imply the day is done. It isn't.
        toast(
          r.retryable
            ? `Nobody was released — the scan ${r.timedOut ? 'timed out' : 'hit its row limit'} before finding anyone. Today's release is still scheduled.`
            : `Nobody was released — ${r.skipped} rows were skipped as duplicates or invalid.`,
          r.retryable ? 'error' : 'info',
        );
      } else {
        toast(`Released ${r.released} contacts — they'll go out over the next few hours.`, 'success');
      }
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = (patch: Parameters<typeof updateCampaignApi>[1]) =>
    act(() => updateCampaignApi(c.id, patch), 'Saved.');

  const remove = async () => {
    if (!confirm(`Delete "${c.name}"? Contacts already emailed are kept — this only stops the campaign.`)) return;
    await act(() => deleteCampaignApi(c.id, true), 'Campaign deleted.');
    navigate('/campaigns');
  };

  const TABS: [Tab, string, number | null][] = [
    ['upcoming', 'Upcoming', null],
    ['history', 'History', (c.releases || []).length],
    ['skipped', 'Skipped', s.skipped],
    ['removed', 'Removed', s.removed],
    ['setup', 'Setup', null],
  ];

  return (
    <Layout
      title={c.name}
      subtitle={<>
        {c.fileName || 'spreadsheet'} · {s.total.toLocaleString()} rows · template “{app.templates[c.templateKey]?.name || c.templateKey}”
        {lastUpdated && error && <span style={{ color: 'var(--amber)' }}> · last updated {fromNow(new Date(lastUpdated).toISOString())}</span>}
      </>}
      actions={<>
        <Link to="/campaigns" className="btn btn-sm"><i className="ti ti-arrow-left" /> All campaigns</Link>
        {c.status === 'running' && (
          <button className="btn btn-sm" type="button" disabled={busy} onClick={runNow}>
            <i className="ti ti-player-track-next" /> Run now
          </button>
        )}
        {c.status === 'running'
          ? <button className="btn" type="button" disabled={busy} onClick={pause}>
              <i className="ti ti-player-pause" /> Pause
            </button>
          : (c.status === 'paused' || c.status === 'failed') && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={resume}>
              <i className="ti ti-player-play" /> Continue
            </button>
          )}
      </>}
    >
      {c.status === 'paused' && (
        <div className="info-box" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', marginBottom: 14 }}>
          <i className="ti ti-player-pause" />
          <span>
            Paused {fromNow(c.pausedAt)}. No new contacts will be released. Any batch already sending finishes on its own.
          </span>
        </div>
      )}
      {c.status === 'failed' && c.lastError && (
        <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)', marginBottom: 14 }}>
          <i className="ti ti-alert-triangle" />
          <span><strong>The last release didn't work.</strong> {c.lastError}</span>
        </div>
      )}
      {c.status === 'completed' && (
        <div className="info-box" style={{ background: 'var(--green-bg)', color: 'var(--green)', marginBottom: 14 }}>
          <i className="ti ti-circle-check" />
          <span>
            Finished {fromNow(c.completedAt)} — {s.released.toLocaleString()} released,{' '}
            {s.skipped.toLocaleString()} skipped.
          </span>
        </div>
      )}

      <div className="stat-grid cmp-detail-stats">
        <div className="stat-card">
          <div className="stat-label">Released</div>
          <div className="stat-value">
            {s.released.toLocaleString()}
            <span style={{ fontSize: 14, color: 'var(--text3)' }}> / {s.total.toLocaleString()}</span>
          </div>
          <div className="stat-sub">{s.pending.toLocaleString()} still queued</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sent</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>{jobTotals.sent.toLocaleString()}</div>
          <div className="stat-sub">{jobTotals.failed} failed · recent batches</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Bounced</div>
          <div className="stat-value" style={{ color: bounceLevel }}>
            {o.bounced.toLocaleString()}
            {o.total > 0 && <span className="stat-of"> · {bouncePct}%</span>}
          </div>
          <div className="stat-sub">
            {o.total === 0
              ? 'nothing sent yet'
              : bouncePct >= 4
                ? 'high — check list quality'
                : 'of everyone emailed'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Replied</div>
          <div className="stat-value" style={{ color: o.replied > 0 ? 'var(--teal)' : undefined }}>
            {o.replied.toLocaleString()}
            {o.total > 0 && <span className="stat-of"> · {replyPct}%</span>}
          </div>
          <div className="stat-sub">
            {o.failed > 0 ? `${o.failed} failed to send` : 'of everyone emailed'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Last batch</div>
          {lastBatch ? (
            <>
              <div className="stat-value" style={{ fontSize: 22 }}>
                {lastJob
                  ? <>{lastJob.sent.toLocaleString()}<span style={{ fontSize: 14, color: 'var(--text3)' }}> / {lastBatch.released}</span></>
                  : lastBatch.released.toLocaleString()}
              </div>
              <div className="stat-sub">
                {fromNow(lastBatch.finishedAt || c.lastReleaseAt)}
                {lastBatchState && <> · <span style={{ color: lastBatchState.color }}>{lastBatchState.text}</span></>}
              </div>
            </>
          ) : (
            <>
              <div className="stat-value" style={{ fontSize: 22, color: 'var(--text3)' }}>—</div>
              <div className="stat-sub">no batch has run yet</div>
            </>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Next batch</div>
          {overdue ? (
            <>
              <div className="stat-value" style={{ fontSize: 20, color: 'var(--amber)' }}>due now</div>
              <div className="stat-sub">waiting {fmtCountdown(Date.now() - overdue.getTime())} for a trigger</div>
            </>
          ) : next ? (
            <>
              <div className="stat-value" style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>
                {fmtCountdown(countdownMs)}
              </div>
              <div className="stat-sub">{fmtIst(next)}</div>
            </>
          ) : (
            <>
              <div className="stat-value" style={{ fontSize: 18 }}>
                <span className={`badge ${CAMPAIGN_STATUS_BADGE[c.status]}`}>{CAMPAIGN_STATUS_LABEL[c.status]}</span>
              </div>
              <div className="stat-sub">
                {c.status === 'running' && s.pending > 0
                  ? `about ${daysRemaining(c)} days to go`
                  : `last release ${fromNow(c.lastReleaseAt)}`}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="progress-bar" style={{ marginTop: 14 }}>
        <div className="progress-fill" style={{ width: `${pct(handled, s.total)}%` }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
        {c.contactsPerDay}/day at {c.ratePerHour}/hour from {fmtHour(c.runHourIst)} IST — each batch takes about{' '}
        {dripDuration(c.contactsPerDay, c.ratePerHour)}
        {c.attachResume && <> · <i className="ti ti-paperclip" /> resume attached</>}
      </div>

      <div style={{ marginTop: 14 }}>
        <NextRunPanel campaign={c} cronConfigured={meta?.cronConfigured} />
      </div>

      <div className="section-head" style={{ marginTop: 18 }}>
        <div className="nav-tabs">
          {TABS.map(([key, label, count]) => (
            <div key={key} className={`nav-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {label}
              {count !== null && count > 0 && (
                <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{count}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {tab === 'upcoming' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <button type="button"
              className={`btn btn-sm${upcomingView === 'batch' ? ' btn-primary' : ''}`}
              onClick={() => setUpcomingView('batch')}>
              <i className="ti ti-users" /> Next batch
            </button>
            <button type="button"
              className={`btn btn-sm${upcomingView === 'schedule' ? ' btn-primary' : ''}`}
              onClick={() => setUpcomingView('schedule')}>
              <i className="ti ti-calendar-repeat" /> Full schedule
              {s.pending > 0 && (
                <span style={{ marginLeft: 5, opacity: 0.7 }}>{totalBatches(c)}</span>
              )}
            </button>
          </div>
          {upcomingView === 'batch'
            ? <UpcomingBatchTable campaign={c} onChanged={refresh} />
            : <UpcomingSchedule campaign={c} />}
        </>
      )}
      {tab === 'history' && <BatchHistoryList campaign={c} jobSummaries={data.jobSummaries} />}
      {tab === 'skipped' && <SkippedRowsPanel campaign={c} status="skipped" onChanged={refresh} />}
      {tab === 'removed' && <SkippedRowsPanel campaign={c} status="removed" onChanged={refresh} />}
      {tab === 'setup' && (
        <div className="cmp-setup">
          <section className="cmp-setup-block">
            <h3 className="cmp-setup-title">Name</h3>
            <p className="cmp-setup-hint">
              What this campaign is called in the list and in its history. Renaming is safe — it
              changes nothing about who gets emailed.
            </p>
            <div className="form-group" style={{ maxWidth: 420 }}>
              {/* Keyed on the server value so a rejected rename snaps back rather
                  than leaving text on screen that was never saved. */}
              <input key={`name-${c.name}`} defaultValue={c.name} disabled={busy}
                placeholder="Campaign name"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== c.name) save({ name: v });
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </div>
          </section>

          <section className="cmp-setup-block">
            <h3 className="cmp-setup-title">Schedule</h3>
            <p className="cmp-setup-hint">
              How fast the sheet is worked through, and when each day's batch starts.
            </p>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Contacts per day</label>
                {/* Keyed on the server value so a rejected edit snaps back
                    instead of leaving an invalid number on screen. */}
                <input key={`cpd-${c.contactsPerDay}`} type="number" min={1} max={500}
                  defaultValue={c.contactsPerDay} disabled={busy}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== c.contactsPerDay) save({ contactsPerDay: v });
                  }} />
              </div>
              <div className="form-group">
                <label className="form-label">Emails per hour</label>
                <input key={`rph-${c.ratePerHour}`} type="number" min={1} max={60}
                  defaultValue={c.ratePerHour} disabled={busy}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== c.ratePerHour) save({ ratePerHour: v });
                  }} />
              </div>
              <div className="form-group">
                <label className="form-label">Send each day at (IST)</label>
                <select value={c.runHourIst} disabled={busy}
                  onChange={(e) => save({ runHourIst: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
              </div>
            </div>
            <div className="info-box" style={{ marginTop: 12 }}>
              <i className="ti ti-clock" />
              <span>
                {c.contactsPerDay}/day at {c.ratePerHour}/hour from {fmtHour(c.runHourIst)} — each batch
                takes about <strong>{dripDuration(c.contactsPerDay, c.ratePerHour)}</strong>.
                {s.pending > 0 && <> {s.pending.toLocaleString()} left, about <strong>{daysRemaining(c)} days</strong> to go.</>}
              </span>
            </div>
          </section>

          <section className="cmp-setup-block">
            <h3 className="cmp-setup-title">Content</h3>
            <p className="cmp-setup-hint">What every contact in this campaign receives.</p>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Template</label>
                <select value={c.templateKey} disabled={busy || !templatesLoaded}
                  onChange={(e) => save({ templateKey: e.target.value })}>
                  {!templatesLoaded && <option value={c.templateKey}>Loading templates…</option>}
                  {templatesLoaded && !app.templates[c.templateKey] && (
                    <option value={c.templateKey}>{c.templateKey} (no longer exists)</option>
                  )}
                  {Object.values(app.templates).map((t) => (
                    <option key={t.key} value={t.key}>{t.name}</option>
                  ))}
                </select>
                {templatesLoaded && !app.templates[c.templateKey] && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
                    This template has been deleted — pick another or the next batch will fail.
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Resume</label>
                <label className="cmp-check">
                  <input type="checkbox" checked={c.attachResume} disabled={busy}
                    onChange={(e) => save({ attachResume: e.target.checked })} />
                  Attach the resume from Settings to every email
                </label>
              </div>
            </div>
          </section>

          <section className="cmp-setup-block">
            <h3 className="cmp-setup-title">Source</h3>
            <p className="cmp-setup-hint">
              {c.fileName || 'The uploaded spreadsheet'} · {s.total.toLocaleString()} rows.
              The mapping is fixed once rows are uploaded — create a new campaign to remap.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {c.sourceColumns.length > 0
                ? c.sourceColumns.map((h, i) => <span key={i} className="var-pill">{h}</span>)
                : <span style={{ fontSize: 12, color: 'var(--text3)' }}>No columns recorded.</span>}
            </div>
          </section>

          <section className="cmp-setup-block cmp-danger">
            <h3 className="cmp-setup-title" style={{ color: 'var(--red)' }}>Danger zone</h3>
            <p className="cmp-setup-hint">
              Deleting stops all future releases. Contacts already emailed are kept, and their
              history stays intact.
            </p>
            <button className="btn btn-sm btn-danger" type="button" disabled={busy} onClick={remove}>
              <i className="ti ti-trash" /> Delete campaign
            </button>
          </section>
        </div>
      )}
    </Layout>
  );
}
