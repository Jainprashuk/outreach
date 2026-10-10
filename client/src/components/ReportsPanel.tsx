import { useEffect, useState } from 'react';
import { RefreshBar, Refreshing } from './RefreshBar';
import { useToast } from '../context/ToastContext';
import {
  reportApi, reportPdfUrl, reportWeeksApi, emailReportApi,
  type ReportPeriodQuery, type ReportStats, type ReportHeadline,
} from '../lib/api';

// Your own report for any period: on screen first, then as a PDF or emailed to
// yourself. The server scopes every number to the signed-in account.

type Preset = 'last-week' | 'this-week' | 'last-30' | 'past' | 'custom';

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'last-week', label: 'Last week' },
  { key: 'this-week', label: 'This week so far' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'past', label: 'A past week' },
  { key: 'custom', label: 'Custom' },
];

const n = (v: number) => v.toLocaleString('en-IN');
const istDay = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const istWhen = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function Delta({ h, rate }: { h: ReportHeadline; rate?: boolean }) {
  if (h.delta === 0) return <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>same as before</div>;
  const up = h.delta > 0;
  return (
    <div style={{ fontSize: 11.5, marginTop: 2, color: up ? 'var(--green)' : 'var(--red)' }}>
      {up ? '+' : '−'}{rate ? `${Math.abs(h.delta)} pts` : n(Math.abs(h.delta))} vs before
    </div>
  );
}

