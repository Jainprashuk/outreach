import { useCallback, useEffect, useRef, useState } from 'react';
import type { NaukriOverview, NaukriRunKind, NaukriConfig, NaukriSources } from '../lib/api';
import { naukriOverviewApi, naukriConfigApi, queueNaukriRunApi, cancelNaukriRunApi } from '../lib/api';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import StatusHeader, { readiness } from '../components/naukri/StatusHeader';
import NaukriSetupGuide, { type NaukriGuideTab } from '../components/naukri/NaukriSetupGuide';
import RunTimeline, { ActiveRun } from '../components/naukri/RunTimeline';
import ReviewQueue from '../components/naukri/ReviewQueue';
import JobsTab, { type JobsView } from '../components/naukri/JobsTab';
import ConnectionCard from '../components/naukri/config/ConnectionCard';
import { useAdaptiveInterval } from '../hooks/useAdaptiveInterval';
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
// No run active or queued: nothing on the tab moves except a run the worker's
// schedule starts. Starting or cancelling one here reloads at once.
const IDLE_POLL_MS = 30_000;

// Four tabs, in the order of the flow: what is happening, what needs a
// decision, where every job stands, and how it is set up.
type View = 'activity' | 'review' | 'jobs' | 'config';

const TABS: Array<[View, string, string]> = [
  ['activity', 'Activity', 'ti-activity'],
  ['review', 'Inbox', 'ti-inbox'],
  ['jobs', 'Jobs', 'ti-briefcase'],
  ['config', 'Configuration', 'ti-settings'],
];

const KIND_LABEL: Record<string, string> = { refresh: 'refresh', harvest: 'harvest', apply: 'apply' };

// Harvest, with a choice of where to look for this one run. The tick marks the
// default from Configuration → Searches, which is what scheduled harvests use.
const SOURCE_CHOICES: Array<[string, string, NaukriSources]> = [
  ['searches', 'My searches', { searches: true, recommended: false }],
  ['recommended', 'Recommended jobs', { searches: false, recommended: true }],
  ['both', 'Both', { searches: true, recommended: true }],
];

