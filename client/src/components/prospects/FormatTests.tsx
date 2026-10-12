// The test emails sent from "Test format" at one company, and what happened to each:
// still sending, waiting for bounces, no bounce (confirm it), replied, or bounced (try
// another format or person). Status comes from the contact, worked out on the server.
// Nothing polls: Refresh scans the mailbox and reloads these results.
import type { FormatTest } from '../../lib/api';
import { ago } from './SearchReport';

const LOOK: Record<FormatTest['status'], { icon: string; color: string; label: string }> = {
  sending:        { icon: 'ti ti-loader-2 tc-spin', color: 'var(--accent)', label: 'Sending' },
  held:           { icon: 'ti ti-clock-pause', color: 'var(--amber)', label: 'Held — Gmail limit' },
  waiting:        { icon: 'ti ti-mail-forward', color: 'var(--blue)', label: 'Sent — waiting for bounces' },
  'no-bounce':    { icon: 'ti ti-circle-check', color: 'var(--green)', label: 'No bounce' },
  replied:        { icon: 'ti ti-message-check', color: 'var(--green)', label: 'Replied' },
  bounced:        { icon: 'ti ti-circle-x', color: 'var(--red)', label: 'Bounced' },
  'bounce-other': { icon: 'ti ti-alert-triangle', color: 'var(--amber)', label: 'Bounced (not about the address)' },
  failed:         { icon: 'ti ti-alert-triangle', color: 'var(--amber)', label: 'Not sent' },
  gone:           { icon: 'ti ti-circle-minus', color: 'var(--text3)', label: 'Contact deleted' },
};

export default function FormatTests({ tests, lastMailboxCheckAt, confirmedPattern, busy, checking, onCheckMailbox, onConfirm, onRetry }: {
  tests: FormatTest[];
  lastMailboxCheckAt: string | null;
  /** The format currently set by a confirmed test, if any. */
  confirmedPattern: string | null;
  busy: boolean;
  checking: boolean;
  onCheckMailbox: () => void;
  onConfirm: (t: FormatTest) => void;
  onRetry: (pre: { prospectId?: string; pattern?: string }) => void;
}) {
  if (!tests.length) return null;
  const pending = tests.some(t => t.status === 'waiting' || t.status === 'sending');

  const text = (t: FormatTest): string => {
    switch (t.status) {
      case 'sending': return 'Queued — goes out in a moment.';
      case 'held': return t.reason;
      case 'waiting': {
        const due = t.checkAfter ? new Date(t.checkAfter) : null;
        const soon = due && due.getTime() > Date.now();
        return `Sent ${ago(t.sentAt)}. ${soon ? `Bounces usually arrive within minutes — press Refresh after ${due!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Press Refresh to see if it bounced.'}`;
      }
      case 'no-bounce': return `Sent ${ago(t.sentAt)} and nothing bounced. If you’re happy, confirm ${t.pattern} for everyone at this company.`;
      case 'replied': return `${t.name.split(' ')[0]} replied — the address is real.`;
      case 'bounced': return `${t.reason || 'The address doesn’t exist'}. Either the format is wrong, or ${t.name.split(' ')[0]} has left.`;
      case 'bounce-other': return `${t.reason || 'Bounced'} — this says nothing about the format. Try someone else.`;
      case 'failed': return t.reason;
      case 'gone': return 'The contact was deleted, so the result can’t be read.';
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          <i className="ti ti-flask" /> Format tests
          <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: 8, fontSize: 12 }}>
            mailbox checked {lastMailboxCheckAt ? ago(lastMailboxCheckAt) : 'never'}
          </span>
        </div>
        <button type="button" className={`btn btn-xs${pending ? ' btn-primary' : ''}`} disabled={checking} onClick={onCheckMailbox}
          title="Scan your Gmail for bounces and replies, then reload these results (takes up to a minute)">
          {checking ? <><i className="ti ti-loader-2 tc-spin" /> Refreshing…</> : <><i className="ti ti-refresh" /> Refresh</>}
        </button>
      </div>
      <ol className="tc-steps" style={{ margin: 0 }}>
        {tests.map(t => {
          const look = LOOK[t.status];
          const confirmed = !!t.confirmedAt && confirmedPattern === t.pattern;
          return (
            <li key={t.id} className="tc-step">
              <i className={look.icon} style={{ color: look.color }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="tc-step-title">
                  {t.email} <span style={{ fontWeight: 400, color: 'var(--text3)' }}>· {t.pattern || 'own address'} · {look.label}{confirmed ? ' · confirmed' : ''}</span>
                </div>
                <div className="tc-step-text">{t.name} · {text(t)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {(t.status === 'no-bounce' || t.status === 'replied') && !confirmed && t.pattern && (
                  <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => onConfirm(t)}>
                    <i className="ti ti-check" /> Confirm {t.pattern}
                  </button>
                )}
                {t.status === 'bounced' && (
                  <>
                    <button type="button" className="btn btn-xs" disabled={busy} onClick={() => onRetry({ prospectId: t.prospectId })}
                      title={`Same person, another format`}>
                      Try another format
                    </button>
                    <button type="button" className="btn btn-xs" disabled={busy} onClick={() => onRetry({ pattern: t.pattern || undefined })}
                      title="Same format, another person — in case they left">
                      Try another person
                    </button>
                  </>
                )}
                {(t.status === 'bounce-other' || t.status === 'failed') && (
                  <button type="button" className="btn btn-xs" disabled={busy} onClick={() => onRetry({ pattern: t.pattern || undefined })}>
                    Try another person
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
