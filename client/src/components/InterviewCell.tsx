import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MoveToInterviewModal, { type InterviewSeed } from './MoveToInterviewModal';
import { useInterviews } from '../context/InterviewContext';
import { INTERVIEW_BADGE_CLASS, INTERVIEW_STATUS_LABELS, isStale } from '../lib/interviews';

/**
 * The Interviews touchpoint on a Contacts or Leads row. Read-only with respect
 * to the source: it either links to the interview record that already tracks
 * this person, or opens the dialog that creates one. Nothing here writes to the
 * Contact or Lead itself.
 */
export default function InterviewCell({ seed, compact }: {
  seed: InterviewSeed;
  /** Icon-only trigger, for tables that are already tight on width. */
  compact?: boolean;
}) {
  const store = useInterviews();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const existing = seed.sourceId ? store.forSource(seed.sourceType, seed.sourceId) : null;

  if (existing) {
    const stale = isStale(existing);
    return (
      <button
        type="button"
        className={`badge ${INTERVIEW_BADGE_CLASS[existing.status]}`}
        style={{ border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 11 }}
        title={stale
          ? `In Interviews · ${INTERVIEW_STATUS_LABELS[existing.status]} · needs a follow-up`
          : `In Interviews · ${INTERVIEW_STATUS_LABELS[existing.status]}`}
        onClick={e => { e.stopPropagation(); navigate(`/interviews?open=${existing.id}`); }}
      >
        {stale && <i className="ti ti-clock-exclamation" />}
        {INTERVIEW_STATUS_LABELS[existing.status]}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-xs"
        title="They got back to you — start tracking this one in Interviews"
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        <i className="ti ti-user-check" />{compact ? null : ' Interviewing'}
      </button>
      {open && (
        <div onClick={e => e.stopPropagation()}>
          <MoveToInterviewModal
            seed={seed}
            onClose={() => setOpen(false)}
            onCreated={(iv) => { setOpen(false); navigate(`/interviews?open=${iv.id}`); }}
          />
        </div>
      )}
    </>
  );
}
