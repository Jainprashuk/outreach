import type { NaukriOverview } from '../../lib/api';
import QueuedJobs from './QueuedJobs';
import NeedsAnswer from './NeedsAnswer';
import AppliedTable from './AppliedTable';
import SkippedJobs from './SkippedJobs';
import InfoTip, { JOBS_INFO } from './InfoTip';

// Everything after the inbox, by where it stands: waiting to go, stuck on a
// question, sent, or skipped for good. One tab with four views rather than four
// tabs, because they are one pipeline and the counts read best side by side.

export type JobsView = 'waiting' | 'answer' | 'applied' | 'skipped';

export default function JobsTab({ overview, view, onView, onChanged }: {
  overview: NaukriOverview;
  view: JobsView;
  onView: (v: JobsView) => void;
  onChanged: () => void;
}) {
  const otherSkipped = Math.max(0, overview.skippedCount - overview.needsAnswerCount);
  const VIEWS: Array<[JobsView, string, string, number, boolean?]> = [
    ['waiting', 'Waiting', 'ti-hourglass', overview.waitingCount],
    // Highlighted: the one view here that is waiting on YOU.
    ['answer', 'Needs answer', 'ti-help-circle', overview.needsAnswerCount, true],
    ['applied', 'Applied', 'ti-send', overview.appliedCount],
    ['skipped', 'Skipped', 'ti-player-skip-forward', otherSkipped],
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {VIEWS.map(([key, label, icon, n, urgent]) => (
          <button key={key} type="button" onClick={() => onView(key)}
            className={`btn btn-sm${view === key ? ' btn-primary' : ''}`}>
            <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
            {n > 0 && (
              <span className="contact-count-badge" style={{
                marginLeft: 6,
                ...(urgent && view !== key ? { background: 'var(--red)', color: '#fff' } : {}),
              }}>{n}</span>
            )}
            <InfoTip title={label}>{JOBS_INFO[key]}</InfoTip>
          </button>
        ))}
      </div>

      {view === 'waiting' && <QueuedJobs overview={overview} onChanged={onChanged} />}
      {view === 'answer' && <NeedsAnswer onChanged={onChanged} />}
      {view === 'applied' && <AppliedTable onChanged={onChanged} />}
      {view === 'skipped' && <SkippedJobs onChanged={onChanged} />}
    </>
  );
}
