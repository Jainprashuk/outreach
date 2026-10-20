// Analytics → Job Platforms (Naukri, Instahyre, Hirist, or all of them). The
// question it answers first is "is applying working?": what the worker sent,
// why the rest stopped, and whether recruiters respond. Everything here is
// already stored by the job-platform flow (lib/naukriAnalytics.js).
// `NaukriAnalyticsView` takes data directly so the admin drawer can reuse it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, HBar } from './AnalyticsCards';
import { Skeleton } from './Skeleton';
import { naukriAnalyticsApi, type NaukriAnalytics as Data, type PlatformScope } from '../lib/api';
import { cvar, fmtDur, pct } from '../lib/analytics';

const STAGE_LABEL: Record<string, string> = {
  applied: 'Not opened yet', viewed: 'Viewed', shortlisted: 'Shortlisted', contacted: 'Recruiter contacted you',
  'not-shortlisted': 'Not shortlisted', unknown: 'Not tracked yet',
};
const RUN_LABEL: Record<string, string> = {
  apply: 'Apply', harvest: 'Harvest', refresh: 'Profile refresh', track: 'Track replies', probe: 'Check-in',
};
const TIDY_LABEL: Record<string, string> = {
  stale: 'Posted too long ago', 'low-fit': 'Fit score too low', 'company-site': 'Applies on the company site', other: 'Other',
};

