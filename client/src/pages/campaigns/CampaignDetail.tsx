import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import UpcomingBatchTable from '../../components/campaigns/UpcomingBatchTable';
import BatchHistoryList from '../../components/campaigns/BatchHistoryList';
import SkippedRowsPanel from '../../components/campaigns/SkippedRowsPanel';
import NextRunPanel from '../../components/campaigns/NextRunPanel';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { useCampaignPoll } from '../../hooks/useCampaignPoll';
import {
  deleteCampaignApi, loadCampaignMetaApi, pauseCampaignApi, resumeCampaignApi,
  runCampaignNowApi, updateCampaignApi, type CampaignMeta,
} from '../../lib/api';
import {
  CAMPAIGN_STATUS_BADGE, CAMPAIGN_STATUS_LABEL, daysRemaining, dripDuration,
  fmtCountdown, fmtHour, fmtIst, fromNow, nextRunAt, pct,
} from '../../lib/campaigns';

type Tab = 'upcoming' | 'history' | 'skipped' | 'removed' | 'setup';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, refresh, lastUpdated } = useCampaignPoll(id);
  const [tab, setTab] = useState<Tab>('upcoming');
  const [busy, setBusy] = useState(false);
  // Without this, the page shows a precise countdown for a release that can
  // never fire, which is worse than showing nothing.
  const [meta, setMeta] = useState<CampaignMeta | null>(null);
  useEffect(() => { loadCampaignMetaApi().then(setMeta).catch(() => {}); }, []);
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
  const countdownMs = next ? next.getTime() - Date.now() : 0;
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

  const runNow = () => act(async () => {
    const r = await runCampaignNowApi(c.id);
    if (!r.ok && r.reason === 'locked_or_already_released') {
      throw new Error("Today's batch has already gone out.");
    }
    if (r.error) throw new Error(r.error);
    toast(`Released ${r.released} contacts.`, 'success');
  }, 'Batch released.');

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

      <div className="stat-grid">
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
          <div className="stat-label">Skipped</div>
          <div className="stat-value">{s.skipped.toLocaleString()}</div>
          <div className="stat-sub">{s.removed.toLocaleString()} removed by you</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Next batch</div>
          {next ? (
            <>
              <div className="stat-value" style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>
                {countdownMs <= 0 ? 'due now' : fmtCountdown(countdownMs)}
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

      {tab === 'upcoming' && <UpcomingBatchTable campaign={c} onChanged={refresh} />}
      {tab === 'history' && <BatchHistoryList campaign={c} jobSummaries={data.jobSummaries} />}
      {tab === 'skipped' && <SkippedRowsPanel campaign={c} status="skipped" onChanged={refresh} />}
      {tab === 'removed' && <SkippedRowsPanel campaign={c} status="removed" onChanged={refresh} />}
      {tab === 'setup' && (
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Contacts per day</label>
            <input type="number" min={1} max={500} defaultValue={c.contactsPerDay} disabled={busy}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== c.contactsPerDay) save({ contactsPerDay: v });
              }} />
          </div>
          <div className="form-group">
            <label className="form-label">Emails per hour</label>
            <input type="number" min={1} max={60} defaultValue={c.ratePerHour} disabled={busy}
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
          <div className="form-group">
            <label className="form-label">Template</label>
            <select value={c.templateKey} disabled={busy}
              onChange={(e) => save({ templateKey: e.target.value })}>
              {Object.values(app.templates).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Attach resume</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={c.attachResume} disabled={busy}
                onChange={(e) => save({ attachResume: e.target.checked })} />
              Attach the resume from Settings
            </label>
          </div>
          <div className="form-group">
            <label className="form-label">Columns from your sheet</label>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
              {c.sourceColumns.length > 0
                ? c.sourceColumns.map((h, i) => <span key={i} className="var-pill" style={{ marginRight: 4 }}>{h}</span>)
                : '—'}
              <div style={{ marginTop: 6, color: 'var(--text3)' }}>
                The mapping is fixed once rows are uploaded — create a new campaign to remap.
              </div>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Danger zone</label>
            <button className="btn btn-sm btn-danger" type="button" disabled={busy} onClick={remove}>
              <i className="ti ti-trash" /> Delete campaign
            </button>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              Contacts already emailed are kept — this only stops future releases.
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
