import { useCallback, useEffect, useState } from 'react';
import type { NaukriOverview, NaukriRunKind } from '../lib/api';
import { naukriOverviewApi, naukriConfigApi, queueNaukriRunApi, cancelNaukriRunApi } from '../lib/api';
import type { NaukriConfig } from '../lib/api';
import StatusHeader, { readiness } from '../components/naukri/StatusHeader';
import RunTimeline, { ActiveRun } from '../components/naukri/RunTimeline';
import ScheduleCard from '../components/naukri/config/ScheduleCard';
import ConnectionCard from '../components/naukri/config/ConnectionCard';
import SearchesCard from '../components/naukri/config/SearchesCard';
import FiltersCard from '../components/naukri/config/FiltersCard';
import ProfileCard from '../components/naukri/config/ProfileCard';
import AnswerBank from '../components/naukri/config/AnswerBank';
import ResumeCard from '../components/naukri/config/ResumeCard';
import ApplyCard from '../components/naukri/config/ApplyCard';
import ReviewQueue from '../components/naukri/ReviewQueue';
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

type View = 'activity' | 'review' | 'applied' | 'config';

export default function Naukri() {
  const [overview, setOverview] = useState<NaukriOverview | null>(null);
  const [config, setConfig] = useState<NaukriConfig | null>(null);
  const [view, setView] = useState<View>('activity');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await naukriOverviewApi());
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the Naukri panel');
    }
  }, []);

  // The config is NOT polled. It is a form the user is typing into; refetching
  // it every three seconds would fight them for the cursor.
  const loadConfig = useCallback(async () => {
    try { setConfig((await naukriConfigApi()).config); } catch { /* cards render from cache */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => { if (view === 'config' && !config) loadConfig(); }, [view, config, loadConfig]);

  const start = async (kind: NaukriRunKind) => {
    setBusy(true);
    try { await queueNaukriRunApi(kind); await load(); }
    catch (e: any) { setError(e?.message || `Could not start the ${kind} run`); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try { await cancelNaukriRunApi(id); await load(); }
    catch (e: any) { setError(e?.message || 'Could not cancel'); }
    finally { setBusy(false); }
  };

  if (!overview) {
    return (
      <div className="page">
        <h1 className="page-title">Naukri</h1>
        <div className="page-info">{error || 'Loading…'}</div>
      </div>
    );
  }

  const r = readiness(overview);
  const canStart = r.canRun && !busy;

  const TABS: Array<[View, string, number | null]> = [
    ['activity', 'Activity', null],
    ['review', 'Review', overview.reviewCount || null],
    ['applied', 'Applied', overview.appliedCount || null],
    ['config', 'Configuration', null],
  ];

  return (
    <div className="page">
      <h1 className="page-title">Naukri</h1>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(([key, label, count]) => (
          <button
            key={key} onClick={() => setView(key)}
            className={`btn btn-sm${view === key ? ' btn-primary' : ''}`}
          >
            {label}{count ? ` · ${count}` : ''}
          </button>
        ))}
      </div>

      <StatusHeader overview={overview} />

      {error && (
        <div className="card" style={{ padding: 10, marginBottom: 14, fontSize: 13, color: 'var(--danger, #dc2626)' }}>
          {error}
        </div>
      )}

      {view === 'activity' && (
        <>
          <section className="card" style={{ padding: 14, marginBottom: 14 }}>
            <div className="page-info" style={{ marginBottom: 8, letterSpacing: '.06em' }}>NOW</div>
            {overview.activeRun
              ? <ActiveRun run={overview.activeRun} />
              : <div className="page-info">Nothing running.</div>}
          </section>

          <section className="card" style={{ padding: 14, marginBottom: 14 }}>
            <div className="page-info" style={{ marginBottom: 8, letterSpacing: '.06em' }}>NEXT</div>

            {overview.schedule.enabled && overview.nextOccurrence ? (
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                {overview.scheduleKinds.join(' + ') || 'nothing'} · {fmtTime(overview.nextOccurrence)}
              </div>
            ) : (
              <div className="page-info" style={{ marginBottom: 8 }}>
                No schedule. Set one in Configuration.
              </div>
            )}

            {overview.queuedRuns.map(run => (
              <div key={run.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, padding: '3px 0' }}>
                <span className="badge badge-queued">queued</span>
                <span>{run.kind}</span>
                <button className="btn btn-sm" onClick={() => cancel(run.id)} disabled={busy}>Cancel</button>
              </div>
            ))}

            {overview.reviewCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', fontSize: 13 }}>
                <i className="ti ti-alert-triangle" style={{ color: 'var(--warn, #d97706)' }} />
                <span>{overview.reviewCount} job{overview.reviewCount === 1 ? '' : 's'} awaiting your review</span>
                <button className="btn btn-sm btn-primary" onClick={() => setView('review')}>Review</button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => start('refresh')} disabled={!canStart}>Refresh now</button>
              <button className="btn btn-sm" onClick={() => start('harvest')} disabled={!canStart}>Harvest now</button>
              <button className="btn btn-sm" onClick={() => start('apply')} disabled={!canStart}>Apply now</button>
            </div>
            {!r.canRun && (
              <div className="page-info" style={{ fontSize: 12, marginTop: 6 }}>
                Nothing can start until the problem above is fixed.
              </div>
            )}
          </section>

          <section className="card" style={{ padding: 14 }}>
            <div className="page-info" style={{ marginBottom: 8, letterSpacing: '.06em' }}>PAST</div>
            <RunTimeline runs={overview.history} />
          </section>
        </>
      )}

      {view === 'config' && (
        <>
          <ConnectionCard overview={overview} onChanged={load} />
          <ScheduleCard
            schedule={overview.schedule}
            nextOccurrence={overview.nextOccurrence}
            onSaved={load}
          />
          {config ? (
            <>
              <SearchesCard config={config} onSaved={load} />
              <FiltersCard config={config} onSaved={load} />
              <ProfileCard config={config} onSaved={load} />
              <AnswerBank config={config} onSaved={load} />
              <ResumeCard config={config} onSaved={load} />
              <ApplyCard config={config} onSaved={load} />
            </>
          ) : (
            <div className="card" style={{ padding: 14 }}><span className="page-info">Loading configuration…</span></div>
          )}

        </>
      )}

      {view === 'review' && <ReviewQueue onChanged={load} />}

      {view === 'applied' && (
        <div className="card" style={{ padding: 14 }}>
          <div className="page-info">
            {overview.appliedCount} application(s) recorded. This board lands with the apply driver.
          </div>
        </div>
      )}
    </div>
  );
}