/** Apply attempts per day, stacked: applied, skipped, failed. Hover a day for its numbers. */
function AttemptChart({ series, cap }: { series: Data['perDay']; cap: number }) {
  const fills = { applied: cvar('--teal') || '#085041', skipped: cvar('--amber') || '#8a5c00', failed: cvar('--red') || '#c0392b' };
  const W = 1100, H = 190, padL = 34, padR = 8, padT = 14, padB = 28;
  const cW = W - padL - padR, cH = H - padT - padB;
  const maxV = Math.max(1, cap, ...series.map(d => d.applied + d.skipped + d.failed));
  const slot = cW / series.length, bw = Math.max(3, Math.min(18, slot - 2));
  const fmt = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const every = Math.ceil(series.length / 8);
  const capY = padT + cH * (1 - cap / maxV);
  return (
    <>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }} role="img"
        aria-label={`Apply attempts per day, last ${series.length} days`}>
        {[0, 0.5, 1].map(f => {
          const y = padT + cH * (1 - f);
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} style={{ stroke: 'var(--chart-grid)', strokeWidth: 1 }} />
              <text x={padL - 8} y={y + 5} textAnchor="end" style={{ fontSize: 14, fill: 'var(--text3)' }}>{Math.round(maxV * f)}</text>
            </g>
          );
        })}
        <line x1={padL} y1={capY} x2={W - padR} y2={capY} strokeDasharray="6 5" style={{ stroke: 'var(--text3)', strokeWidth: 1 }} />
        <text x={W - padR} y={capY - 5} textAnchor="end" style={{ fontSize: 13, fill: 'var(--text3)' }}>daily limit {cap}</text>
        {series.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          let y = padT + cH;
          const parts = (['applied', 'skipped', 'failed'] as const).map(k => {
            const h = d[k] ? Math.max(2, (d[k] / maxV) * cH) : 0;
            y -= h;
            return h ? <rect key={k} x={x} y={y} width={bw} height={h} style={{ fill: fills[k], pointerEvents: 'none' }} /> : null;
          });
          return (
            <g key={d.day}>
              <rect x={padL + i * slot} y={padT} width={slot} height={cH} style={{ fill: 'transparent' }}>
                <title>{fmt(d.day)} — {d.applied} applied · {d.skipped} skipped · {d.failed} failed</title>
              </rect>
              {parts}
              {i % every === 0 && (
                <text x={x + bw / 2} y={H - 4} textAnchor="middle" style={{ fontSize: 14, fill: 'var(--text3)' }}>{fmt(d.day)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="an-legend" style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
        {(['applied', 'skipped', 'failed'] as const).map(k => (
          <span key={k}><span className="dot" style={{ background: fills[k], display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 5 }} />{k[0].toUpperCase() + k.slice(1)}</span>
        ))}
      </div>
    </>
  );
}

function Loading() {
  return (
    <>
      <div className="stat-grid stat-grid-6" style={{ padding: '0 0 4px', marginBottom: 14 }} aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div className="stat-card" key={i}>
            <Skeleton w="55%" h={10} />
            <Skeleton w="40%" h={26} style={{ marginTop: 8 }} />
            <Skeleton w="70%" h={10} style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
      <div className="an-card" style={{ padding: 18 }}>
        {[0, 1, 2, 3, 4].map(r => <Skeleton key={r} w={`${90 - r * 10}%`} h={11} style={{ marginBottom: 10 }} />)}
      </div>
    </>
  );
}

const SITE_LABEL: Record<string, string> = { all: 'job platform', naukri: 'Naukri', instahyre: 'Instahyre', hirist: 'Hirist' };
const RECOMMENDED_LABEL: Record<string, string> = {
  all: 'Recommended / matched feeds', naukri: "Naukri's Recommended jobs", instahyre: "Instahyre's Matched opportunities", hirist: 'Your Hirist job feed',
};

/** All platforms: each site side by side, so you can see which one works. */
function ByPlatform({ rows }: { rows: NonNullable<Data['byPlatform']> }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title="By platform" icon="ti-layout-columns" sub="Each job site side by side — found, sent, and what recruiters did">
        <div style={{ overflowX: 'auto' }}>
          <table className="an-table">
            <thead><tr>
              <th>Platform</th><th className="num">Found</th><th className="num">Approved</th><th className="num">Applied</th>
              <th className="num">Today</th><th className="num">Responded</th><th className="num">Shortlisted</th>
              <th className="num">Interviews</th><th className="num">Runs</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.platform}>
                  <td><Link to={`/job-platforms?platform=${r.platform}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{r.label}</Link></td>
                  <td className="num">{r.found}</td><td className="num">{r.approved}</td>
                  <td className="num">{r.applied}</td><td className="num">{r.appliedToday}</td>
                  <td className="num">{r.responded}{r.applied ? <span style={{ color: 'var(--text3)' }}> ({pct(r.responded, r.applied)}%)</span> : null}</td>
                  <td className="num">{r.shortlisted}</td><td className="num">{r.interviewing}</td>
                  <td className="num" title={`${r.failedRuns} failed · ${r.blockedRuns} hit a captcha`}>
                    {r.runs}{r.failedRuns || r.blockedRuns ? <span style={{ color: 'var(--red)' }}> · {r.failedRuns + r.blockedRuns} ✕</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function NaukriAnalyticsView({ data, admin = false, platform = 'all' }: { data: Data; admin?: boolean; platform?: PlatformScope }) {
  const t = data.totals;
  const site = SITE_LABEL[platform] || 'job platform';
  const pageLink = `/job-platforms?platform=${platform}`;
  if (!t.found) {
    return (
      <div className="an-empty" style={{ flexDirection: 'column', gap: 10 }}>
        <i className="ti ti-briefcase" />
        No {site} jobs yet{admin ? '.' : ' — run a harvest to see how applying performs.'}
        {!admin && <Link to={pageLink} className="btn btn-sm"><i className="ti ti-briefcase" /> Open Job Platforms</Link>}
      </div>
    );
  }

  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const amber = cvar('--amber') || '#8a5c00';
  const red = cvar('--red') || '#c0392b';
  const muted = cvar('--text3') || '#8a8a8a';
  const lim = data.limits;

  const kpis = [
    { label: 'Jobs found', value: t.found.toLocaleString(), sub: `${t.pending} waiting for review`, cls: '' },
    { label: 'Approved', value: t.approved.toLocaleString(), sub: t.approvedAuto ? `${pct(t.approvedAuto, t.approved)}% automatically` : 'all by you', cls: '' },
    { label: 'Applied', value: t.applied.toLocaleString(), sub: `${t.waiting} approved, still to send`, cls: 'teal' },
    { label: 'Applied today', value: `${t.appliedToday} / ${lim.maxPerDay}`, sub: 'against your daily limit', cls: t.appliedToday >= lim.maxPerDay ? 'red' : '' },
    { label: 'Recruiters responded', value: t.responded.toLocaleString(), sub: t.applied ? `${pct(t.responded, t.applied)}% of applications · ${t.shortlisted} shortlisted` : 'nothing applied yet', cls: t.shortlisted ? 'green' : '' },
    { label: 'Interviews', value: t.interviewing.toLocaleString(), sub: t.offer ? `${t.offer} offer${t.offer === 1 ? '' : 's'}` : 'marked interviewing or offer', cls: t.interviewing ? 'green' : '' },
  ];

  const funnel = [
    { label: 'Jobs found', n: t.found },
    { label: 'Approved to apply', n: t.approved },
    { label: 'Application sent', n: t.applied },
    { label: 'Recruiter responded', n: t.responded },
    { label: 'Shortlisted or contacted', n: t.shortlisted },
    { label: 'Interviewing or offer', n: t.interviewing },
  ];
  const attempts = data.perDay.reduce((a, d) => ({ applied: a.applied + d.applied, skipped: a.skipped + d.skipped, failed: a.failed + d.failed }), { applied: 0, skipped: 0, failed: 0 });
  const stopped = data.reasons.reduce((a, r) => a + r.skipped + r.failed, 0);
  const stagesTracked = data.stages.reduce((a, s) => a + s.n, 0);
  const scored = data.scores.reduce((a, s) => a + s.n, 0);
  const maxScore = Math.max(1, ...data.scores.map(s => s.n));
  const tidyTotal = Object.values(data.tidy).reduce((a, b) => a + b, 0);
  const draftsOpen = data.ai.drafts.ready + data.ai.drafts.unknown + data.ai.drafts.error;

  return (
    <>
      {platform === 'all' && data.byPlatform && data.byPlatform.length > 0 && <ByPlatform rows={data.byPlatform} />}
      <div className="stat-grid stat-grid-6" style={{ padding: '0 0 4px', marginBottom: 14 }}>
        {kpis.map(k => (
          <div className="stat-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className={`stat-value ${k.cls}`}>{k.value}</div>
            <div className="stat-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <Card title="Apply attempts" icon="ti-send"
          sub={`Every attempt the worker made over the last ${data.days} days — ${attempts.applied} applied, ${attempts.skipped} skipped, ${attempts.failed} failed`}
          right={data.blocked.runs > 0
            ? <span className="badge badge-rejected" title={data.blocked.lastAt ? `Last on ${new Date(data.blocked.lastAt).toLocaleString()}` : undefined}>
                {data.blocked.runs} run{data.blocked.runs === 1 ? '' : 's'} hit a captcha</span>
            : undefined}>
          {attempts.applied + attempts.skipped + attempts.failed === 0
            ? <div className="an-empty"><i className="ti ti-send" />No apply attempts in the last {data.days} days</div>
            : <AttemptChart series={data.perDay} cap={lim.maxPerDay} />}
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Funnel" icon="ti-filter" sub="Every job harvested so far, by how far it got">
          {funnel.map((f, i) => <HBar key={f.label} label={f.label} n={f.n} d={t.found} fill={i < 3 ? accent : teal} />)}
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            Also: {t.rejected} rejected by you · {t.tidied} tidied away · {t.skipped} skipped · {t.failed} failed · {t.dismissed} dismissed
            {t.employerRejected ? ` · ${t.employerRejected} rejected by the employer` : ''}
          </div>
        </Card>
        <Card title="Why attempts stopped" icon="ti-hand-stop" sub={`Skipped and failed attempts in the last ${data.days} days, by reason`}>
          {stopped === 0
            ? <div className="an-empty"><i className="ti ti-mood-smile" />Nothing stopped</div>
            : data.reasons.map(r => (
              <HBar key={r.key} label={r.label} n={r.skipped + r.failed} d={stopped}
                fill={r.failed ? red : r.key === 'question' ? amber : muted}
                extra={r.skipped && r.failed ? ` · ${r.skipped} skipped, ${r.failed} failed` : ''} />
            ))}
          {data.reasons.some(r => r.key === 'question') && !admin && (
            <div className="an-card-sub" style={{ marginTop: 10 }}>
              Unanswered questions retry once you answer them — <Link to={pageLink}>Job Platforms</Link> → Jobs → Needs answer.
            </div>
          )}
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="What recruiters did" icon="ti-user-search"
          sub={data.responseMedianHours != null
            ? `Applications, by the furthest step the site shows · typical response in ${fmtDur(data.responseMedianHours)}`
            : 'Applications, by the furthest step the site shows'}>
          {stagesTracked === 0
            ? <div className="an-empty"><i className="ti ti-user-search" />No applications yet</div>
            : data.stages.filter(s => s.n > 0).map(s => (
              <HBar key={s.stage} label={STAGE_LABEL[s.stage] || s.stage} n={s.n} d={stagesTracked}
                fill={s.stage === 'shortlisted' || s.stage === 'contacted' ? teal : s.stage === 'not-shortlisted' ? red : s.stage === 'viewed' ? accent : muted} />
            ))}
          {t.applied > 0 && t.tracked === 0 && (
            <div className="an-card-sub" style={{ marginTop: 10 }}>Turn on "Check replies" in the {platform === 'all' ? 'platform' : site} schedule to read what recruiters did.</div>
          )}
        </Card>
        <Card title="Fit score" icon="ti-chart-bar"
          sub={lim.autoApproveEnabled
            ? `Jobs by fit score · ${lim.autoApproveMinScore}+ is approved automatically`
            : `Jobs by fit score · auto-approve is off (it would take ${lim.autoApproveMinScore}+)`}>
          {scored === 0
            ? <div className="an-empty"><i className="ti ti-chart-bar" />No scored jobs yet</div>
            : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, paddingTop: 8 }} role="img" aria-label="Jobs by fit score">
                {data.scores.map(s => (
                  <div key={s.from} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}
                    title={`${s.from}–${s.to}: ${s.n} jobs, ${s.applied} applied`}>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.n || ''}</span>
                    <div style={{ width: '100%', height: `${(s.n / maxScore) * 100}%`, minHeight: s.n ? 2 : 0, borderRadius: 3,
                      background: s.from >= lim.autoApproveMinScore ? teal : accent, opacity: 0.85 }} />
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.from}</span>
                  </div>
                ))}
              </div>
            )}
          {data.unscored > 0 && <div className="an-card-sub" style={{ marginTop: 8 }}>{data.unscored} older jobs have no score yet — they get one the next time a harvest sees them.</div>}
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Where jobs come from" icon="ti-route" sub="Found, and applied to, by source">
          <HBar label="Your searches" n={data.origins.search} d={t.found} fill={accent} extra={` · ${data.origins.searchApplied} applied`} />
          <HBar label={RECOMMENDED_LABEL[platform] || 'Recommended'} n={data.origins.recommended} d={t.found} fill={accent} extra={` · ${data.origins.recommendedApplied} applied`} />
          {!admin && data.queries && data.queries.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="an-table">
                <thead><tr><th>Search</th><th className="num">Found</th><th className="num">Applied</th><th className="num">Responded</th></tr></thead>
                <tbody>
                  {data.queries.map(q => (
                    <tr key={q.query}><td>{q.query}</td><td className="num">{q.found}</td><td className="num">{q.applied}</td><td className="num">{q.responded}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Screening questions" icon="ti-message-question" sub={`AI answers during apply, last ${data.days} days, and your answer bank`}>
          <HBar label="Answered live by AI" n={data.ai.answered} d={Math.max(1, data.ai.asked)} extra={` of ${data.ai.asked} asked`} fill={teal} />
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            {data.ai.answers.you + data.ai.answers.auto} saved answers ({data.ai.answers.auto} written by AI, waiting for you to keep)
            {' · '}{draftsOpen} draft{draftsOpen === 1 ? '' : 's'} in Needs answer{data.ai.drafts.ignored ? ` · ${data.ai.drafts.ignored} ignored` : ''}
          </div>
          <div className="an-card-sub" style={{ marginTop: 6 }}>
            {data.autoApproved} job{data.autoApproved === 1 ? '' : 's'} approved automatically in the last {data.days} days
            {lim.tidyEnabled && tidyTotal > 0 && <> · tidied so far: {Object.entries(data.tidy).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${TIDY_LABEL[k].toLowerCase()}`).join(', ')}</>}
          </div>
        </Card>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Card title="Worker runs" icon="ti-robot" sub={`Runs in the last ${data.days} days, by kind`}>
          {data.runs.length === 0
            ? <div className="an-empty"><i className="ti ti-robot" />No runs in the last {data.days} days</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table className="an-table">
                  <thead><tr><th>Kind</th><th className="num">Runs</th><th className="num">Finished</th><th className="num">Failed</th><th className="num">Blocked</th><th className="num">Cancelled</th><th className="num">Scheduled</th></tr></thead>
                  <tbody>
                    {data.runs.map(r => (
                      <tr key={r.kind}>
                        <td>{RUN_LABEL[r.kind] || r.kind}</td>
                        <td className="num">{r.total}</td>
                        <td className="num">{r.done}</td>
                        <td className="num" style={r.failed ? { color: 'var(--red)' } : undefined}>{r.failed}</td>
                        <td className="num">{r.blocked}</td>
                        <td className="num">{r.cancelled}</td>
                        <td className="num">{r.scheduled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      </div>
    </>
  );
}

const SCOPES: Array<[PlatformScope, string]> = [['all', 'All platforms'], ['naukri', 'Naukri'], ['instahyre', 'Instahyre'], ['hirist', 'Hirist']];
const SCOPE_KEY = 'analytics-jp-scope';

export default function NaukriAnalytics({ refreshToken }: { refreshToken: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<PlatformScope>(() => {
    try { const v = localStorage.getItem(SCOPE_KEY) as PlatformScope | null; return v && SCOPES.some(([k]) => k === v) ? v : 'all'; }
    catch { return 'all'; }
  });
  const pickScope = (v: PlatformScope) => {
    setScope(v); setData(null);
    try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ }
  };

  useEffect(() => {
    let alive = true;
    naukriAnalyticsApi(30, scope)
      .then(d => { if (alive) { setData(d); setError(''); } })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [refreshToken, scope]);

  return (
    <>
      <div className="nav-tabs" role="group" aria-label="Platform" style={{ marginBottom: 14 }}>
        {SCOPES.map(([k, label]) => (
          <button key={k} type="button" className={`nav-tab${scope === k ? ' active' : ''}`} onClick={() => pickScope(k)}>{label}</button>
        ))}
      </div>
      {error ? <div className="an-empty"><i className="ti ti-alert-triangle" />{error}</div>
        : !data ? <Loading />
        : <NaukriAnalyticsView data={data} platform={scope} />}
    </>
  );
}
