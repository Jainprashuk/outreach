import { useEffect, useState } from 'react';
import type { Posting, TrackStatus } from '../lib/api';
import { updatePostingApi } from '../lib/api';
import {
  EMPLOYMENT_LABELS, SOURCE_BOARD_URL, SOURCE_LABELS, TRACK_BADGE_CLASS,
  TRACK_STATUS_LABELS, TRACK_STATUS_ORDER, WORKPLACE_LABELS,
} from '../lib/postings';
import { Ext, Field, fmtDateTime as fmt, muted } from './DetailFields';

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="section-title" style={{
    fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase',
    letterSpacing: 0.4, margin: '10px 0 2px',
  }}>{children}</div>
);

export default function PostingDetailModal({ posting, onSaved, onClose, onDelete }: {
  posting: Posting;
  onSaved: () => void;
  onClose: () => void;
  onDelete: (p: Posting) => void;
}) {
  const [applyStatus, setApplyStatus] = useState<TrackStatus>(posting.applyStatus || 'not-applied');
  const [appliedVia, setAppliedVia] = useState(posting.appliedVia || posting.applyUrl || '');
  const [applyNote, setApplyNote] = useState(posting.applyNote || '');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty =
    applyStatus !== (posting.applyStatus || 'not-applied') ||
    appliedVia !== (posting.appliedVia || posting.applyUrl || '') ||
    applyNote !== (posting.applyNote || '');

  const save = async () => {
    setSaving(true);
    setSaveErr('');
    try {
      await updatePostingApi(posting.id, { applyStatus, appliedVia, applyNote });
      onSaved();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const openUrl = posting.applyUrl || posting.url;
  const boardUrl = SOURCE_BOARD_URL[posting.source]?.(posting.boardToken);

  return (
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 640, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'normal' }}>{posting.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              {posting.company || muted('unknown company')}
              {posting.location ? ` · ${posting.location}` : ''}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} style={{ flexShrink: 0 }} type="button">
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ padding: '10px 0 4px' }}>
          <SectionLabel>The posting</SectionLabel>
          <Field label="Status">
            <span className={`badge ${posting.listingStatus === 'open' ? 'badge-approved' : 'badge-closed'}`}>
              {posting.listingStatus === 'open' ? 'Open' : 'Closed'}
            </span>
            {posting.listingStatus === 'closed' && (
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)' }}>
                no longer listed on the board
              </span>
            )}
          </Field>
          <Field label="Board">
            {SOURCE_LABELS[posting.source]} · {boardUrl
              ? <Ext href={boardUrl}>{posting.boardToken}</Ext>
              : posting.boardToken}
          </Field>
          {(posting.department || posting.team) && (
            <Field label="Team">
              {[posting.department, posting.team].filter(Boolean).join(' · ')}
            </Field>
          )}
          {posting.locations.length > 1 && (
            <Field label={`All locations (${posting.locations.length})`}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {posting.locations.map(l => (
                  <span key={l} style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 999,
                    background: 'var(--accent-bg)', color: 'var(--accent)',
                  }}>{l}</span>
                ))}
              </div>
            </Field>
          )}
          <Field label="Workplace">
            {posting.workplaceType
              ? WORKPLACE_LABELS[posting.workplaceType] || posting.workplaceType
              : (posting.remote ? 'Remote (inferred from the location)' : muted('not stated'))}
          </Field>
          <Field label="Employment type">
            {posting.employmentType
              ? EMPLOYMENT_LABELS[posting.employmentType] || posting.employmentType
              : muted('not stated')}
          </Field>
          {posting.country && <Field label="Country">{posting.country}</Field>}
          {posting.requisitionId && <Field label="Requisition">{posting.requisitionId}</Field>}
          <Field label="Link">
            {posting.url ? <Ext href={posting.url}>view the posting</Ext> : muted('none')}
          </Field>

          {/* The only place the self-updating behaviour is visible per row. */}
          <SectionLabel>Timeline</SectionLabel>
          <Field label="Posted">{fmt(posting.postedAt)}</Field>
          <Field label="First seen by you">{fmt(posting.firstSeenAt)}</Field>
          <Field label="Last seen listed">{fmt(posting.lastSeenAt)}</Field>
          <Field label="Seen in">{posting.seenCount} sync{posting.seenCount === 1 ? '' : 's'}</Field>
          {posting.closedAt && <Field label="Closed">{fmt(posting.closedAt)}</Field>}
          {posting.reopenedAt && <Field label="Reopened">{fmt(posting.reopenedAt)}</Field>}
          {posting.closeCount > 0 && (
            <Field label="Times closed">
              {posting.closeCount}
              {posting.closeCount > 1 && (
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text3)' }}>
                  — this role keeps coming back
                </span>
              )}
            </Field>
          )}
          {posting.sourceUpdatedAt && <Field label="Board last updated it">{fmt(posting.sourceUpdatedAt)}</Field>}

          <SectionLabel>Your tracking</SectionLabel>
          <Field label="Status">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={applyStatus} onChange={e => setApplyStatus(e.target.value as TrackStatus)}
                style={{ width: 'auto', minWidth: 150 }}>
                {TRACK_STATUS_ORDER.map(s => (
                  <option key={s} value={s}>{TRACK_STATUS_LABELS[s]}</option>
                ))}
              </select>
              <span className={`badge ${TRACK_BADGE_CLASS[applyStatus]}`}>{TRACK_STATUS_LABELS[applyStatus]}</span>
            </div>
          </Field>
          <Field label="Applied on">
            {posting.appliedAt ? fmt(posting.appliedAt) : muted('—')}
          </Field>
          <Field label="Applied through">
            <input type="text" placeholder="The URL you applied through" value={appliedVia}
              onChange={e => setAppliedVia(e.target.value)} />
            {appliedVia && <div style={{ marginTop: 4 }}><Ext href={appliedVia}>open that link</Ext></div>}
          </Field>
          <Field label="Notes">
            <textarea value={applyNote} onChange={e => setApplyNote(e.target.value)} rows={2}
              placeholder="Referral, recruiter name, next step…"
              style={{ width: '100%', fontSize: 12 }} />
          </Field>

          {(posting.applyHistory || []).length > 0 && (
            <Field label="Journey">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[...(posting.applyHistory || [])].reverse().map((h, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span className={`badge ${TRACK_BADGE_CLASS[h.status] || 'badge-queued'}`}>
                      {TRACK_STATUS_LABELS[h.status] || h.status}
                    </span>
                    <span style={{ color: 'var(--text3)', fontSize: 11 }}>{fmt(h.changedAt)}</span>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {saveErr && (
            <div className="info-box" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginTop: 10 }}>
              <i className="ti ti-alert-triangle" /> {saveErr}
            </div>
          )}

          <SectionLabel>Record</SectionLabel>
          <Field label="First imported">{fmt(posting.createdAt)}</Field>
          <Field label="Last updated">{fmt(posting.updatedAt)}</Field>
          <Field label="Match key" mono>{posting.sourceKey}</Field>
        </div>

        <div className="reply-modal-footer">
          <button className="btn btn-sm" type="button" onClick={() => onDelete(posting)}
            style={{ color: 'var(--red)', borderColor: 'var(--red-bg)', marginRight: 'auto' }}>
            <i className="ti ti-trash" /> Delete
          </button>
          <button className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /> Close</button>
          {dirty && (
            <button className="btn btn-sm btn-primary" type="button" onClick={save} disabled={saving}>
              <i className={`ti ti-${saving ? 'loader' : 'check'}`} /> {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {openUrl && (
            <a className="btn btn-primary" href={openUrl} target="_blank" rel="noopener noreferrer">
              <i className="ti ti-external-link" /> Open posting
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
