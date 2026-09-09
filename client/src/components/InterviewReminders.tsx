import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Avatar from './Avatar';
import { useInterviews } from '../context/InterviewContext';
import { useToast } from '../context/ToastContext';
import type { Interview } from '../lib/api';
import {
  daysSinceActivity, INTERVIEW_BADGE_CLASS, INTERVIEW_STATUS_LABELS,
  MODE_ICON, MODE_LABELS, STALE_DAYS, whenLabel,
} from '../lib/interviews';

/**
 * Fires once per fresh app load while anything needs attention, and stays gone
 * for the rest of that load once dismissed — client-side navigation does not
 * re-open it, because the provider holding the dismissed flag never remounts.
 *
 * It closes itself the moment the last item is dealt with: marking a stale
 * interview as followed up drops it out of the reminder set, and when both lists
 * empty, `remindersOpen` goes false.
 */
export default function InterviewReminders() {
  const store = useInterviews();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  if (!store.remindersOpen) return null;

  const { soon, stale } = store.reminders;

  const open = (iv: Interview) => {
    store.dismissReminders();
    navigate(`/interviews?open=${iv.id}`);
  };

  const followUp = async (iv: Interview) => {
    setBusy(iv.id);
    try {
      await store.markFollowedUp(iv.id);
      toast(`Marked ${iv.name} as followed up`, 'success');
    } catch (e: any) {
      toast('Could not update: ' + e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const row = (iv: Interview, right: React.ReactNode, sub: React.ReactNode) => (
    <div key={iv.id} style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '10px 0', borderBottom: '1px solid var(--border)',
    }}>
      <Avatar name={iv.name} />
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{iv.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>
          {[iv.role, iv.company].filter(Boolean).join(' · ') || 'No company set'}
        </div>
        <div style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>
      </div>
      <span className={`badge ${INTERVIEW_BADGE_CLASS[iv.status]}`} style={{ fontSize: 10 }}>
        {INTERVIEW_STATUS_LABELS[iv.status]}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>{right}</div>
    </div>
  );

  return (
    <div className="edit-modal-wrap open">
      <div className="edit-modal" style={{ maxWidth: 620, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              <i className="ti ti-bell-ringing" style={{ marginRight: 6, color: 'var(--accent)' }} />
              Interviews need you
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              {soon.length > 0 && `${soon.length} coming up`}
              {soon.length > 0 && stale.length > 0 && ' · '}
              {stale.length > 0 && `${stale.length} with no update in ${STALE_DAYS}+ days`}
            </div>
          </div>
          <button className="btn btn-sm" type="button" onClick={store.dismissReminders}>
            <i className="ti ti-x" />
          </button>
        </div>

        {soon.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '16px 0 2px', fontWeight: 600 }}>
              Interview coming up
            </div>
            {soon.map(iv => row(iv,
              <>
                {iv.meetingLink && (
                  <a className="btn btn-sm" href={iv.meetingLink} target="_blank" rel="noopener noreferrer">
                    <i className="ti ti-external-link" /> Join
                  </a>
                )}
                <button className="btn btn-sm btn-primary" type="button" onClick={() => open(iv)}>Open</button>
              </>,
              <span style={{ color: 'var(--amber)', fontWeight: 600 }}>
                <i className={`ti ${MODE_ICON[iv.mode]}`} style={{ marginRight: 4 }} />
                {whenLabel(iv.interviewAt)}
                {iv.round ? ` · ${iv.round}` : ''}
                {iv.mode ? ` · ${MODE_LABELS[iv.mode]}` : ''}
              </span>,
            ))}
          </>
        )}

        {stale.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '16px 0 2px', fontWeight: 600 }}>
              Time to follow up
            </div>
            {stale.map(iv => row(iv,
              <>
                <button className="btn btn-sm" type="button" disabled={busy === iv.id}
                  onClick={() => followUp(iv)}
                  title={`Resets the ${STALE_DAYS}-day timer without changing the status`}>
                  <i className="ti ti-bell-check" /> Followed up
                </button>
                <button className="btn btn-sm btn-primary" type="button" onClick={() => open(iv)}>Open</button>
              </>,
              <span style={{ color: 'var(--text3)' }}>
                No update for {daysSinceActivity(iv)} days
              </span>,
            ))}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" type="button"
            onClick={() => { store.dismissReminders(); navigate('/interviews'); }}>
            <i className="ti ti-users-group" /> Open Interviews
          </button>
          <button className="btn btn-sm" type="button" onClick={store.dismissReminders}>
            Remind me next visit
          </button>
        </div>
      </div>
    </div>
  );
}
