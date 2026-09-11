// The interview stage of the pipeline, shared by the outreach and the leads
// analytics views so both read the same way. Interviews are their own store, so
// this is the only place either view learns that someone actually got a round.
import { Card, HBar } from './AnalyticsCards';
import { cvar, pct } from '../lib/analytics';
import { statusSpread, type InterviewFunnel } from '../lib/interviewAnalytics';
import type { InterviewStatus } from '../lib/api';

// Resolved at render time so the colours follow the active theme.
const STATUS_FILL: Record<InterviewStatus, () => string> = {
  'initial-discussion': () => cvar('--text3') || '#8a8a8a',
  'asked-to-schedule':  () => cvar('--amber') || '#8a5c00',
  'scheduled':          () => cvar('--indigo') || '#4f46e5',
  'in-process':         () => cvar('--blue') || '#1557a0',
  'selected':           () => cvar('--green') || '#1a7a4a',
  'rejected':           () => cvar('--red') || '#b42318',
};

export default function InterviewFunnelCard({
  funnel, base, baseLabel, sub, delay, emptyHint, elsewhere,
}: {
  funnel: InterviewFunnel;
  /** Rows the funnel came out of — "X of these reached an interview". */
  base: number;
  baseLabel: string;
  sub: string;
  delay?: string;
  emptyHint: string;
  /** Records this view can't claim — from the other store, or added by hand. */
  elsewhere?: { n: number; label: string };
}) {
  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const green = cvar('--green') || '#1a7a4a';
  const red = cvar('--red') || '#b42318';
  const spread = statusSpread(funnel.records).filter(s => s.n > 0);

  return (
    <Card title="Interview pipeline" icon="ti-user-check" sub={sub} delay={delay}>
      {funnel.tracked === 0 ? (
        <div className="an-empty" style={{ flexDirection: 'column', gap: 8, textAlign: 'center' }}>
          <i className="ti ti-user-off" />
          <div>{emptyHint}</div>
          {elsewhere && elsewhere.n > 0 && (
            <div style={{ fontSize: 11 }}>{elsewhere.n} {elsewhere.label}.</div>
          )}
        </div>
      ) : (
        <>
          <HBar label={`In interviews · ${baseLabel}`} n={funnel.tracked} d={base || 1} fill={accent} />
          <HBar label="Reached a booked round" n={funnel.interviewed} d={funnel.tracked} fill={teal}
            extra=" of those tracked" />
          <HBar label="Selected" n={funnel.selected} d={funnel.tracked} fill={green} opacity={1}
            extra=" of those tracked" />
          <HBar label="Rejected" n={funnel.rejected} d={funnel.tracked} fill={red} opacity={0.7}
            extra=" of those tracked" />

          {spread.length > 0 && (
            <>
              <div className="an-card-sub" style={{ margin: '14px 0 6px' }}>
                Where the {funnel.records.length} record{funnel.records.length !== 1 ? 's' : ''} sit right now
              </div>
              {spread.map(s => (
                <HBar key={s.status} label={s.label} n={s.n} d={funnel.records.length}
                  dotColor={STATUS_FILL[s.status]()} fill={STATUS_FILL[s.status]()} />
              ))}
            </>
          )}

          <div className="an-card-sub" style={{ marginTop: 10 }}>
            <strong>{funnel.live}</strong> still in play
            {funnel.upcoming > 0 ? <> · <strong>{funnel.upcoming}</strong> with a date already booked</> : null}
            {funnel.live > 0 && funnel.upcoming === 0
              ? ' — none of them have an interview date on the calendar yet.'
              : '.'}
            {base > 0 && (
              <> {pct(funnel.tracked, base)}% of {baseLabel} got this far.</>
            )}
            {elsewhere && elsewhere.n > 0 && (
              <> A further <strong>{elsewhere.n}</strong> {elsewhere.label}, so they are not counted above.</>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
