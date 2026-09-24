import { useCallback, useEffect, useState } from 'react';
import type { NaukriOverview, NaukriRunKind, NaukriConfig } from '../lib/api';
import { naukriOverviewApi, naukriConfigApi, queueNaukriRunApi, cancelNaukriRunApi } from '../lib/api';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import StatusHeader, { readiness } from '../components/naukri/StatusHeader';
import RunTimeline, { ActiveRun } from '../components/naukri/RunTimeline';
import ReviewQueue from '../components/naukri/ReviewQueue';
import AppliedTable from '../components/naukri/AppliedTable';
import QueuedJobs from '../components/naukri/QueuedJobs';
import ConnectionCard from '../components/naukri/config/ConnectionCard';
import ScheduleCard from '../components/naukri/config/ScheduleCard';
import SearchesCard from '../components/naukri/config/SearchesCard';
import FiltersCard from '../components/naukri/config/FiltersCard';
import ProfileCard from '../components/naukri/config/ProfileCard';
import AnswerBank from '../components/naukri/config/AnswerBank';
import ResumeCard from '../components/naukri/config/ResumeCard';
import ApplyCard from '../components/naukri/config/ApplyCard';
import { Card, Band, Muted, Notice, Empty } from '../components/naukri/ui';
import { fmtTime } from '../components/naukri/format';

// The Naukri tab.
//
// Laid out strictly as past / present / future, because the question you open it
// with is always one of three: what is happening, what do I need to do, what
// already happened. NOW / NEXT / PAST answers them in that order.
//
// One poll drives the whole screen (/api/naukri/overview) — the same "one call
// drives the panel" discipline the scrape status endpoint uses, so the tab never
// shows two half-refreshed views of the same moment.

const POLL_MS = 3000;

type View = 'activity' | 'review' | 'queued' | 'applied' | 'config';

const TABS: Array<[View, string, string]> = [
  ['activity', 'Activity', 'ti-activity'],
  ['review', 'Review', 'ti-checklist'],
  ['queued', 'Waiting', 'ti-hourglass'],
  ['applied', 'Applied', 'ti-send'],
  ['config', 'Configuration', 'ti-settings'],
];

