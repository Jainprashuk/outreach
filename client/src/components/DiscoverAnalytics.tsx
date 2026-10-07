// Analytics → Discover. The first question it answers is "do the guessed addresses
// work?" — reply and bounce rates per confidence label, on the people moved into
// outreach. Everything else (searches, sources, companies, free allowances) is
// context for that.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, HBar } from './AnalyticsCards';
import { Skeleton } from './Skeleton';
import ConfidenceBadge from './ConfidenceBadge';
import { discoverAnalyticsApi, type DiscoverAnalytics as Data, type DiscoverLabelRow } from '../lib/api';
import { cvar, pct } from '../lib/analytics';

// Below this many emails, a rate is mostly noise — say so instead of implying a verdict.
const MIN_FOR_RATE = 10;

const LABEL_HELP: Record<DiscoverLabelRow['label'], string> = {
  high: 'Proven format, or their own address',
  medium: 'One sign the format is right',
  low: 'A best guess with no proof',
  generic: 'Shared inboxes like careers@',
  manual: 'Addresses you typed yourself',
};

const PROVIDER_NAME: Record<string, string> = { tavily: 'Tavily (people search)', serpapi: 'SerpApi (backup search)', hunter: 'Hunter (email format)' };

function Rate({ n, d, bad }: { n: number; d: number; bad?: boolean }) {
  if (!d) return <span style={{ color: 'var(--text3)' }}>—</span>;
  const r = pct(n, d);
  const alarming = bad && d >= MIN_FOR_RATE && r > 10;
  return (
    <span style={{ fontWeight: 600, color: alarming ? 'var(--red)' : 'var(--text)' }}
      title={d < MIN_FOR_RATE ? `Only ${d} emailed — too few to trust this rate yet` : undefined}>
      {r}%{d < MIN_FOR_RATE && <span style={{ fontWeight: 400, color: 'var(--text3)' }}> ·{' '}few</span>}
      {alarming && <i className="ti ti-alert-triangle" style={{ marginLeft: 4 }} aria-label="High bounce rate" />}
    </span>
  );
}

