import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { jobsOverviewApi, type JobsOverview } from '../../lib/api';
import { PlatformTag } from './platform';
import { Empty, Muted } from './ui';
import { fmtRunTime } from './format';

// The Jobs tab's landing view: what needs you, where each platform stands, what
// happened lately. Everything is read-only; each "needs you" card jumps to the
// list that fixes it.

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};

const KIND_ICON: Record<string, [string, string]> = {
  applied: ['ti-send', 'var(--text2)'], failed: ['ti-alert-triangle', '#c0392b'],
  viewed: ['ti-eye', 'var(--text2)'], shortlisted: ['ti-star', '#1a7f4b'],
  contacted: ['ti-message-circle', '#1a7f4b'], 'not-shortlisted': ['ti-circle-x', 'var(--text2)'],
};

export type OverviewTarget = { stage?: 'review' | 'queued' | 'applied' | 'skipped'; platform?: string; scope?: 'activity'; sub?: string };

function NeedCard({ n, label, hint, tone, onClick }: { n: number; label: string; hint: string; tone: 'bad' | 'warn' | 'good'; onClick: () => void }) {
  const color = tone === 'bad' ? '#c0392b' : tone === 'warn' ? '#b9770e' : '#1a7f4b';
  return (
    <button type="button" onClick={onClick} title={hint} disabled={n === 0}
      style={{ textAlign: 'left', flex: '1 1 150px', minWidth: 150, padding: '10px 12px', borderRadius: 10, cursor: n ? 'pointer' : 'default',
        border: '0.5px solid var(--border)', background: 'var(--card, transparent)', opacity: n ? 1 : 0.55 }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: n ? color : 'var(--text2)' }}>{n}</div>
      <div style={{ fontSize: 12, color: 'var(--text2)' }}>{label}</div>
    </button>
  );
}

export default function Overview({ onOpen }: { onOpen: (t: OverviewTarget) => void }) {
  const [data, setData] = useState<JobsOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await jobsOverviewApi(7)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  if (error && !data) return <div className="badge badge-failed">{error}</div>;
  if (!data) return <Muted>Loading…</Muted>;
  const { needs, platforms, timeline } = data;
  const nothing = needs.review + needs.needsAnswer + needs.failed + needs.problems.length === 0;

  return (
    <div>
      <h3 style={{ fontSize: 14, margin: '4px 0 8px' }}>Needs you</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <NeedCard n={needs.review} tone="warn" label="jobs to review" hint="New jobs waiting for your yes or no" onClick={() => onOpen({ stage: 'review' })} />
        <NeedCard n={needs.needsAnswer} tone="warn" label="need an answer" hint="Skipped because a screening question had no answer" onClick={() => onOpen({ stage: 'skipped', sub: 'needs-answer' })} />
        <NeedCard n={needs.failed} tone="bad" label="failed to apply" hint="Approved jobs whose apply failed, in Queued" onClick={() => onOpen({ stage: 'queued' })} />
        <NeedCard n={needs.recruiter} tone="good" label="recruiter interest" hint="Shortlisted or contacted by a recruiter" onClick={() => onOpen({ scope: 'activity' })} />
      </div>
      {needs.problems.length > 0 && (
        <div style={{ margin: '8px 0 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {needs.problems.map(p => (
            <div key={p.platform} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <i className="ti ti-alert-circle" style={{ color: '#b9770e' }} />
              <PlatformTag id={p.platform} />
              <span>{p.problems.map(x => x.text).join(' · ')}</span>
              <Link to={`/job-platforms?platform=${p.platform}`} style={{ fontSize: 12 }}>Open</Link>
            </div>
          ))}
        </div>
      )}
      {nothing && <Muted style={{ display: 'block', marginBottom: 12 }}>Nothing needs you right now.</Muted>}

      <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>Platforms</h3>
      {platforms.length === 0 ? <Empty icon="ti-briefcase-2">No platform is switched on. Turn one on in Job Platforms.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text2)', fontSize: 12 }}>
                <th style={{ padding: '4px 8px 4px 0' }}>Platform</th><th>Review</th><th>Queued</th><th>Applied</th>
                <th title="Viewed by a recruiter">Viewed</th><th title="Shortlisted or contacted">Interest</th><th>Rejected</th>
                <th>This week</th><th>Statuses checked</th><th>Worker</th>
              </tr>
            </thead>
            <tbody>
              {platforms.map(p => (
                <tr key={p.platform} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ padding: '7px 8px 7px 0' }}><PlatformTag id={p.platform} /></td>
                  <td><button type="button" className="btn btn-xs" onClick={() => onOpen({ stage: 'review', platform: p.platform })}>{p.review}</button></td>
                  <td><button type="button" className="btn btn-xs" onClick={() => onOpen({ stage: 'queued', platform: p.platform })}>{p.queued}</button></td>
                  <td><button type="button" className="btn btn-xs" onClick={() => onOpen({ stage: 'applied', platform: p.platform })}>{p.applied}</button></td>
                  <td>{p.viewed}</td>
                  <td style={{ fontWeight: p.shortlisted + p.contacted ? 600 : 400 }}>{p.shortlisted + p.contacted}</td>
                  <td>{p.notShortlisted}</td>
                  <td title={`${p.foundThisWeek} new jobs found`}>{p.week.applied} sent{p.week.failed ? ` · ${p.week.failed} failed` : ''}</td>
                  <td style={{ color: p.trackStale ? '#b9770e' : undefined }}>{ago(p.lastTrackAt)}</td>
                  <td>
                    {p.activeRun ? <span className="badge badge-queued">running {p.activeRun.kind}</span>
                      : <span className={`badge ${p.worker.online ? 'badge-approved' : 'badge-seen'}`}
                          title={p.lastRun ? `Last run: ${p.lastRun.kind} ${p.lastRun.status} ${ago(p.lastRun.at)}` : ''}>{p.worker.online ? 'online' : 'offline'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '18px 0 6px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>What happened (last {data.days} days)</h3>
        <button type="button" className="btn btn-xs" onClick={() => onOpen({ scope: 'activity' })}>Recruiter activity</button>
      </div>
      {timeline.length === 0 ? <Empty icon="ti-activity">Nothing yet in this period.</Empty> : timeline.map((e, i) => {
        const [icon, color] = KIND_ICON[e.kind] || ['ti-dots', 'var(--text2)'];
        return (
          <div key={`${e.at}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '0.5px solid var(--border)', fontSize: 13 }}>
            <i className={`ti ${icon}`} style={{ color, width: 18 }} />
            <span style={{ minWidth: 150 }}>{e.label}</span>
            <PlatformTag id={e.platform} />
            <a href={e.url || undefined} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', flex: 1, minWidth: 0 }}>
              {e.title}{e.company ? <span style={{ color: 'var(--text2)' }}> · {e.company}</span> : null}
            </a>
            {e.note && e.kind === 'failed' ? <Muted>{e.note}</Muted> : null}
            <Muted>{fmtRunTime(e.at)}</Muted>
          </div>
        );
      })}
    </div>
  );
}
