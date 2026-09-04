import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import type { Lead, LeadOutcome } from '../lib/api';
import { deriveCompany, isCompanyDerived, LEAD_BADGE_CLASS, LEAD_STATUS_LABELS } from '../lib/leads';
import { classifyLink, LINK_TYPE_META } from '../lib/linkTypes';
import { contactBadgeClass, contactStatusLabel, stageOf, STAGE_LABELS } from '../lib/leadOutcome';

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';

/** Label + value row. `mono` for ids and keys. */
function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ width: 132, flexShrink: 0, fontSize: 12, color: 'var(--text3)' }}>{label}</div>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 12.5, wordBreak: 'break-word',
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
      }}>
        {children}
      </div>
    </div>
  );
}

const Ext = ({ href, children }: { href: string; children?: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{children || href}</a>
);

const muted = (t: string) => <span style={{ color: 'var(--text3)' }}>{t}</span>;

export default function LeadDetailModal({ lead, allLeads, outcome, onClose, onMove, onDelete }: {
  lead: Lead;
  allLeads: Lead[];
  outcome: LeadOutcome | null;
  onClose: () => void;
  onMove: (lead: Lead) => void;
  onDelete: (lead: Lead) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The importer splits one harvested lead into a row per email address, so the
  // sibling addresses live in other rows. Regroup them on the same identity the
  // dedupe uses.
  const siblings = useMemo(() => {
    const key = (l: Lead) => l.authorUrl || l.authorName;
    return allLeads.filter(l => l.id !== lead.id && key(l) === key(lead));
  }, [allLeads, lead]);

  const derived = deriveCompany(lead);

  return (
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 640, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div className="contact-chip" style={{ minWidth: 0 }}>
            <Avatar name={lead.authorName} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'normal' }}>{lead.authorName}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {lead.email || muted('no email address')}
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} style={{ flexShrink: 0 }} type="button">
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ padding: '10px 0 4px' }}>
          <div className="section-title" style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '10px 0 2px' }}>From the harvester</div>
          <Field label="Fit score">
            <span style={{ color: lead.fitScore === -999 ? 'var(--red)' : undefined }}>
              {lead.fitScore}{lead.fitScore === -999 ? ' · hard reject' : ''}
            </span>
          </Field>
          <Field label="Hiring">{lead.hiring ? 'Yes' : 'No'}</Field>
          <Field label={`Found by (${(lead.queries || []).length})`}>
            {(lead.queries || []).length === 0
              ? muted('no query recorded — re-import to backfill')
              : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {lead.queries.map(q => (
                    <span key={q} style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 999,
                      background: 'var(--accent-bg)', color: 'var(--accent)',
                    }}>{q}</span>
                  ))}
                </div>
              )}
          </Field>
          <Field label="Source">{lead.source || muted('—')}</Field>
          <Field label="Profile">{lead.authorUrl ? <Ext href={lead.authorUrl} /> : muted('—')}</Field>
          <Field label="Post">{lead.postUrl ? <Ext href={lead.postUrl} /> : muted('—')}</Field>
          <Field label={`Links (${lead.links.length})`}>
            {lead.links.length === 0 ? muted('none') : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {lead.links.map((l, i) => {
                  const t = classifyLink(l);
                  return (
                    <div key={i}>
                      <span title={LINK_TYPE_META[t].hint}
                        style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, marginRight: 6,
                          background: t === 'junk' ? 'var(--red-bg)' : 'var(--bg2)',
                          color: t === 'junk' ? 'var(--red)' : 'var(--text2)' }}>
                        <i className={`ti ${LINK_TYPE_META[t].icon}`} /> {LINK_TYPE_META[t].label}
                      </span>
                      {t === 'junk' ? <span style={{ color: 'var(--text3)' }}>{l}</span> : <Ext href={l} />}
                    </div>
                  );
                })}
              </div>
            )}
          </Field>
          <Field label="Harvested at">{fmt(lead.batchUpdatedAt)}</Field>

          <div className="section-title" style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '18px 0 2px' }}>Contact details</div>
          <Field label="Email">{lead.email || muted('none — cannot be moved to outreach')}</Field>
          <Field label="Company">
            {lead.company
              ? lead.company
              : derived
                ? <>{derived} <span style={{ color: 'var(--text3)' }}>· guessed from {lead.email?.split('@')[1]}, not saved yet</span></>
                : muted('—')}
          </Field>
          <Field label="Role">{lead.role || muted('—')}</Field>
          {siblings.length > 0 && (
            <Field label="Other addresses">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {siblings.map(s => (
                  <span key={s.id}>
                    {s.email || muted('(no email)')}
                    <span style={{ color: 'var(--text3)' }}>
                      {' · '}{LEAD_STATUS_LABELS[s.status].toLowerCase()}
                    </span>
                  </span>
                ))}
                <span style={{ color: 'var(--text3)', fontSize: 11 }}>
                  Same person, split into separate rows — one per address.
                </span>
              </div>
            </Field>
          )}

          <div className="section-title" style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '18px 0 2px' }}>Outreach</div>
          <Field label="Lead status">
            <span className={`badge ${LEAD_BADGE_CLASS[lead.status]}`}>{LEAD_STATUS_LABELS[lead.status]}</span>
          </Field>
          <Field label="Moved at">{fmt(lead.promotedAt)}</Field>

          {outcome ? (
            <>
              <Field label="Contact status">
                <span className={`badge ${contactBadgeClass(outcome.status)}`}>{contactStatusLabel(outcome.status)}</span>
                <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{STAGE_LABELS[stageOf(outcome)]}</span>
              </Field>
              <Field label="Template">{outcome.template || muted('none set')}</Field>
              <Field label="First emailed">{fmt(outcome.lastSentAt)}</Field>
              <Field label="Follow-up sent">{fmt(outcome.followUpSentAt)}</Field>
              <Field label="Replied">
                {outcome.repliedAt
                  ? <span style={{ color: 'var(--green)' }}>{fmt(outcome.repliedAt)}</span>
                  : muted('no reply yet')}
              </Field>
              {outcome.replySnippet && (
                <Field label="Their reply">
                  <div className="reply-bubble" style={{ fontSize: 12 }}>{outcome.replySnippet}</div>
                </Field>
              )}
              {outcome.bounceReason && (
                <Field label="Bounce reason">
                  <span style={{ color: 'var(--red)' }}>{outcome.bounceReason}</span>
                </Field>
              )}
              {outcome.failReason && (
                <Field label="Failure"><span style={{ color: 'var(--red)' }}>{outcome.failReason}</span></Field>
              )}
              <Field label="Contact">
                <Link to={`/contacts?search=${encodeURIComponent(lead.email || '')}`} onClick={onClose}>
                  Open in Contacts <i className="ti ti-arrow-right" />
                </Link>
              </Field>
            </>
          ) : (
            <Field label="Contact status">
              {lead.status === 'added-to-outreach'
                ? muted('marked as moved, but no matching contact found — it may have been deleted')
                : muted('not in outreach yet')}
            </Field>
          )}

          <div className="section-title" style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '18px 0 2px' }}>Record</div>
          <Field label="Imported">{fmt(lead.createdAt)}</Field>
          <Field label="Last updated">{fmt(lead.updatedAt)}</Field>
          <Field label="Lead id" mono>{lead.id}</Field>
          <Field label="Match key" mono>{lead.dedupeKey || muted('—')}</Field>
        </div>

        <div className="reply-modal-footer">
          <button className="btn btn-sm" type="button" onClick={() => onDelete(lead)}
            style={{ color: 'var(--red)', borderColor: 'var(--red-bg)', marginRight: 'auto' }}>
            <i className="ti ti-trash" /> Delete
          </button>
          <button className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /> Close</button>
          {lead.email && lead.status === 'new' && (
            <button className="btn btn-primary" type="button" onClick={() => onMove(lead)}>
              <i className="ti ti-user-plus" /> Move to outreach
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