/** Searches per day — one series, so no legend; hover a bar for its date and count. */
function SearchChart({ series }: { series: Data['searchesPerDay'] }) {
  const accent = cvar('--accent') || '#4f46e5';
  // Wide and short: daily counts are small whole numbers, so height adds nothing.
  const W = 1100, H = 170, padL = 34, padR = 8, padT = 14, padB = 28;
  const cW = W - padL - padR, cH = H - padT - padB;
  const maxV = Math.max(1, ...series.map(d => d.n));
  const slot = cW / series.length, bw = Math.max(3, Math.min(18, slot - 2));
  const fmt = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const every = Math.ceil(series.length / 8);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }} role="img"
      aria-label={`Searches per day, last ${series.length} days`}>
      {[0, 0.5, 1].map(f => {
        const y = padT + cH * (1 - f);
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} style={{ stroke: 'var(--chart-grid)', strokeWidth: 1 }} />
            <text x={padL - 8} y={y + 5} textAnchor="end" style={{ fontSize: 14, fill: 'var(--text3)' }}>{Math.round(maxV * f)}</text>
          </g>
        );
      })}
      {series.map((d, i) => {
        const h = d.n ? Math.max(3, (d.n / maxV) * cH) : 0;
        const x = padL + i * slot + (slot - bw) / 2;
        return (
          <g key={d.day}>
            {/* Hit target taller than the bar, so a 1-search day is still easy to hover. */}
            <rect x={padL + i * slot} y={padT} width={slot} height={cH} style={{ fill: 'transparent' }}>
              <title>{fmt(d.day)} — {d.n} search{d.n === 1 ? '' : 'es'}</title>
            </rect>
            {h > 0 && (
              <rect x={x} y={padT + cH - h} width={bw} height={h} rx={3} style={{ fill: accent, pointerEvents: 'none' }} />
            )}
            {i % every === 0 && (
              <text x={x + bw / 2} y={H - 4} textAnchor="middle" style={{ fontSize: 14, fill: 'var(--text3)' }}>{fmt(d.day)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function DiscoverAnalytics({ refreshToken }: { refreshToken: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    discoverAnalyticsApi(30)
      .then(d => { if (alive) { setData(d); setError(''); } })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [refreshToken]);

  if (error) return <div className="an-empty"><i className="ti ti-alert-triangle" />{error}</div>;

  if (!data) {
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

  const t = data.totals;
  if (!t.searches && !t.found) {
    return (
      <div className="an-empty" style={{ flexDirection: 'column', gap: 10 }}>
        <i className="ti ti-compass" />
        No Discover searches yet — search a company to see how its people and guessed emails perform.
        <Link to="/discover" className="btn btn-sm"><i className="ti ti-search" /> Open Discover</Link>
      </div>
    );
  }

  const kpis = [
    { label: 'Searches', value: t.searches, sub: `${t.searchesLastDays} in the last ${data.days} days`, cls: '' },
    { label: 'Companies', value: t.companies, sub: 'searched so far', cls: '' },
    { label: 'People found', value: t.found, sub: `${t.withEmail} with an address`, cls: '' },
    { label: 'Moved to outreach', value: t.moved, sub: `${pct(t.moved, t.withEmail)}% of those with an address`, cls: 'teal' },
    { label: 'Replied', value: t.replied, sub: t.emailed ? `${pct(t.replied, t.emailed)}% of ${t.emailed} emailed` : 'none emailed yet', cls: t.replied ? 'green' : '' },
    { label: 'Bounced', value: t.bounced, sub: t.emailed ? `${pct(t.bounced, t.emailed)}% of emailed` : 'none emailed yet', cls: t.emailed && pct(t.bounced, t.emailed) > 10 ? 'red' : '' },
  ];

  const rows = data.byLabel.filter(r => r.found || r.moved);
  const viaTotal = data.via.search + data.via.github + data.via.website;
  const statusTotal = data.status.open + data.status.moved + data.status.discarded;
  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const muted = cvar('--text3') || '#8a8a8a';
  const runsTotal = data.runs.done + data.runs.failed + data.runs.cancelled + data.runs.running;

  return (
    <>
      <div className="stat-grid stat-grid-6" style={{ padding: '0 0 4px', marginBottom: 14 }}>
        {kpis.map(k => (
          <div className="stat-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className={`stat-value ${k.cls}`}>{k.value.toLocaleString()}</div>
            <div className="stat-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <Card title="Do the guesses work?" icon="ti-target"
          sub="For each label: how many people were found, moved to outreach and emailed — and how often they replied or bounced. This is how much to trust each label.">
          <div style={{ overflowX: 'auto' }}>
            <table className="an-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th className="num">Found</th>
                  <th className="num">Moved</th>
                  <th className="num">Emailed</th>
                  <th className="num">Replied</th>
                  <th className="num">Reply rate</th>
                  <th className="num">Bounced</th>
                  <th className="num">Bounce rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} style={{ color: 'var(--text2)' }}>No addresses guessed yet.</td></tr>
                ) : rows.map(r => (
                  <tr key={r.label}>
                    <td title={LABEL_HELP[r.label]}>
                      {r.label === 'manual'
                        ? <ConfidenceBadge source="manual" />
                        : <ConfidenceBadge confidence={r.label} />}
                      <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--text3)' }}>{LABEL_HELP[r.label]}</span>
                    </td>
                    <td className="num">{r.found}</td>
                    <td className="num">{r.moved}</td>
                    <td className="num">{r.emailed}{r.waiting ? <span style={{ color: 'var(--text3)', fontSize: 11 }}> +{r.waiting} waiting</span> : null}</td>
                    <td className="num">{r.replied}</td>
                    <td className="num"><Rate n={r.replied} d={r.emailed} /></td>
                    <td className="num" title={r.bounced ? `${r.hardBounced} said the address doesn't exist` : undefined}>{r.bounced}</td>
                    <td className="num"><Rate n={r.bounced} d={r.emailed} bad /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            {t.emailed === 0
              ? 'Nothing emailed yet — move some people to outreach and send. Rates appear here as replies and bounces come in.'
              : `A rate needs about ${MIN_FOR_RATE} emails before it means much; smaller ones are marked “few”. A bounce rate above 10% is flagged — it starts to hurt your Gmail.`}
          </div>
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Where people come from" icon="ti-route" sub="One person can be found by more than one source">
          {viaTotal === 0
            ? <div className="an-empty"><i className="ti ti-users" />No one found yet</div>
            : (
              <>
                <HBar label="Web search" n={data.via.search} d={viaTotal} fill={accent} />
                <HBar label="GitHub" n={data.via.github} d={viaTotal} fill={accent} />
                <HBar label="Company website" n={data.via.website} d={viaTotal} fill={accent} />
              </>
            )}
        </Card>
        <Card title="What happened to them" icon="ti-arrows-split" sub="Everyone found, by where they are now">
          {statusTotal === 0
            ? <div className="an-empty"><i className="ti ti-users" />No one found yet</div>
            : (
              <>
                <HBar label="Still to review" n={data.status.open} d={statusTotal} fill={muted} />
                <HBar label="Moved to outreach" n={data.status.moved} d={statusTotal} fill={teal} />
                <HBar label="Discarded" n={data.status.discarded} d={statusTotal} fill={muted} opacity={0.45} />
              </>
            )}
        </Card>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Card title="Searches" icon="ti-search"
          sub={`Searches per day over the last ${data.days} days — hover a day for its count`}
          right={
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span className="badge badge-sent">{data.runs.done} finished</span>
              {data.runs.failed > 0 && <span className="badge badge-rejected">{data.runs.failed} failed</span>}
              {data.runs.cancelled > 0 && <span className="badge badge-closed">{data.runs.cancelled} cancelled</span>}
              {data.runs.running > 0 && <span className="badge badge-queued">{data.runs.running} running</span>}
            </div>
          }>
          {runsTotal === 0 ? <div className="an-empty"><i className="ti ti-search" />No searches yet</div> : <SearchChart series={data.searchesPerDay} />}
          {data.topRoles.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="an-card-sub" style={{ marginTop: 0 }}>Roles you search for most:</span>
              {data.topRoles.map(r => <span key={r.role} className="contact-count-badge">{r.role} · {r.n}</span>)}
            </div>
          )}
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Companies" icon="ti-building" sub="Your most-searched companies and how their people did">
          {data.companies.length === 0
            ? <div className="an-empty"><i className="ti ti-building" />No companies yet</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table className="an-table">
                  <thead>
                    <tr><th>Company</th><th className="num">People</th><th className="num">Labels</th><th className="num">Moved</th><th className="num">Replied</th><th className="num">Bounced</th></tr>
                  </thead>
                  <tbody>
                    {data.companies.map(c => (
                      <tr key={c.domain}>
                        <td>
                          <Link to={`/discover?domain=${encodeURIComponent(c.domain)}`} style={{ color: 'var(--text)', fontWeight: 500 }}>{c.company || c.domain}</Link>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.domain}</div>
                        </td>
                        <td className="num">{c.people}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <span className="tc-mini" style={{ justifyContent: 'flex-end' }}>
                            {c.high ? <span className="badge badge-sent">{c.high} high</span> : null}
                            {c.medium ? <span className="badge badge-pending">{c.medium} med</span> : null}
                            {c.low ? <span className="badge badge-rejected">{c.low} low</span> : null}
                            {!c.high && !c.medium && !c.low && <span style={{ color: 'var(--text3)' }}>—</span>}
                          </span>
                        </td>
                        <td className="num">{c.moved}</td>
                        <td className="num">{c.replied}</td>
                        <td className="num">{c.bounced}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
        <Card title="Free allowances" icon="ti-gauge" sub={`What you've used of each free service this month (${data.month})`}>
          {data.allowance.map(a => (
            a.hasKey
              ? <HBar key={a.provider} label={PROVIDER_NAME[a.provider]} n={a.used} d={a.cap} extra={` of ${a.cap}`}
                  fill={pct(a.used, a.cap) > 85 ? (cvar('--red') || '#c0392b') : accent} />
              : (
                <div key={a.provider} className="hbar-row">
                  <div className="hbar-top">
                    <span className="hbar-label">{PROVIDER_NAME[a.provider]}</span>
                    <span className="hbar-val"><Link to="/settings" style={{ fontSize: 12 }}>No key — add one</Link></span>
                  </div>
                </div>
              )
          ))}
          <div className="an-card-sub" style={{ marginTop: 10 }}>Counters reset on the 1st of each month.</div>
        </Card>
      </div>
    </>
  );
}
