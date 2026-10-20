// What is running and what runs next: send jobs (with Gmail's daily-limit pause),
// the last 24h against the daily cap, the next scheduled hours, worker runs and
// each job platform's state.
import { Link } from 'react-router-dom';
import type { PlatformInfo, SendJob, Timeline, WorkerRunCard } from '../../lib/api';
import { Skeleton } from '../Skeleton';
import { fmtAgo, fmtWhen, plural } from './format';

type Tone = 'run' | 'ok' | 'warn' | 'bad' | 'idle';
const PILL: Record<Tone, string> = { run: 'accent', ok: 'green', warn: 'amber', bad: 'red', idle: 'muted' };

function Row({ tone, title, sub, pill, to, when }: {
  tone: Tone; title: string; sub?: string; pill?: string; to?: string; when?: string;
}) {
  const inner = (
    <>
      {when !== undefined ? <span className="dash-when">{when}</span> : <span className={`dash-status s-${tone}`} aria-hidden="true" />}
      <div className="dash-row-main">
        <div className="dash-row-title">{title}</div>
        {sub && <div className="dash-row-sub">{sub}</div>}
      </div>
      {pill && <span className={`dash-pill ${PILL[tone]}`}>{pill}</span>}
    </>
  );
  return to ? <Link to={to} className="dash-row">{inner}</Link> : <div className="dash-row">{inner}</div>;
}

const pendingItems = (j: SendJob) => j.items.filter(i => i.status === 'pending').length;