function HarvestMenu({ defaults, disabled, onPick }: {
  defaults: NaukriSources | undefined; disabled: boolean; onPick: (s: NaukriSources) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const d = defaults || { searches: true, recommended: false };
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="btn btn-sm" type="button" onClick={() => setOpen(o => !o)} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open}>
        <i className="ti ti-download" /> Harvest <i className="ti ti-chevron-down" style={{ fontSize: 11 }} />
      </button>
      {open && (
        <span role="menu" style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: 190,
          background: 'var(--bg)', border: '1px solid var(--border-md)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', padding: 4, display: 'flex', flexDirection: 'column',
        }}>
          {SOURCE_CHOICES.map(([key, label, s]) => {
            const isDefault = s.searches === d.searches && s.recommended === d.recommended;
            return (
              <button key={key} type="button" role="menuitem" className="btn btn-sm"
                style={{ justifyContent: 'flex-start', border: 'none', background: 'transparent' }}
                onClick={() => { setOpen(false); onPick(s); }}>
                <i className={`ti ${isDefault ? 'ti-check' : 'ti-point'}`} style={{ width: 16 }} />
                {label}{isDefault && <span style={{ color: 'var(--text3)', marginLeft: 6 }}>default</span>}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}

export default function Naukri() {
  const [overview, setOverview] = useState<NaukriOverview | null>(null);
  const [config, setConfig] = useState<NaukriConfig | null>(null);
  const [guide, setGuide] = useState<NaukriGuideTab | null>(null);
  const [view, setView] = useState<View>('activity');
  const [jobsView, setJobsView] = useState<JobsView>('waiting');
  const openJobs = (v: JobsView) => { setJobsView(v); setView('jobs'); };
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

  const busyRun = !!overview && (!!overview.activeRun || overview.queuedRuns.length > 0);
  useAdaptiveInterval(load, { fastMs: POLL_MS, slowMs: IDLE_POLL_MS, fast: busyRun });

  useEffect(() => { if (view === 'config' && !config) loadConfig(); }, [view, config, loadConfig]);

  const KIND_TOAST: Record<string, string> = {
    refresh: 'Refresh queued — your profile will be re-saved on the next worker poll.',
    harvest: 'Harvest queued — new listings will land in the Inbox.',
    apply: 'Apply run queued — approved jobs go out on the next worker poll.',
    probe: 'Probe queued.',
  };

  const start = async (kind: NaukriRunKind, sources?: NaukriSources) => {
    setBusy(true);
    try {
      await queueNaukriRunApi(kind, sources ? { sources } : {});
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
      <Layout title="Naukri" subtitle="Auto-apply worker"
        actions={<button className="btn btn-sm" type="button" onClick={() => setGuide('how')}><i className="ti ti-book" /> Guide</button>}>
        <Empty icon="ti-loader">{error || 'Loading…'}</Empty>
        {guide && <NaukriSetupGuide initialTab={guide} onClose={() => setGuide(null)} />}
      </Layout>
    );
  }

  const r = readiness(overview);
  const canStart = r.canRun && !busy;
  // The badge is what needs YOU: new jobs to decide, and questions to answer.
  const counts: Partial<Record<View, number>> = {
    review: overview.reviewCount,
    jobs: overview.needsAnswerCount,
  };
  const nextApply = (overview.upcoming || []).find(x => x.kinds.includes('apply'));

  const subtitle = [
    `${overview.reviewCount} in inbox`,
    `${overview.waitingCount} waiting`,
    `${overview.appliedToday}/${overview.perDay} applied today`,
    overview.schedule.enabled && overview.nextOccurrence ? `next ${fmtTime(overview.nextOccurrence)}` : 'no schedule',
  ].join(' · ');

  return (
    <Layout
      title="Naukri"
      subtitle={subtitle}
      actions={
        <>
          <button className="btn btn-sm" type="button" onClick={() => setGuide(overview.worker.everSeen ? 'how' : 'setup')}
            title="How the Naukri worker works and how to set it up">
            <i className="ti ti-book" /> Guide
          </button>
          <button className="btn btn-sm" type="button" onClick={() => start('refresh')} disabled={!canStart}>
            <i className="ti ti-refresh" /> Refresh
          </button>
          <HarvestMenu defaults={overview.sources} disabled={!canStart} onPick={s => start('harvest', s)} />
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

      <StatusHeader overview={overview} onHelp={() => setGuide('setup')} />

      {error && <Notice tone="danger" icon="ti-alert-triangle">{error}</Notice>}

      {view === 'activity' && (
        <>
          {/* The week in one line, each number a link to the list behind it. */}
          <Card>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
              <Band>This week</Band>
              <button className="btn btn-xs" type="button" onClick={() => openJobs('applied')}>
                <i className="ti ti-send" /> {overview.week.applied} applied
              </button>
              <button className="btn btn-xs" type="button" onClick={() => openJobs('skipped')}>
                <i className="ti ti-player-skip-forward" /> {overview.week.skipped} skipped
              </button>
              <button className={`btn btn-xs${overview.needsAnswerCount ? ' btn-primary' : ''}`} type="button" onClick={() => openJobs('answer')}>
                <i className="ti ti-help-circle" /> {overview.needsAnswerCount} need an answer
              </button>
              {overview.week.failed > 0 && <Muted>{overview.week.failed} failed — see Past below</Muted>}
            </div>
          </Card>

          <Card>
            <div style={{ marginBottom: 10 }}><Band>Now</Band></div>
            {overview.activeRun
              ? <ActiveRun run={overview.activeRun} />
              : <Muted>Nothing running.</Muted>}
          </Card>

          <Card>
            <div style={{ marginBottom: 10 }}><Band>Next</Band></div>

            {overview.schedule.enabled && overview.upcoming.length ? (
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                {overview.upcoming.slice(0, 3).map(o => (
                  <div key={o.at} style={{ padding: '2px 0' }}>
                    <i className="ti ti-clock" style={{ marginRight: 6, color: 'var(--text2)' }} />
                    {fmtTime(o.at)} · {o.kinds.map(k => KIND_LABEL[k] || k).join(' + ')}
                  </div>
                ))}
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
                <span>{overview.reviewCount} job{overview.reviewCount === 1 ? '' : 's'} in your inbox</span>
                <button className="btn btn-xs btn-primary" type="button" onClick={() => setView('review')}>Open inbox</button>
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
                  {overview.schedule.enabled && nextApply
                    ? ` — next apply run ${fmtTime(nextApply.at)}`
                    : ' — nothing will send these automatically'}
                </span>
                <button className="btn btn-xs" type="button" onClick={() => openJobs('waiting')}>See them</button>
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

      {view === 'jobs' && <JobsTab overview={overview} view={jobsView} onView={setJobsView} onChanged={load} />}

      {view === 'config' && (
        config ? (
          <>
            <ConnectionCard overview={overview} onChanged={load} />
            <ScheduleCard schedule={overview.schedule} upcoming={overview.upcoming} pollSeconds={config.worker?.pollSeconds ?? 20} onSaved={load} />
            <SearchesCard config={config} onSaved={load} />
            <FiltersCard config={config} onSaved={load} />
            <ProfileCard config={config} onSaved={load} />
            <AnswerBank config={config} onSaved={load} />
            <ResumeCard config={config} onSaved={load} />
            <ApplyCard config={config} onSaved={load} />
          </>
        ) : <Empty icon="ti-loader">Loading configuration…</Empty>
      )}
      {guide && <NaukriSetupGuide initialTab={guide} onClose={() => setGuide(null)} />}
    </Layout>
  );
}
