// Analytics → Interviews. The whole Interviews store — contacts, leads and
// ones added by hand — where the Outreach view only counts contact-matched ones.
import { Link } from 'react-router-dom';
import { Card, HBar } from '../AnalyticsCards';
import InterviewFunnelCard from '../InterviewFunnelCard';
import { cvar } from '../../lib/analytics';
import { INTERVIEW_STATUS_LABELS, INTERVIEW_STATUS_ORDER, isStale, isTerminal } from '../../lib/interviews';
import type { InterviewFunnel } from '../../lib/interviewAnalytics';
import type { Interview, InterviewStatus } from '../../lib/api';

const STAGE_COLOR: Record<InterviewStatus, string> = {
  'initial-discussion': '--blue', assignment: '--teal', 'asked-to-schedule': '--amber', scheduled: '--indigo',
  'in-process': '--purple', selected: '--green', rejected: '--red',
};
const SOURCE_LABEL: Record<string, string> = { contact: 'From a contact you emailed', lead: 'From a lead', manual: 'Added by hand' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function InterviewsSection({ interviews, funnel, repliedCount }: {
  interviews: Interview[]; funnel: InterviewFunnel; repliedCount: number;
}) {
  const now = Date.now();
  const live = interviews.filter(iv => !isTerminal(iv));
  const selected = interviews.filter(iv => iv.status === 'selected').length;
  const rejected = interviews.filter(iv => iv.status === 'rejected').length;
  const upcoming = live.filter(iv => iv.interviewAt && new Date(iv.interviewAt).getTime() >= now - 3600e3)
    .sort((a, b) => +new Date(a.interviewAt!) - +new Date(b.interviewAt!));
  const stale = live.filter(iv => isStale(iv, now));
  const decided = selected + rejected;

  const byStage = INTERVIEW_STATUS_ORDER.map(s => ({ s, n: interviews.filter(iv => iv.status === s).length }));
  const bySource = ['contact', 'lead', 'manual'].map(k => ({ k, n: interviews.filter(iv => (iv.sourceType || 'manual') === k).length }));

  const kpis = [
    { label: 'Interviews tracked', value: interviews.length, sub: `${live.length} still in play` },
    { label: 'Upcoming', value: upcoming.length, sub: upcoming[0] ? `next ${when(upcoming[0].interviewAt!)}` : 'nothing on the calendar' },
    { label: 'Need a follow-up', value: stale.length, sub: 'no activity for 3+ days', cls: stale.length ? 'amber' : '' },
    { label: 'Selected', value: selected, sub: decided ? `${Math.round((selected / decided) * 100)}% of decided` : 'none decided yet', cls: selected ? 'green' : '' },
    { label: 'Rejected', value: rejected, sub: `${decided} decided in all` },
  ];

  if (!interviews.length) {
    return (
      <div className="an-card"><div className="an-card-body">
        <div className="an-empty"><i className="ti ti-user-check" />No interviews tracked yet. Move a reply or a lead to Interviews and this fills in.</div>
      </div></div>
    );
  }

  return (
    <>
      <div className="stat-grid">
        {kpis.map(k => (
          <div className="stat-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className={`kpi-value stat-value ${k.cls || ''}`}>{k.value}</div>
            <div className="stat-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="an-grid an-cards-2">
        <Card title="Where they stand" icon="ti-stairs" sub="Every interview, by its current stage">
          {byStage.map(r => (
            <HBar key={r.s} label={INTERVIEW_STATUS_LABELS[r.s]} dotColor={cvar(STAGE_COLOR[r.s])} n={r.n} d={interviews.length} fill={cvar(STAGE_COLOR[r.s])} />
          ))}
        </Card>
        <Card title="Where they came from" icon="ti-route" sub="Which part of your search each interview grew out of">
          {bySource.map(r => (
            <HBar key={r.k} label={SOURCE_LABEL[r.k]} n={r.n} d={interviews.length} fill={cvar('--accent')} />
          ))}
          <div className="an-card-sub" style={{ marginTop: 10 }}>
            Job-platform applications that reached an interview are counted on the Job platforms tab.
          </div>
        </Card>
      </div>

      <div className="an-grid an-cards-2">
        <Card title="Coming up" icon="ti-calendar-event" sub="Booked rounds from now on"
          right={<Link className="btn btn-xs" to="/interviews">Open Interviews <i className="ti ti-arrow-right" /></Link>}>
          {upcoming.length === 0 ? <div className="an-empty"><i className="ti ti-calendar-off" />Nothing booked</div> : (
            <table className="an-table">
              <thead><tr><th>When</th><th>Who</th><th>Stage</th></tr></thead>
              <tbody>
                {upcoming.slice(0, 8).map(iv => (
                  <tr key={iv.id}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{when(iv.interviewAt!)}</td>
                    <td>{iv.company || iv.name}{iv.role ? <span style={{ color: 'var(--text3)' }}> · {iv.role}</span> : null}</td>
                    <td style={{ color: 'var(--text2)' }}>{INTERVIEW_STATUS_LABELS[iv.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Gone quiet" icon="ti-hourglass" sub="Still in play, nothing has happened for 3 days or more">
          {stale.length === 0 ? <div className="an-empty"><i className="ti ti-circle-check" />Everything is moving</div> : (
            <table className="an-table">
              <thead><tr><th>Who</th><th>Stage</th><th className="num">Quiet for</th></tr></thead>
              <tbody>
                {stale.sort((a, b) => +new Date(a.lastActivityAt) - +new Date(b.lastActivityAt)).slice(0, 8).map(iv => (
                  <tr key={iv.id}>
                    <td>{iv.company || iv.name}{iv.role ? <span style={{ color: 'var(--text3)' }}> · {iv.role}</span> : null}</td>
                    <td style={{ color: 'var(--text2)' }}>{INTERVIEW_STATUS_LABELS[iv.status]}</td>
                    <td className="num">{Math.floor((now - new Date(iv.lastActivityAt).getTime()) / 864e5)}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <InterviewFunnelCard
        funnel={funnel} base={repliedCount} baseLabel="of contacts who replied"
        sub="Of the people you emailed: how many replies became an interview, and how far they got"
        emptyHint="No contact you emailed is tracked in Interviews yet."
        elsewhere={{ n: Math.max(0, interviews.length - funnel.records.length), label: 'came from a lead or were added by hand' }}
      />
    </>
  );
}