export default function Naukri() {
  const [overview, setOverview] = useState<NaukriOverview | null>(null);
  const [config, setConfig] = useState<NaukriConfig | null>(null);
  const [view, setView] = useState<View>('activity');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try { setOverview(await naukriOverviewApi()); setError(''); }
    catch (e: any) { setError(e?.message || 'Could not load the Naukri panel'); }
  }, []);

  // The config is NOT polled. It is a form you are typing into; refetching it
  // every three seconds would fight you for the cursor.
  const loadConfig = useCallback(async () => {
    try { setConfig((await naukriConfigApi()).config); } catch { /* cards keep what they have */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => { if (view === 'config' && !config) loadConfig(); }, [view, config, loadConfig]);

  const KIND_TOAST: Record<string, string> = {
    refresh: 'Refresh queued — your profile will be re-saved on the next worker poll.',
    harvest: 'Harvest queued — new listings will land in Review.',
    apply: 'Apply run queued — approved jobs go out on the next worker poll.',
    probe: 'Probe queued.',
  };

  const start = async (kind: NaukriRunKind) => {
    setBusy(true);
    try {
      await queueNaukriRunApi(kind);
      // Queueing changes nothing visible until the worker polls, up to twenty
      // seconds later. Without a toast the button reads as broken.
      toast(KIND_TOAST[kind] || 'Run queued.', 'success');
      await load();
    } catch (e: any) {
      const m = e?.message || `Could not start the ${kind} run`;
      toast(m, 'error'); setError(m);
    } finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try { await cancelNaukriRunApi(id); toast('Run cancelled.', 'info'); await load(); }
    catch (e: any) {
      const m = e?.message || 'Could not cancel';
      toast(m, 'error'); setError(m);
    } finally { setBusy(false); }
  };

  if (!overview) {
    return (
      <Layout title="Naukri" subtitle="Auto-apply worker">
        <Empty icon="ti-loader">{error || 'Loading…'}</Empty>
      </Layout>
    );
  }

  const r = readiness(overview);
  const canStart = r.canRun && !busy;
  const counts: Partial<Record<View, number>> = {
    review: overview.reviewCount,
    queued: overview.waitingCount,
    applied: overview.appliedCount,
  };

  const subtitle = [
    `${overview.reviewCount} awaiting review`,
    `${overview.waitingCount} approved & waiting`,
    `${overview.appliedCount} applied`,
    `${overview.appliedToday} today`,
    overview.schedule.enabled && overview.nextOccurrence ? `next ${fmtTime(overview.nextOccurrence)}` : 'no schedule',
  ].join(' · ');

  return (
    <Layout
      title="Naukri"
      subtitle={subtitle}
      actions={
        <>
          <button className="btn btn-sm" type="button" onClick={() => start('refresh')} disabled={!canStart}>
            <i className="ti ti-refresh" /> Refresh
          </button>
          <button className="btn btn-sm" type="button" onClick={() => start('harvest')} disabled={!canStart}>
            <i className="ti ti-download" /> Harvest
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => start('apply')} disabled={!canStart}>
            <i className="ti ti-send" /> Apply
          </button>
        </>
      }
    >
      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label, icon]) => (
            <button key={key} type="button" onClick={() => setView(key)}
              className={`nav-tab${view === key ? ' active' : ''}`}>
              <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
              {counts[key] ? <span className="contact-count-badge" style={{ marginLeft: 6 }}>{counts[key]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <StatusHeader overview={overview} />

      {error && <Notice tone="danger" icon="ti-alert-triangle">{error}</Notice>}

      {view === 'activity' && (
        <>
          <Card>
            <div style={{ marginBottom: 10 }}><Band>Now</Band></div>
            {overview.activeRun
              ? <ActiveRun run={overview.activeRun} />
              : <Muted>Nothing running.</Muted>}
          </Card>

          <Card>
            <div style={{ marginBottom: 10 }}><Band>Next</Band></div>

            {overview.schedule.enabled && overview.nextOccurrence ? (
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                <i className="ti ti-clock" style={{ marginRight: 6, color: 'var(--text2)' }} />
                {overview.scheduleKinds.join(' + ') || 'nothing'} · {fmtTime(overview.nextOccurrence)}
              </div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                <Muted>No schedule.</Muted>{' '}
                <button className="btn btn-xs" type="button" onClick={() => setView('config')}>Set one</button>
              </div>
            )}

            {overview.queuedRuns.map(run => (
              <div key={run.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0' }}>
                <span className="badge badge-queued">queued</span>
                <span style={{ fontSize: 13 }}>{run.kind}</span>
                <button className="btn btn-xs" type="button" onClick={() => cancel(run.id)} disabled={busy}>Cancel</button>
              </div>
            ))}

            {overview.reviewCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13 }}>
                <i className="ti ti-alert-triangle" style={{ color: 'var(--red)' }} />
                <span>{overview.reviewCount} job{overview.reviewCount === 1 ? '' : 's'} awaiting your review</span>
                <button className="btn btn-xs btn-primary" type="button" onClick={() => setView('review')}>Review</button>
              </div>
            )}

            {/* Approved jobs sit between Review and Applied, and nothing used to
                show them. Worse, when the schedule has Apply switched off they
                wait forever — so this says which of those it is. */}
            {overview.waitingCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <i className="ti ti-hourglass" style={{ color: 'var(--text2)' }} />
                <span>
                  {overview.waitingCount} approved, waiting to be applied to
                  {overview.schedule.enabled && overview.schedule.runApply
                    ? ` — runs ${fmtTime(overview.nextOccurrence)}`
                    : ' — nothing will send these automatically'}
                </span>
                <button className="btn btn-xs" type="button" onClick={() => setView('queued')}>See them</button>
              </div>
            )}

            {!r.canRun && (
              <div style={{ marginTop: 10 }}>
                <Muted>Nothing can start until the problem above is fixed.</Muted>
              </div>
            )}
          </Card>

          <Card>
            <div style={{ marginBottom: 6 }}><Band>Past</Band></div>
            <RunTimeline runs={overview.history} />
          </Card>
        </>
      )}

      {view === 'review' && <ReviewQueue onChanged={load} />}

      {view === 'queued' && <QueuedJobs overview={overview} onChanged={load} />}

      {view === 'applied' && <AppliedTable onChanged={load} />}

      {view === 'config' && (
        config ? (
          <>
            <ConnectionCard overview={overview} onChanged={load} />
            <ScheduleCard schedule={overview.schedule} nextOccurrence={overview.nextOccurrence} onSaved={load} />
            <SearchesCard config={config} onSaved={load} />
            <FiltersCard config={config} onSaved={load} />
            <ProfileCard config={config} onSaved={load} />
            <AnswerBank config={config} onSaved={load} />
            <ResumeCard config={config} onSaved={load} />
            <ApplyCard config={config} onSaved={load} />
          </>
        ) : <Empty icon="ti-loader">Loading configuration…</Empty>
      )}
    </Layout>
  );
}
