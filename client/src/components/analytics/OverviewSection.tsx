// Analytics → Overview. One screen across the whole search: what is waiting on
// you, the headline number from each area, the send/reply trend and insights.
// Each area's own tab has the detail; every row here leads to it.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isStale, isTerminal } from '../../lib/interviews';
import { pct } from '../../lib/analytics';
import {
  actionCenterSummaryApi, discoverAnalyticsApi, naukriAnalyticsApi,
  type ActionCenterSummary, type AnalyticsSummary, type DiscoverAnalytics, type Interview, type NaukriAnalytics,
} from '../../lib/api';

export type AnSec = 'overview' | 'outreach' | 'replies' | 'interviews' | 'activity' | 'naukri' | 'leads' | 'discover' | 'reports';

interface Attn { tone: 'bad' | 'warn' | 'info'; icon: string; text: ReactNode; to: string; cta: string }

export default function OverviewSection({ S, interviews, go, refreshToken, chart, insights }: {
  S: AnalyticsSummary;
  interviews: Interview[];
  go: (s: AnSec) => void;
  refreshToken: number;
  chart: ReactNode;
  insights: ReactNode;
}) {
  const [ac, setAc] = useState<ActionCenterSummary | null>(null);
  const [jobs, setJobs] = useState<NaukriAnalytics | null>(null);
  const [disc, setDisc] = useState<DiscoverAnalytics | null>(null);
  useEffect(() => {
    // Each one is optional: a failure just leaves its rows and tile out.
    actionCenterSummaryApi().then(setAc).catch(() => {});
    naukriAnalyticsApi(30, 'all').then(setJobs).catch(() => {});
    discoverAnalyticsApi(30).then(setDisc).catch(() => {});
  }, [refreshToken]);

  const m = S.metrics;
  const now = Date.now();
  const live = interviews.filter(iv => !isTerminal(iv));
  const soon = live.filter(iv => iv.interviewAt && new Date(iv.interviewAt).getTime() >= now && new Date(iv.interviewAt).getTime() < now + 7 * 864e5);
  const stale = live.filter(iv => isStale(iv, now));
  const needsYou = S.queue?.buckets['needs-you'] || 0;
  const positive = (S.replyTypes || []).filter(r => r.k === 'reviewing' || r.k === 'resume-requested').reduce((n, r) => n + r.n, 0);

  const attn: Attn[] = [];
  if (needsYou) attn.push({ tone: 'warn', icon: 'ti-message-reply', to: '/mailbox', cta: 'Open Mailbox',
    text: <><strong>{needsYou} {needsYou === 1 ? 'reply is' : 'replies are'} waiting on your answer</strong></> });
  if (soon.length) attn.push({ tone: 'info', icon: 'ti-calendar-event', to: '/interviews', cta: 'Open Interviews',
    text: <><strong>{soon.length} interview{soon.length === 1 ? '' : 's'} in the next 7 days</strong></> });
  if (stale.length) attn.push({ tone: 'warn', icon: 'ti-hourglass', to: '/interviews', cta: 'Open Interviews',
    text: <><strong>{stale.length} interview{stale.length === 1 ? ' has' : 's have'} gone quiet</strong> — no activity for 3+ days</> });
  if (S.due) attn.push({ tone: 'info', icon: 'ti-repeat', to: '/contacts', cta: 'Open Contacts',
    text: <><strong>{S.due} contact{S.due === 1 ? ' is' : 's are'} due a follow-up</strong> — emailed 3+ days ago, no reply</> });
  if (ac?.failed) attn.push({ tone: 'bad', icon: 'ti-mail-x', to: '/contacts', cta: 'Open Contacts',
    text: <><strong>{ac.failed} send{ac.failed === 1 ? '' : 's'} failed</strong></> });
  if (ac?.pending) attn.push({ tone: 'info', icon: 'ti-checklist', to: '/contacts', cta: 'Open Contacts',
    text: <><strong>{ac.pending} contact{ac.pending === 1 ? ' is' : 's are'} waiting for your approval</strong> before sending</> });
  if (jobs?.totals.pending) attn.push({ tone: 'info', icon: 'ti-briefcase', to: '/jobs', cta: 'Open Jobs',
    text: <><strong>{jobs.totals.pending} job{jobs.totals.pending === 1 ? '' : 's'} to review</strong> across job platforms</> });
  if (m.queuedNow) attn.push({ tone: 'info', icon: 'ti-clock', to: '/contacts', cta: 'Open Contacts',
    text: <><strong>{m.queuedNow} contact{m.queuedNow === 1 ? ' is' : 's are'} queued</strong> and never emailed</> });

  const kpis: Array<{ icon: string; label: string; value: ReactNode; sub: string; sec: AnSec }> = [
    { icon: 'ti-send', label: 'Emailed', value: m.sentCount.toLocaleString(), sub: `${m.total.toLocaleString()} contacts · ${m.fuCount} followed up`, sec: 'outreach' },
    { icon: 'ti-message-reply', label: 'Replied', value: m.repliedCount.toLocaleString(), sub: `${m.replyRate}% reply rate · ${positive} interested`, sec: 'replies' },
    { icon: 'ti-user-check', label: 'Interviews', value: interviews.length, sub: `${live.length} in play · ${interviews.filter(iv => iv.status === 'selected').length} selected`, sec: 'interviews' },
    { icon: 'ti-briefcase', label: 'Jobs applied', value: jobs ? jobs.totals.applied.toLocaleString() : '—',
      sub: jobs ? `${jobs.totals.responded} responses · ${jobs.totals.appliedToday} today` : 'job platforms', sec: 'naukri' },
    { icon: 'ti-compass', label: 'People found', value: disc ? disc.totals.found.toLocaleString() : '—',
      sub: disc ? `${disc.totals.moved} moved to outreach · ${disc.totals.replied} replied` : 'Discover', sec: 'discover' },
    { icon: 'ti-mail-x', label: 'Bounce rate', value: `${m.bounceRate}%`, sub: `${m.bouncedCount} ever bounced`, sec: 'outreach' },
  ];

  const { s1, s2, r1, r2 } = S.week;
  const delta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);

  return (
    <>
      <div className="an-card">
        <div className="an-card-head"><div className="an-card-title"><i className="ti ti-bell-ringing" /> Waiting on you</div></div>
        <div className="an-card-body">
          {attn.length === 0 ? (
            <div className="adm-allclear">
              <span className="adm-attn-ico"><i className="ti ti-circle-check" /></span>
              Nothing is waiting on you — no unanswered replies, follow-ups or interviews to chase.
            </div>
          ) : (
            <div className="adm-attn">
              {attn.map((a, i) => (
                <div className="adm-attn-row" key={i}>
                  <span className={`adm-attn-ico ${a.tone}`}><i className={`ti ${a.icon}`} aria-hidden="true" /></span>
                  <div className="adm-attn-text">{a.text}</div>
                  <Link className="btn btn-xs" to={a.to}>{a.cta} <i className="ti ti-arrow-right" /></Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="adm-kpis">
        {kpis.map(k => (
          <button key={k.label} type="button" className="adm-kpi" onClick={() => go(k.sec)}>
            <span className="adm-kpi-label"><i className={`ti ${k.icon}`} aria-hidden="true" />{k.label}</span>
            <span className="adm-kpi-value">{k.value}</span>
            <span className="adm-kpi-sub">{k.sub}</span>
          </button>
        ))}
      </div>

      <div className="adm-grid-2">
        {chart}
        <div className="an-card">
          <div className="an-card-head">
            <div className="an-card-title"><i className="ti ti-calendar-week" /> This week vs last</div>
            <div className="an-card-sub">The last 7 days against the 7 before</div>
          </div>
          <div className="an-card-body">
            {[['Sends', s1, s2], ['Replies', r1, r2]].map(([label, a, b]) => {
              const d = delta(a as number, b as number);
              return (
                <div key={label as string} className="an-week-row">
                  <span className="an-week-label">{label}</span>
                  <span className="an-week-val">{a as number}</span>
                  <span className="an-week-prev">vs {b as number}</span>
                  {d !== null && <span className={`an-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>{d > 0 ? '▲' : d < 0 ? '▼' : '='} {Math.abs(d)}%</span>}
                </div>
              );
            })}
            <div className="an-card-sub" style={{ marginTop: 12 }}>
              Replies per 100 sends: <b>{s1 ? pct(r1, s1) : '—'}</b> this week · {s2 ? pct(r2, s2) : '—'} last week.
              {' '}A reply can answer an older send, so this is a pace, not a reply rate.
            </div>
          </div>
        </div>
      </div>

      {insights}
    </>
  );
}