export default function ReportsPanel() {
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('last-week');
  const [weeks, setWeeks] = useState<Array<{ week: string; label: string }>>([]);
  const [week, setWeek] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayIst());
  const [report, setReport] = useState<ReportStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    reportWeeksApi().then(r => { setWeeks(r.weeks); if (r.weeks[1]) setWeek(r.weeks[1].week); }).catch(() => {});
  }, []);

  const query = (): ReportPeriodQuery | null => {
    if (preset === 'past') return week ? { period: 'week', week } : null;
    if (preset === 'custom') return from && to ? { period: 'custom', from, to } : null;
    return { period: preset };
  };

  const generate = async () => {
    const q = query();
    if (!q) { setError(preset === 'custom' ? 'Pick a start and an end date.' : 'Pick a week.'); return; }
    setLoading(true);
    setError('');
    try {
      setReport(await reportApi(q));
    } catch (e: any) {
      setError(e.message || 'Could not build the report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { generate(); }, []);  // last week, on first open

  const emailIt = async () => {
    const q = query();
    if (!q) return;
    setEmailing(true);
    try {
      const r = await emailReportApi(q);
      toast(`Report emailed to ${r.to}`, 'success');
    } catch (e: any) {
      toast(e.message || 'Could not email the report', 'error');
    } finally {
      setEmailing(false);
    }
  };

  const q = query();
  const maxBar = report ? Math.max(1, ...report.series.points.map(p => Math.max(p.sent, p.replies))) : 1;
  const maxCat = report ? Math.max(1, ...report.replyCategories.map(c => c.n)) : 1;

  return (
    <>
      <div className="an-card">
        <div className="an-card-head">
          <div className="an-card-title"><i className="ti ti-file-analytics" /> Generate a report</div>
          <div className="an-card-sub">Your own numbers for any period, the same as the Monday email. Check them here, then download the PDF or email it to yourself.</div>
        </div>
        <div className="an-card-body">
          <div className="seg-toggle" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            {PRESETS.map(p => (
              <button key={p.key} type="button" className={`btn btn-xs${preset === p.key ? ' active' : ''}`} onClick={() => setPreset(p.key)}>{p.label}</button>
            ))}
          </div>
          {preset === 'past' && (
            <select value={week} onChange={e => setWeek(e.target.value)} style={{ marginBottom: 10, maxWidth: 260 }}>
              {weeks.map(w => <option key={w.week} value={w.week}>{w.label}</option>)}
            </select>
          )}
          {preset === 'custom' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 12.5, color: 'var(--text2)' }}>
              <input type="date" value={from} max={to || todayIst()} onChange={e => setFrom(e.target.value)} />
              to
              <input type="date" value={to} min={from} max={todayIst()} onChange={e => setTo(e.target.value)} />
              <span style={{ color: 'var(--text3)' }}>up to 90 days</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" type="button" onClick={generate} disabled={loading}>
              {loading ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Generating…</> : <><i className="ti ti-player-play" /> Generate</>}
            </button>
            <a className={`btn btn-sm${!report || !q ? ' disabled' : ''}`} href={report && q ? reportPdfUrl(q) : undefined} aria-disabled={!report || !q}>
              <i className="ti ti-download" /> Download PDF
            </a>
            <button className="btn btn-sm" type="button" onClick={emailIt} disabled={!report || emailing}>
              <i className={`ti ${emailing ? 'ti-loader-2' : 'ti-mail'}`} /> {emailing ? 'Sending…' : 'Email it to me'}
            </button>
          </div>
          {error && <div className="login-error" style={{ textAlign: 'left', marginTop: 10 }}>{error}</div>}
        </div>
      </div>

      {/* Generating another period: the current report stays, dimmed, until the new one is in. */}
      <RefreshBar active={loading && !!report} />
      <Refreshing active={loading && !!report}>
      {report && (
        <>
          <div className="section-head" style={{ margin: '18px 0 10px' }}>
            <div style={{ fontWeight: 600 }}>{report.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>compared with the {report.period.days}-day period before</div>
          </div>

          <div className="stat-grid">
            {([
              ['Emails sent', n(report.headline.sent.value), report.headline.sent, false],
              ['Replies', n(report.headline.replies.value), report.headline.replies, false],
              ['Reply rate', `${report.headline.replyRate.value}%`, report.headline.replyRate, true],
              ['Interviews', n(report.headline.interviews.value), report.headline.interviews, false],
            ] as const).map(([label, value, h, rate]) => (
              <div className="stat-card" key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{value}</div>
                <Delta h={h} rate={rate} />
              </div>
            ))}
          </div>

          {report.quiet && (
            <div className="info-box" style={{ marginTop: 14 }}>Nothing happened in this period, so the Monday email would be a one-line “quiet week” note.</div>
          )}

          <div className="an-card" style={{ marginTop: 16 }}>
            <div className="an-card-head"><div className="an-card-title"><i className="ti ti-chart-bar" /> {report.series.unit === 'day' ? 'Day by day' : 'Week by week'}</div></div>
            <div className="an-card-body">
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 130, overflowX: 'auto' }}>
                {report.series.points.map(p => (
                  <div key={p.day} style={{ flex: 1, minWidth: 26, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, width: '100%', justifyContent: 'center' }}>
                      <div title={`${p.sent} sent`} style={{ width: '40%', maxWidth: 14, height: `${(p.sent / maxBar) * 100}%`, background: 'var(--accent)', borderRadius: '3px 3px 0 0', minHeight: p.sent ? 2 : 0 }} />
                      <div title={`${p.replies} replies`} style={{ width: '40%', maxWidth: 14, height: `${(p.replies / maxBar) * 100}%`, background: 'var(--teal)', borderRadius: '3px 3px 0 0', minHeight: p.replies ? 2 : 0 }} />
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 4, whiteSpace: 'nowrap' }}>
                      {report.series.unit === 'day'
                        ? new Date(`${p.day}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric' })
                        : `w/c ${istDay(`${p.day}T12:00:00+05:30`)}`}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, color: 'var(--text2)' }}>
                <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--accent)', borderRadius: 2, marginRight: 5 }} />Emails sent</span>
                <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--teal)', borderRadius: 2, marginRight: 5 }} />Replies</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>
            <div className="an-card">
              <div className="an-card-head"><div className="an-card-title"><i className="ti ti-message-2" /> Replies by type</div></div>
              <div className="an-card-body">
                {!report.replyCategories.length ? <div className="an-empty">No replies in this period.</div> : report.replyCategories.map(c => (
                  <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, fontSize: 12.5 }}>
                    <div style={{ width: 150 }}>{c.label}</div>
                    <div className="progress-bar" style={{ flex: 1 }}><div className="progress-fill" style={{ width: `${(c.n / maxCat) * 100}%` }} /></div>
                    <div style={{ width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.n}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="an-card">
              <div className="an-card-head"><div className="an-card-title"><i className="ti ti-list-check" /> Pipeline & deliverability</div></div>
              <div className="an-card-body">
                <table className="an-table"><tbody>
                  {([
                    ['First emails sent', report.outreach.firstSends], ['Follow-ups sent', report.outreach.followUps],
                    ['Bounced', report.outreach.bounced], ['Failed to send', report.outreach.failed],
                    ['Leads added', report.pipeline.leadsAdded], ['Leads applied to', report.pipeline.leadsApplied],
                    ['Naukri applications', report.pipeline.naukriApplied], ['New interview entries', report.pipeline.interviewsNew],
                    ...report.pipeline.interviewMoves.map(m => [`Interviews moved to “${m.status}”`, m.n] as const),
                  ] as const).map(([label, v]) => (
                    <tr key={label}><td>{label}</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n(v)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            </div>
          </div>

          {(report.bySource || []).length > 0 && (
            <div className="an-card" style={{ marginTop: 16 }}>
              <div className="an-card-head"><div className="an-card-title"><i className="ti ti-arrows-split" /> Results by source</div></div>
              <div className="an-card-body">
                <table className="an-table">
                  <thead><tr><th>Where contacts came from</th><th style={{ textAlign: 'right' }}>First sends</th><th style={{ textAlign: 'right' }}>Replies</th><th style={{ textAlign: 'right' }}>Reply rate</th><th style={{ textAlign: 'right' }}>Bounced</th></tr></thead>
                  <tbody>{report.bySource!.map(r => (
                    <tr key={r.key}><td>{r.label}</td>
                      <td style={{ textAlign: 'right' }}>{n(r.sent)}</td><td style={{ textAlign: 'right' }}>{n(r.replies)}</td>
                      <td style={{ textAlign: 'right' }}>{r.replyRate}%</td><td style={{ textAlign: 'right' }}>{n(r.bounced)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}

          <div className="an-card" style={{ marginTop: 16 }}>
            <div className="an-card-head"><div className="an-card-title"><i className="ti ti-send" /> Campaigns</div></div>
            <div className="an-card-body">
              {!report.campaigns.length ? <div className="an-empty">No campaign activity in this period.</div> : (
                <table className="an-table">
                  <thead><tr><th>Campaign</th><th>Status</th><th style={{ textAlign: 'right' }}>Sent</th><th style={{ textAlign: 'right' }}>Remaining</th></tr></thead>
                  <tbody>{report.campaigns.map(c => (
                    <tr key={c.name}><td>{c.name}</td><td>{c.finishedInPeriod ? 'finished' : c.status}</td>
                      <td style={{ textAlign: 'right' }}>{n(c.sent)}</td><td style={{ textAlign: 'right' }}>{n(c.remaining)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>
            <div className="an-card">
              <div className="an-card-head"><div className="an-card-title"><i className="ti ti-calendar-event" /> Coming up</div></div>
              <div className="an-card-body">
                {!report.upcomingInterviews.length && !report.waiting.count && <div className="an-empty">Nothing scheduled and no replies waiting on you.</div>}
                {report.upcomingInterviews.map(i => (
                  <div key={`${i.name}${i.interviewAt}`} style={{ fontSize: 12.5, marginBottom: 6 }}>
                    <strong>{[i.company, i.role].filter(Boolean).join(' · ') || i.name}</strong>{i.round && ` (${i.round})`}
                    <span style={{ color: 'var(--text3)' }}> — {istWhen(i.interviewAt)}</span>
                  </div>
                ))}
                {report.waiting.count > 0 && (
                  <div style={{ fontSize: 12.5, marginTop: 8 }}>
                    <strong>{report.waiting.count}</strong> repl{report.waiting.count === 1 ? 'y is' : 'ies are'} waiting on you
                    {report.waiting.items.map(w => (
                      <div key={`${w.name}${w.repliedAt}`} style={{ color: 'var(--text2)', marginTop: 3 }}>{w.name}{w.company && ` · ${w.company}`} — {w.categoryLabel}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="an-card">
              <div className="an-card-head"><div className="an-card-title"><i className="ti ti-star" /> Top replies</div></div>
              <div className="an-card-body">
                {!report.topReplies.length ? <div className="an-empty">No replies in this period.</div> : report.topReplies.map(r => (
                  <div key={`${r.name}${r.repliedAt}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, marginBottom: 6 }}>
                    <span>{r.name}{r.company && <span style={{ color: 'var(--text3)' }}> · {r.company}</span>} <span style={{ color: 'var(--text3)' }}>({istDay(r.repliedAt)})</span></span>
                    <span style={{ color: 'var(--text2)' }}>{r.categoryLabel}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      </Refreshing>
    </>
  );
}