export function SendingCard({ jobs, timeline }: { jobs: SendJob[] | null; timeline: Timeline | null }) {
  const loading = !jobs || !timeline;
  const now = timeline?.now ?? Date.now();
  const sent24 = timeline ? timeline.buckets.filter(b => b.t >= now - 24 * 3600000 && b.t <= now).reduce((s, b) => s + b.sent, 0) : 0;
  const cap = timeline?.dailyCap ?? null;
  const upcoming = timeline ? timeline.buckets.filter(b => b.t > now - 3600000 && !b.past && b.scheduled > 0).slice(0, 3) : [];
  const quotaPaused = (jobs || []).filter(j => j.status === 'paused' && j.pauseReason === 'gmail_daily_limit');
  const resumeAt = quotaPaused.map(j => j.pausedUntil).filter(Boolean).sort()[0] || null;
  const waiting = quotaPaused.reduce((s, j) => s + pendingItems(j), 0);

  return (
    <section className="dash-panel" aria-labelledby="dash-sending">
      <h3 id="dash-sending">Sending <Link to="/campaigns">Campaigns <i className="ti ti-arrow-right" aria-hidden="true" /></Link></h3>
      {loading ? <><Skeleton h={40} /><Skeleton h={14} style={{ marginTop: 14 }} /><Skeleton h={14} style={{ marginTop: 10 }} /></> : (
        <>
          {quotaPaused.length > 0 && (
            <div className="dash-banner">
              <i className="ti ti-player-pause" aria-hidden="true" />
              <div>
                <b>Gmail's daily sending limit reached</b>
                <span>
                  {resumeAt ? `Sending resumes automatically around ${fmtWhen(resumeAt)}.` : 'Sending resumes automatically once the limit resets.'}
                  {waiting > 0 && ` ${plural(waiting, 'email')} waiting.`}
                </span>
              </div>
            </div>
          )}
          <div className="dash-meter">
            <div className="dash-meter-top">
              <b>{cap ? `${sent24} / ${cap}` : sent24}</b><span>sent in the last 24h</span>
            </div>
            {cap ? <div className="dash-bar"><i style={{ width: `${Math.min(100, Math.round((sent24 / cap) * 100))}%` }} /></div> : null}
          </div>

          <div className="dash-list">
            {(jobs || []).filter(j => !quotaPaused.includes(j)).map(j => {
              const total = j.items.length;
              const done = j.items.filter(i => i.status !== 'pending').length;
              const tone: Tone = j.status === 'paused' ? 'warn' : j.status === 'processing' ? 'run' : 'idle';
              return (
                <Row key={j.id} tone={tone} title={j.campaignName || 'Manual send'}
                  sub={`${done} of ${total} processed`}
                  pill={j.status === 'paused' ? 'Paused' : j.status === 'processing' ? 'Sending' : 'Starting'} />
              );
            })}
            {upcoming.map(b => (
              <Row key={b.key} tone="idle" when={fmtWhen(b.t)} title={`${plural(b.scheduled, 'email')} scheduled`}
                sub="Campaign batches and drips" to="/campaigns" />
            ))}
            {(jobs || []).length === 0 && upcoming.length === 0 && (
              <div className="dash-empty">Nothing is sending or scheduled in the next 48 hours.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function platformRow(p: PlatformInfo) {
  const o = p.overview;
  if (!o) return null;
  const to = `/job-platforms?platform=${p.id}`;
  const stats = [o.appliedToday ? `${o.appliedToday} applied today` : '', o.waitingCount ? `${o.waitingCount} approved waiting` : '']
    .filter(Boolean).join(' · ');
  if (o.blockedUntil && new Date(o.blockedUntil).getTime() > Date.now()) {
    return <Row key={p.id} tone="bad" title={p.label} sub={`Stopped after a captcha until ${fmtWhen(o.blockedUntil)}`} pill="Blocked" to={to} />;
  }
  if (o.worker.everSeen && !o.worker.online) {
    return <Row key={p.id} tone="bad" title={p.label} sub={`Worker offline since ${fmtAgo(o.worker.lastSeenAt)}. Run npm run workers on your computer.`} pill="Offline" to={to} />;
  }
  if (!o.worker.everSeen) {
    return <Row key={p.id} tone="idle" title={p.label} sub="The local worker has never connected" pill="Not set up" to={to} />;
  }
  if (o.paused) return <Row key={p.id} tone="warn" title={p.label} sub={stats || 'Scheduled runs are paused'} pill="Paused" to={to} />;
  const next = o.nextOccurrence ? `Next run ${fmtWhen(o.nextOccurrence)}` : 'No run scheduled';
  return <Row key={p.id} tone="ok" title={p.label} sub={[next, stats].filter(Boolean).join(' · ')} pill="Ready" to={to} />;
}

function runRow(r: WorkerRunCard) {
  const tone: Tone = r.status === 'running' ? 'run' : r.status === 'queued' ? 'idle'
    : r.status === 'done' ? 'ok' : r.status === 'blocked' ? 'warn' : 'bad';
  const pill = { running: 'Running', queued: 'Queued', done: 'Done', blocked: 'Paused', failed: 'Failed', cancelled: 'Cancelled' }[r.status];
  const progress = r.total ? `${r.done} of ${r.total} ${r.unit}` : '';
  const sub = [progress, r.error || r.detail, r.finishedAt ? fmtAgo(r.finishedAt) : `started ${fmtAgo(r.createdAt)}`].filter(Boolean).join(' · ');
  return <Row key={r.id} tone={tone} title={`${r.label}: ${r.kindLabel}`} sub={sub} pill={pill} to={r.link || undefined} />;
}

export function WorkersCard({ runs, platforms, mailboxCheckedAt }: {
  runs: WorkerRunCard[] | null; platforms: PlatformInfo[] | null; mailboxCheckedAt: Date | null;
}) {
  const loading = !runs || !platforms;
  const mailboxStale = !mailboxCheckedAt || Date.now() - mailboxCheckedAt.getTime() > 3 * 3600000;
  const enabled = (platforms || []).filter(p => p.enabled && p.overview);
  return (
    <section className="dash-panel" aria-labelledby="dash-workers">
      <h3 id="dash-workers">Workers &amp; platforms <Link to="/job-platforms">Job Platforms <i className="ti ti-arrow-right" aria-hidden="true" /></Link></h3>
      {loading ? <><Skeleton h={14} /><Skeleton h={14} style={{ marginTop: 14 }} /><Skeleton h={14} style={{ marginTop: 14 }} /></> : (
        <div className="dash-list">
          {(runs || []).map(runRow)}
          {enabled.map(platformRow)}
          <Row tone={mailboxStale ? 'warn' : 'ok'} title="Mailbox check"
            sub={mailboxCheckedAt ? `Last checked ${fmtAgo(mailboxCheckedAt)}` : 'Not checked yet'}
            pill={mailboxStale ? 'Stale' : 'Healthy'} to="/mailbox" />
        </div>
      )}
    </section>
  );
}
