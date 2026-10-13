import { useCallback, useEffect, useState } from 'react';
import {
  runSourceApi, saveSourcesConfigApi, sourceRunsApi, sourcesConfigApi,
  type SourceRun, type SourcesConfig, type SourcesConfigView,
} from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';

// The automatic Leads sources beyond the LinkedIn harvester: the hiring-post finder
// (public posts with an email, found with your own Tavily key) and HN "Who is
// hiring?". Both are off until you turn them on, and both only ADD rows to this
// board — nothing is emailed until you move a lead to outreach yourself.

const POLL_MS = 4000;
const RUNS_SHOWN = 5;

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

function runLine(r: SourceRun): string {
  if (r.status === 'running') return 'Running now…';
  if (r.status === 'failed' && !r.read) return `Failed: ${r.error || 'unknown error'}`;
  const bits = [
    `${r.read} read`,
    `${r.withEmail} with email`,
    `${r.created} new lead${r.created !== 1 ? 's' : ''}`,
  ];
  if (r.duplicates) bits.push(`${r.duplicates} already here`);
  if (r.rejected) bits.push(`${r.rejected} not for you`);
  if (r.credits) bits.push(`${r.credits} credit${r.credits !== 1 ? 's' : ''}`);
  return bits.join(' · ');
}

function RunHistory({ runs }: { runs: SourceRun[] }) {
  if (!runs.length) return <div className="src-last">Not run yet.</div>;
  const [last, ...rest] = runs;
  return (
    <>
      <div className="src-last">
        <strong>Last run {fmtWhen(last.startedAt)}</strong>{last.trigger === 'manual' ? ' (you)' : ''}
        {last.label ? ` · ${last.label}` : ''}
        <br />{runLine(last)}
        {last.status === 'failed' && last.read > 0 && last.error ? <><br /><span style={{ color: 'var(--red)' }}>{last.error}</span></> : null}
      </div>
      {rest.length > 0 && (
        <ul className="src-runs">
          {rest.slice(0, RUNS_SHOWN - 1).map(r => (
            <li key={r.id}><span>{fmtWhen(r.startedAt)}</span><span>{runLine(r)}</span></li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function SourcesPanel({ open, onImported }: { open: boolean; onImported: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<SourcesConfigView | null>(null);
  const [runs, setRuns] = useState<{ web: SourceRun[]; hn: SourceRun[] }>({ web: [], hn: [] });
  const [draft, setDraft] = useState({ roles: '', locations: '', maxYears: '' });
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<'web' | 'hn' | null>(null);
  const [error, setError] = useState('');

  const fill = (v: SourcesConfigView) => {
    setView(v);
    setDraft({
      roles: v.config.roles.join(', '),
      locations: v.config.locations.join(', '),
      maxYears: v.config.maxYears == null ? '' : String(v.config.maxYears),
    });
  };

  useEffect(() => {
    if (!open || view) return;
    sourcesConfigApi().then(fill).catch(err => setError(err.message));
  }, [open]);

  const running = runs.web[0]?.status === 'running' || runs.hn[0]?.status === 'running';

  const loadRuns = useCallback(async () => {
    try {
      const next = await sourceRunsApi();
      // A run just finished: its leads are on the board now.
      const finished = (['web', 'hn'] as const).some(s => runs[s][0]?.status === 'running' && next[s][0]?.status !== 'running');
      setRuns(next);
      if (finished) {
        onImported();
        // The run spent credits: refresh the Tavily count (not the target form,
        // which may hold unsaved typing).
        sourcesConfigApi().then(v => setView(v)).catch(() => { /* count refreshes on next open */ });
      }
    } catch { /* the panel still works without history */ }
  }, [runs, onImported]);

  // Poll quickly only while something is running; otherwise once on open.
  useVisibleInterval(loadRuns, POLL_MS, open && (running || starting !== null));
  useEffect(() => { if (open) loadRuns(); }, [open]);

  if (!open) return null;

  const save = async (patch: Partial<SourcesConfig>, okText?: string) => {
    setSaving(true);
    try {
      fill(await saveSourcesConfigApi(patch));
      if (okText) toast(okText, 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveTarget = () => save({
    roles: list(draft.roles),
    locations: list(draft.locations),
    maxYears: draft.maxYears.trim() === '' ? null : Number(draft.maxYears),
  }, 'Saved.');

  const runNow = async (source: 'web' | 'hn') => {
    setStarting(source);
    try {
      await runSourceApi(source);
      toast(source === 'web' ? 'Searching for hiring posts…' : 'Reading this month\'s HN thread…', 'info');
      setTimeout(() => { loadRuns(); setStarting(null); }, 1500);
    } catch (err: any) {
      toast(err.message, 'error');
      setStarting(null);
    }
  };

  if (error) return <div className="section" style={{ marginBottom: 18 }}><div className="info-box"><i className="ti ti-alert-triangle" /><span>{error}</span></div></div>;
  if (!view) return <div className="section" style={{ marginBottom: 18, color: 'var(--text3)' }}>Loading sources…</div>;

  const c = view.config;
  const targetChanged = draft.roles !== c.roles.join(', ') || draft.locations !== c.locations.join(', ')
    || draft.maxYears !== (c.maxYears == null ? '' : String(c.maxYears));
  const webRunning = runs.web[0]?.status === 'running' || starting === 'web';
  const hnRunning = runs.hn[0]?.status === 'running' || starting === 'hn';

  return (
    <div className="section" style={{ marginBottom: 18 }}>
      <div className="section-head">
        <span className="section-title">More lead sources</span>
      </div>
      <div className="uz-sub" style={{ marginBottom: 12 }}>
        Real emails people posted themselves, so they don't bounce like guesses. New leads land on this board
        for you to review; nothing is emailed until you move them to outreach. Paste text is under <strong>Import leads</strong>.
      </div>

      <div className="src-target">
        <label className="form-group" style={{ margin: 0 }}>
          <span className="form-label">Roles you want</span>
          <input type="text" value={draft.roles} placeholder="React developer, Frontend engineer"
            onChange={e => setDraft(d => ({ ...d, roles: e.target.value }))} />
        </label>
        <label className="form-group" style={{ margin: 0 }}>
          <span className="form-label">Locations</span>
          <input type="text" value={draft.locations} placeholder="india, remote"
            onChange={e => setDraft(d => ({ ...d, locations: e.target.value }))} />
        </label>
        <label className="form-group" style={{ margin: 0 }}>
          <span className="form-label">Your years of experience (max asked)</span>
          <input type="number" min={0} max={40} value={draft.maxYears} placeholder="no limit"
            onChange={e => setDraft(d => ({ ...d, maxYears: e.target.value }))} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button" disabled={!targetChanged || saving} onClick={saveTarget}>
          <i className="ti ti-device-floppy" /> Save target
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
          Used to score every source. "remote" keeps remote jobs open to India; "india" covers Indian cities.
        </span>
      </div>

      <div className="src-cards">
        <div className="src-card">
          <div className="src-card-head">
            <span className="src-card-title"><i className="ti ti-world-search" /> Hiring posts</span>
            <label className="src-toggle">
              <input type="checkbox" checked={c.webOn} disabled={saving || (!c.webOn && (!view.hasSearchKey || !c.roles.length))}
                onChange={e => save({ webOn: e.target.checked }, e.target.checked ? 'Hiring posts on — runs daily at 8:00 AM.' : 'Hiring posts off.')} />
              {c.webOn ? 'On, daily 8:00 AM' : 'Off'}
            </label>
          </div>
          <div className="src-card-sub">
            Searches public LinkedIn, X and Reddit posts from the last week for "share your resume at …" and keeps the ones
            with an email. LinkedIn itself is never opened.
          </div>
          {!view.hasSearchKey && (
            <div className="src-last" style={{ color: 'var(--orange, var(--text2))' }}>
              <i className="ti ti-key" /> Needs your free Tavily key — add it in Settings → “Discover — free services”.
            </div>
          )}
          {view.hasSearchKey && !c.roles.length && (
            <div className="src-last"><i className="ti ti-info-circle" /> Add the roles you want above first.</div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <label className="src-toggle">
              Searches a day
              <select value={c.webPerDay} disabled={saving} onChange={e => save({ webPerDay: Number(e.target.value) })}>
                {[2, 4, 6, 8, 10, 15, 20].filter(n => n <= view.maxPerDay).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
              Tavily this month: {view.tavily.used}/{view.tavily.cap} (shared with Discover)
            </span>
          </div>
          <button className="btn btn-sm" type="button" style={{ marginTop: 10 }}
            disabled={webRunning || !view.hasSearchKey || !c.roles.length} onClick={() => runNow('web')}>
            <i className={webRunning ? 'ti ti-loader-2 tc-spin' : 'ti ti-player-play'} /> {webRunning ? 'Running…' : `Run now (${c.webPerDay} credits)`}
          </button>
          <RunHistory runs={runs.web} />
        </div>

        <div className="src-card">
          <div className="src-card-head">
            <span className="src-card-title"><i className="ti ti-brand-ycombinator" /> HN "Who is hiring?"</span>
            <label className="src-toggle">
              <input type="checkbox" checked={c.hnOn} disabled={saving}
                onChange={e => save({ hnOn: e.target.checked }, e.target.checked ? 'HN on — reads the thread daily on the 1st–10th.' : 'HN off.')} />
              {c.hnOn ? 'On, 1st–10th monthly' : 'Off'}
            </label>
          </div>
          <div className="src-card-sub">
            The monthly Hacker News thread where companies post their own jobs, often with a founder's email. Free, no key.
            Only posts open to your locations are kept — on HN a bare "Remote" usually means US-only, so it needs "remote
            anywhere" or one of your places. Posts with only an apply link show under <strong>Direct apply</strong>.
          </div>
          <button className="btn btn-sm" type="button" style={{ marginTop: 10 }}
            disabled={hnRunning} onClick={() => runNow('hn')}>
            <i className={hnRunning ? 'ti ti-loader-2 tc-spin' : 'ti ti-player-play'} /> {hnRunning ? 'Running…' : 'Run now (free)'}
          </button>
          <RunHistory runs={runs.hn} />
        </div>
      </div>
    </div>
  );
}
