import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Muted } from './ui';
import { PlatformTag } from './platform';
import { fmtAgo } from '../dashboard/format';
import { activityApi, type ActivityEvent, type ActivityType, type PlatformId } from '../../lib/api';

// What recruiters are doing on your jobs, across every platform, newest first:
// application viewed, resume viewed, shortlisted, contacted, not shortlisted.
// Read-only; refreshes itself while open.

const KINDS: { key: ActivityType; label: string; icon: string; color: string }[] = [
  { key: 'shortlisted', label: 'Shortlisted', icon: 'ti-star', color: 'var(--green, #16a34a)' },
  { key: 'contacted', label: 'Contacted you', icon: 'ti-message-circle', color: 'var(--accent, #6366f1)' },
  { key: 'viewed', label: 'Viewed', icon: 'ti-eye', color: 'var(--text2)' },
  { key: 'not-shortlisted', label: 'Not shortlisted', icon: 'ti-circle-x', color: 'var(--red, #dc2626)' },
  { key: 'other', label: 'Other', icon: 'ti-dots', color: 'var(--text2)' },
];
const META = Object.fromEntries(KINDS.map(k => [k.key, k])) as Record<ActivityType, typeof KINDS[number]>;
const PLATFORMS: PlatformId[] = ['naukri', 'instahyre', 'hirist', 'cutshort', 'wellfound'];

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

export default function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [counts, setCounts] = useState<{ stages: Partial<Record<ActivityType, number>>; platforms: Partial<Record<PlatformId, number>>; responded: number; shortlisted: number }>({ stages: {}, platforms: {}, responded: 0, shortlisted: 0 });
  const [days, setDays] = useState(7);
  const [type, setType] = useState<ActivityType | ''>('');
  const [platform, setPlatform] = useState<PlatformId | ''>('');
  const [limit, setLimit] = useState(100);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await activityApi({ days, limit: 400, types: type });
      setEvents(r.events); setTotal(r.total); setCounts(r.counts); setError(''); setUpdated(Date.now());
    } catch (e: any) { setError(e?.message || 'Could not load activity'); }
    finally { setLoading(false); }
  }, [days, type]);

  useEffect(() => { setLoading(true); setLimit(100); load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => clearInterval(id);
  }, [load]);

  const shown = useMemo(() => events.filter(e => !platform || e.platform === platform), [events, platform]);
  const visible = shown.slice(0, limit);
  const groups = useMemo(() => {
    const out: { label: string; rows: ActivityEvent[] }[] = [];
    for (const e of visible) {
      const label = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(e); else out.push({ label, rows: [e] });
    }
    return out;
  }, [visible]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        {KINDS.filter(k => k.key !== 'other' || counts.stages.other).map(k => (
          <button key={k.key} type="button" className={`btn btn-sm${type === k.key ? ' btn-primary' : ''}`}
            onClick={() => setType(t => (t === k.key ? '' : k.key))}>
            <i className={`ti ${k.icon}`} /> {k.label}
            <span className="contact-count-badge" style={{ marginLeft: 6 }}>{counts.stages[k.key] ?? 0}</span>
          </button>
        ))}
        <select value={platform} onChange={e => setPlatform(e.target.value as PlatformId | '')} style={{ maxWidth: 170 }} aria-label="Platform">
          <option value="">All platforms</option>
          {PLATFORMS.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)} ({counts.platforms[p] ?? 0})</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ maxWidth: 150 }} aria-label="Period">
          <option value={1}>Last 24 hours</option><option value={3}>Last 3 days</option>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
        <Muted>{updated ? `updated ${fmtAgo(updated)}` : ''}</Muted>
      </div>
      <Muted style={{ display: 'block', marginBottom: 10 }}>
        {counts.responded} jobs have a recruiter response · {counts.shortlisted} shortlisted or contacted (same as Analytics). The chip numbers are jobs by their furthest step; picking a chip lists just that kind of update in the chosen period.
      </Muted>

      {error && <div className="badge badge-failed" style={{ marginBottom: 10 }}>{error}</div>}

      {loading && events.length === 0 ? <Muted>Loading recruiter activity…</Muted> : shown.length === 0 ? (
        <Empty icon="ti-user-search">
          No recruiter activity in this period. When a recruiter views, shortlists or contacts you on a job you applied to, it shows up here after the daily check.
        </Empty>
      ) : groups.map(g => (
        <div key={g.label} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            {g.label.toUpperCase()} · {g.rows.length}
          </div>
          {g.rows.map((e, i) => {
            const m = META[e.type];
            return (
              <div key={`${e.jobId}-${e.at}-${e.label}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <i className={`ti ${m.icon}`} style={{ color: m.color, marginTop: 2, fontSize: 16 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13, color: m.color }}>{e.label}</strong>
                    <span style={{ fontSize: 13 }}>{e.company || 'Unknown company'}</span>
                    <PlatformTag id={e.platform} />
                  </div>
                  <Muted>{e.title}{e.recruiter ? ` · ${e.recruiter}` : ''}</Muted>
                </div>
                <Muted>{new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</Muted>
                {e.url && <a href={e.url} target="_blank" rel="noreferrer" title="Open on the site"><i className="ti ti-external-link" /></a>}
              </div>
            );
          })}
        </div>
      ))}

      {shown.length > limit && (
        <button className="btn btn-sm" type="button" onClick={() => setLimit(l => l + 100)}>Show more ({limit} of {shown.length})</button>
      )}
      {total > events.length && <Muted> Showing the newest {events.length} of {total}.</Muted>}
    </div>
  );
}
