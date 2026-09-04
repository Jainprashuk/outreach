import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, HBar } from './AnalyticsCards';
import { SkeletonRows } from './Skeleton';
import { loadLeadsApi, loadLeadOutcomesApi, type Lead, type LeadOutcomeMap } from '../lib/api';
import { cvar, pct } from '../lib/analytics';
import {
  computeLeadMetrics, fitBuckets, harvestRuns, importsByDay,
  applyFunnel, outcomeFunnel, queryStats, sourceBreakdown, topDomains, topMultiAddress, unattributed,
} from '../lib/leadAnalytics';

const fmtDate = (t: number | null) =>
  t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';

/** Import volume per day — a plain bar chart; leads arrive in bursts, not trends. */
function ImportChart({ series }: { series: Array<{ day: number; n: number }> }) {
  const accent = cvar('--accent') || '#4f46e5';
  const W = 720, H = 170, padL = 28, padR = 10, padT = 16, padB = 24;
  const cW = W - padL - padR, cH = H - padT - padB;
  const maxV = Math.max(1, ...series.map(d => d.n));
  const slot = cW / series.length, bw = Math.min(28, slot * 0.6);

  return (
    <svg width="100%" style={{ display: 'block', overflow: 'visible' }} viewBox={`0 0 ${W} ${H}`}>
      {[0, 0.5, 1].map(f => {
        const yy = padT + cH * (1 - f);
        return (
          <g key={f}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} style={{ stroke: 'var(--chart-grid)', strokeWidth: 1 }} />
            <text x={padL - 6} y={yy + 3.5} textAnchor="end" style={{ fontSize: 9, fill: 'var(--text3)' }}>{Math.round(maxV * f)}</text>
          </g>
        );
      })}
      {series.map((d, i) => {
        const h = d.n > 0 ? Math.max(3, (d.n / maxV) * cH) : 2;
        const bx = padL + i * slot + (slot - bw) / 2;
        return (
          <g key={d.day}>
            <rect x={bx} y={padT + cH - h} width={bw} height={h} rx={4}
              style={{ fill: accent, opacity: d.n ? 0.85 : 0.14 }}>
              <title>{new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — {d.n} leads</title>
            </rect>
            {d.n > 0 && <text x={bx + bw / 2} y={padT + cH - h - 5} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: 'var(--text)' }}>{d.n}</text>}
            {(i % 2 === 0 || series.length <= 8) && (
              <text x={bx + bw / 2} y={H - 7} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text3)' }}>
                {new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function LeadsAnalytics({ refreshToken }: { refreshToken: number }) {
  // Leads live outside AppContext (one consumer), so this view owns its fetch.
  const [leads, setLeads] = useState<Lead[]>([]);
  const [outcomes, setOutcomes] = useState<LeadOutcomeMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      loadLeadsApi(),
      loadLeadOutcomesApi().catch(() => ({ outcomes: {} as LeadOutcomeMap, count: 0 })),
    ])
      .then(([rows, out]) => { if (alive) { setLeads(rows); setOutcomes(out.outcomes); setError(''); } })
      .catch(err => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refreshToken]);

  const m = useMemo(() => computeLeadMetrics(leads), [leads]);
  const buckets = useMemo(() => fitBuckets(leads), [leads]);
  const domains = useMemo(() => topDomains(leads), [leads]);
  const multi = useMemo(() => topMultiAddress(leads), [leads]);
  const runs = useMemo(() => harvestRuns(leads), [leads]);
  const series = useMemo(() => importsByDay(leads), [leads]);
  const sources = useMemo(() => sourceBreakdown(leads), [leads]);
  const queries = useMemo(() => queryStats(leads, outcomes), [leads, outcomes]);
  const funnel2 = useMemo(() => outcomeFunnel(leads, outcomes), [leads, outcomes]);
  const af = useMemo(() => applyFunnel(leads), [leads]);
  const noQuery = useMemo(() => unattributed(leads), [leads]);

  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const amber = cvar('--amber') || '#8a5c00';
  const red = cvar('--red') || '#b42318';

  if (loading && leads.length === 0) {
    return (
      <div className="table-card">
        <table><tbody><SkeletonRows rows={6} cols={4} chipCol={0} /></tbody></table>
      </div>
    );
  }

  if (error) {
    return <div className="an-empty"><i className="ti ti-alert-triangle" />{error}</div>;
  }

  if (leads.length === 0) {
    return (
      <div className="an-empty" style={{ flexDirection: 'column', gap: 10 }}>
        <i className="ti ti-target-arrow" />
        <div>No leads staged yet.</div>
        <Link to="/leads" className="btn btn-sm"><i className="ti ti-file-code" /> Import a harvester file</Link>
      </div>
    );
  }

  const kpis = [
    { label: 'Total leads', value: m.total.toLocaleString(), sub: `${m.people.toLocaleString()} distinct people`, cls: '' },
    { label: 'Contactable', value: m.withEmail.toLocaleString(), sub: `${m.withoutEmail} have no email`, cls: '' },
    { label: 'Moved to outreach', value: m.moved.toLocaleString(), sub: `${m.conversion}% of contactable`, cls: 'green' },
    { label: 'Worth working', value: m.usable.toLocaleString(), sub: `${m.rejects} hard rejects excluded`, cls: 'teal' },
    { label: 'Replies earned', value: String(funnel2.replied),
      sub: funnel2.delivered ? `${Math.round(funnel2.replied / funnel2.delivered * 1000) / 10}% of ${funnel2.delivered} delivered` : 'nothing delivered yet',
      cls: funnel2.replied > 0 ? 'green' : '' },
  ];

  const funnel = [
    { label: 'Leads harvested', n: m.total },
    { label: 'Has an email', n: m.withEmail },
    { label: 'Not a hard reject', n: m.usable },
    { label: 'In outreach', n: funnel2.inOutreach },
    { label: 'Actually emailed', n: funnel2.emailed },
    { label: 'Delivered', n: funnel2.delivered },
    { label: 'Replied', n: funnel2.replied },
  ];
  const funnelMax = funnel[0].n || 1;

  const quality = [
    { label: 'Has an email address', n: m.withEmail, c: accent },
    { label: 'Company known or inferable', n: m.companyKnown, c: teal },
    { label: 'Has a LinkedIn profile', n: m.withProfile, c: accent },
    { label: 'Has a post link', n: m.withPost, c: amber },
    { label: 'Has extra links', n: m.withLinks, c: amber },
    { label: 'Flagged as hiring', n: m.hiring, c: teal },
  ];

  return (
    <>
      <div className="stat-grid" style={{ padding: '0 0 4px', marginBottom: 14 }}>
        {kpis.map(k => (
          <div className="stat-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className={`kpi-value stat-value ${k.cls}`}>{k.value}</div>
            <div className="stat-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Lead funnel" icon="ti-filter" sub="How harvested rows narrow down to real contacts" delay=".04s">
          {funnel.map((s, i) => (
            <HBar key={s.label} label={s.label} n={s.n} d={funnelMax} fill={accent} opacity={1 - i * 0.15}
              extra={i > 0 ? ` · ${pct(s.n, funnel[i - 1].n)}% of prev` : ''} />
          ))}
          <div className="an-card-sub" style={{ marginTop: 8 }}>
            {m.alreadyExisted > 0 && (
              <>{m.alreadyExisted} moved lead{m.alreadyExisted !== 1 ? 's were' : ' was'} already in your contacts, so no new contact was created. </>
            )}
            {funnel2.alreadyContacted > 0 && (
              <><strong>{funnel2.alreadyContacted} lead{funnel2.alreadyContacted !== 1 ? 's are' : ' is'} still marked “new” but you have already
              emailed that address</strong> — filter by outcome to find {funnel2.alreadyContacted !== 1 ? 'them' : 'it'} before sending again. </>
            )}
            {funnel2.bounced > 0 && <>{funnel2.bounced} bounced. </>}
          </div>
        </Card>

        <Card title="Fit score spread" icon="ti-chart-bar" sub="How the harvester scored this batch" delay=".08s">
          {buckets.map(b => (
            <HBar key={b.label} label={b.label} n={b.n} d={m.total}
              fill={b.label === 'Hard reject' ? red : b.label === 'Negative' ? amber : accent}
              opacity={b.label === 'Hard reject' ? 0.7 : 0.9} />
          ))}
        </Card>
      </div>

      <div className="an-card" style={{ marginBottom: 14, animationDelay: '.12s' }}>
        <div className="an-card-head">
          <div>
            <div className="an-card-title"><i className="ti ti-timeline" /> Leads imported</div>
            <div className="an-card-sub">Rows added per day over the last 14 days</div>
          </div>
        </div>
        <div className="an-card-body"><ImportChart series={series} /></div>
      </div>

      {queries.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14, animationDelay: '.14s' }}>
          <div className="an-card-head">
            <div>
              <div className="an-card-title"><i className="ti ti-search" /> Search query performance</div>
              <div className="an-card-sub">
                Ranked by replies earned, then by workable leads — "workable" means it has an email
                and isn't a hard reject. A lead found by several searches counts for each.
                {noQuery > 0 ? ` ${noQuery} lead${noQuery !== 1 ? 's have' : ' has'} no query recorded (imported before the field existed).` : ''}
              </div>
            </div>
          </div>
          <div className="an-card-body" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text3)', fontSize: 11 }}>
                  <th style={{ padding: '4px 8px 8px 0' }}>Query</th>
                  <th style={{ padding: '4px 8px 8px' }}>Leads</th>
                  <th style={{ padding: '4px 8px 8px' }}>With email</th>
                  <th style={{ padding: '4px 8px 8px' }}>Workable</th>
                  <th style={{ padding: '4px 8px 8px' }}>Hit rate</th>
                  <th style={{ padding: '4px 8px 8px' }}>Median fit</th>
                  <th style={{ padding: '4px 8px 8px' }}>Moved</th>
                  <th style={{ padding: '4px 8px 8px' }}>Emailed</th>
                  <th style={{ padding: '4px 0 8px 8px' }}>Replied</th>
                </tr>
              </thead>
              <tbody>
                {queries.map(q => (
                  <tr key={q.query} style={{ borderTop: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px 6px 0', whiteSpace: 'normal', maxWidth: 280 }}>{q.query}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{q.n}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{q.withEmail}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{q.usable}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ color: q.hitRate >= 25 ? 'var(--green)' : q.hitRate >= 10 ? undefined : 'var(--text3)' }}>
                        {q.hitRate}%
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', color: q.medianFit === -999 ? 'var(--red)' : 'var(--text2)' }}>
                      {q.medianFit === -999 ? 'all rejects' : q.medianFit}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{q.moved || '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{q.emailed || '—'}</td>
                    <td style={{ padding: '6px 0 6px 8px', fontWeight: q.replied ? 600 : 400,
                      color: q.replied ? 'var(--green)' : 'var(--text3)' }}>{q.replied || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Direct applications" icon="ti-file-check"
          sub="The parallel track — leads you applied to yourself rather than emailing. Updated by hand." delay=".15s">
          {af.hasApplyLink === 0 && af.applied === 0 ? (
            <div className="an-empty"><i className="ti ti-file-off" />No leads with an application link yet</div>
          ) : (
            <>
              <HBar label="Has an apply link" n={af.hasApplyLink} d={m.total} fill={accent} />
              <HBar label="Applied" n={af.applied} d={af.hasApplyLink || 1} fill={teal} />
              <HBar label="In review" n={af.inReview} d={af.applied || 1} fill={teal} opacity={0.7} />
              <HBar label="Interviewing" n={af.interviewing} d={af.applied || 1} fill={amber} />
              <HBar label="Offer" n={af.offer} d={af.applied || 1} fill={teal} opacity={1} />
              <HBar label="Rejected" n={af.rejected} d={af.applied || 1} fill={red} opacity={0.7} />
              {af.skipped > 0 && (
                <div className="an-card-sub" style={{ marginTop: 8 }}>{af.skipped} deliberately skipped.</div>
              )}
              {af.applied === 0 && af.hasApplyLink > 0 && (
                <div className="an-card-sub" style={{ marginTop: 8 }}>
                  {af.hasApplyLink} lead{af.hasApplyLink !== 1 ? 's have' : ' has'} a real application link but
                  none are marked as applied yet — the “Apply directly” filter on the Leads page finds them.
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Top email domains" icon="ti-at" sub="Which organisations dominate the harvest" delay=".16s">
          {domains.length === 0
            ? <div className="an-empty"><i className="ti ti-mail-off" />No email addresses yet</div>
            : domains.map(d => (
              <HBar key={d.domain} label={d.domain} n={d.n} d={domains[0].n} fill={teal}
                extra={d.moved > 0 ? ` · ${d.moved} moved` : ''} />
            ))}
        </Card>

        <Card title="Status" icon="ti-chart-pie" sub="Where your staged leads currently sit" delay=".2s">
          <HBar label="New — not yet actioned" n={m.fresh} d={m.total} fill={accent} dotColor={accent} />
          <HBar label="Added to outreach" n={m.moved} d={m.total} fill={teal} dotColor={teal} />
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            {m.withoutEmail > 0
              ? `${m.withoutEmail} of the ${m.fresh} new leads can't be actioned without finding an email first.`
              : 'Every staged lead has an email address.'}
          </div>
        </Card>
      </div>

      <div className="an-grid an-cards-2" style={{ marginBottom: 14 }}>
        <Card title="Data quality" icon="ti-checkup-list" sub="What the harvester actually captured" delay=".24s">
          {quality.map(q => <HBar key={q.label} label={q.label} n={q.n} d={m.total} fill={q.c} />)}
        </Card>

        <Card title="Harvest runs" icon="ti-history" sub="Rows grouped by the run that produced them" delay=".28s">
          {runs.length === 0
            ? <div className="an-empty"><i className="ti ti-history-off" />No run data</div>
            : runs.map((r, i) => (
              <HBar key={i} label={fmtDate(r.at)} n={r.n} d={runs[0].n} fill={accent}
                extra={r.moved > 0 ? ` · ${r.moved} moved` : ''} />
            ))}
          {sources.length > 0 && (
            <div className="an-card-sub" style={{ marginTop: 10 }}>
              Source: {sources.map(s => `${s.source} (${s.n})`).join(' · ')}
            </div>
          )}
        </Card>
      </div>

      {multi.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14, animationDelay: '.32s' }}>
          <div className="an-card-head">
            <div>
              <div className="an-card-title"><i className="ti ti-users-group" /> People with several addresses</div>
              <div className="an-card-sub">
                Each address is its own row, so these {m.multiAddress} people account for extra rows — worth
                picking one address rather than emailing them all
              </div>
            </div>
          </div>
          <div className="an-card-body">
            {multi.map((g, i) => (
              <HBar key={i} label={g.name.length > 48 ? g.name.slice(0, 48) + '…' : g.name}
                n={g.n} d={multi[0].n} fill={amber}
                extra={g.moved > 0 ? ` · ${g.moved} moved` : ''} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
