import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Muted } from './ui';
import { PlatformTag } from './platform';
import { fmtAgo } from '../dashboard/format';
import { activityApi, type ActivityEvent, type ActivityRun, type ActivityType, type PlatformId } from '../../lib/api';

// What is happening in your job platforms, newest first: applications sent,
// recruiter movement on them, approvals, and the runs going on right now.
// Read-only; refreshes itself while open.

const TYPES: { key: ActivityType; label: string; icon: string; color: string }[] = [
  { key: 'applied', label: 'Applied', icon: 'ti-send', color: 'var(--green, #16a34a)' },
  { key: 'recruiter', label: 'Recruiter', icon: 'ti-user-check', color: 'var(--accent, #6366f1)' },
  { key: 'approved', label: 'Approved', icon: 'ti-check', color: 'var(--text2)' },
  { key: 'skipped', label: 'Skipped', icon: 'ti-player-skip-forward', color: 'var(--text2)' },
  { key: 'failed', label: 'Failed', icon: 'ti-alert-triangle', color: 'var(--red, #dc2626)' },
];
const META = Object.fromEntries(TYPES.map(t => [t.key, t])) as Record<ActivityType, typeof TYPES[number]>;
const PLATFORMS: PlatformId[] = ['naukri', 'instahyre', 'hirist', 'cutshort', 'wellfound'];
const KIND: Record<string, string> = { apply: 'Applying', harvest: 'Finding jobs', track: 'Checking recruiter replies', refresh: 'Refreshing profile', probe: 'Checking login' };

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

function headline(e: ActivityEvent) {
  switch (e.type) {
    case 'applied': return 'Applied';
    case 'recruiter': return e.note || 'Recruiter update';
    case 'approved': return 'Approved to apply';
    case 'skipped': return 'Skipped';
    default: return 'Could not apply';
  }
}

function RunLine({ r }: { r: ActivityRun }) {
  const p = r.progress;
  const working = r.status === 'running';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <i className={`ti ${working ? 'ti-loader-2' : 'ti-clock'}`} style={{ color: 'var(--accent, #6366f1)' }} />
      <PlatformTag id={r.platform} />
      <strong style={{ fontSize: 13 }}>{working ? KIND[r.kind] || r.kind : `${KIND[r.kind] || r.kind} — waiting for the worker`}</strong>
      {r.dryRun && <span className="badge">rehearsal</span>}
      {working && p && (
        <Muted>
          {p.label ? `${p.label} · ` : ''}
          {r.kind === 'apply' ? `${p.applied} applied · ${p.skipped} skipped · ${p.failed} failed` : `${p.found} found · ${p.new} new`}
        </Muted>
      )}
    </div>
  );
}

export default function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [live, setLive] = useState<ActivityRun[]>([]);
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const [days, setDays] = useState(3);
  const [types, setTypes] = useState<Set<ActivityType>>(new Set());
  const [platform, setPlatform] = useState<PlatformId | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<number | null>(null);
  const [limit, setLimit] = useState(100);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await activityApi({ days, limit, types: [...types].join(',') });
      setEvents(r.events); setTotal(r.total); setLive(r.live); setRuns(r.runs); setError(''); setUpdated(Date.now());
    } catch (e: any) { setError(e?.message || 'Could not load activity'); }
    finally { setLoading(false); }
  }, [days, types, limit]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  // Faster while something is running, slower otherwise; paused in a hidden tab.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, live.length ? 8000 : 30000);
    return () => clearInterval(id);
  }, [load, live.length]);

  const shown = useMemo(() => events.filter(e => !platform || e.platform === platform), [events, platform]);
  const liveShown = live.filter(r => !platform || r.platform === platform);
  const days_ = useMemo(() => {
    const out: { label: string; rows: ActivityEvent[] }[] = [];
    for (const e of shown) {
      const label = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(e); else out.push({ label, rows: [e] });
    }
    return out;
  }, [shown]);
  const toggle = (t: ActivityType) => setTypes(prev => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        {TYPES.map(t => (
          <button key={t.key} type="button" className={`btn btn-sm${types.has(t.key) ? ' btn-primary' : ''}`} onClick={() => toggle(t.key)}>
            <i className={`ti ${t.icon}`} /> {t.label}
          </button>
        ))}
        <select value={platform} onChange={e => setPlatform(e.target.value as PlatformId | '')} style={{ maxWidth: 160 }} aria-label="Platform">
          <option value="">All platforms</option>
          {PLATFORMS.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ maxWidth: 140 }} aria-label="Period">
          <option value={1}>Last 24 hours</option><option value={3}>Last 3 days</option>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
        </select>
        <Muted>{updated ? `updated ${fmtAgo(updated)}` : ''}</Muted>
      </div>

      {error && <div className="badge badge-failed" style={{ marginBottom: 10 }}>{error}</div>}

      {liveShown.length > 0 && (
        <div className="card" style={{ padding: '4px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, padding: '8px 0 2px', color: 'var(--text2)' }}>HAPPENING NOW</div>
          {liveShown.map(r => <RunLine key={r.id} r={r} />)}
        </div>
      )}

      {loading && events.length === 0 ? <Muted>Loading activity…</Muted> : shown.length === 0 ? (
        <Empty icon="ti-activity">Nothing in this period. Applications, recruiter replies and approvals show up here as they happen.</Empty>
      ) : days_.map(g => (
        <div key={g.label} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            {g.label.toUpperCase()} · {g.rows.length}
          </div>
          {g.rows.map((e, i) => {
            const m = META[e.type];
            return (
              <div key={`${e.jobId}-${e.type}-${e.at}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <i className={`ti ${m.icon}`} style={{ color: m.color, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{headline(e)}</strong>
                    <span style={{ fontSize: 13 }}>{e.title}{e.company ? ` · ${e.company}` : ''}</span>
                    <PlatformTag id={e.platform} />
                    {e.aiMessage && <span className="badge" title="A message written for this job from your resume">AI message</span>}
                  </div>
                  {e.note && e.type !== 'recruiter' && (
                    <Muted>{e.note.length > 200 ? `${e.note.slice(0, 200)}…` : e.note}</Muted>
                  )}
                </div>
                <Muted>{new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</Muted>
                {e.url && <a href={e.url} target="_blank" rel="noreferrer" title="Open on the site"><i className="ti ti-external-link" /></a>}
              </div>
            );
          })}
        </div>
      ))}

      {total > events.length && (
        <button className="btn btn-sm" type="button" onClick={() => setLimit(l => Math.min(300, l + 100))} disabled={limit >= 300}>
          Show more ({events.length} of {total})
        </button>
      )}

      {runs.length > 0 && !platform && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', padding: '4px 0' }}>RECENT RUNS</div>
          {runs.slice(0, 8).map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '5px 0', fontSize: 13 }}>
              <PlatformTag id={r.platform} /><span>{KIND[r.kind] || r.kind}</span>
              {r.status === 'failed' && <span className="badge badge-failed">failed</span>}
              {r.stats && <Muted>{r.kind === 'apply' ? `${r.stats.applied} applied · ${r.stats.skipped} skipped · ${r.stats.failed} failed` : `${r.stats.found} found · ${r.stats.new} new`}</Muted>}
              <Muted>{fmtAgo(r.at)}</Muted>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
