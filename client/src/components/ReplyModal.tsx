import { useEffect } from 'react';
import type { Contact } from '../lib/api';
import Avatar from './Avatar';
import { useApp } from '../context/AppContext';

export default function ReplyModal({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
  const { updateContact } = useApp();

  // Auto-mark as read when opened (same as classic UI)
  useEffect(() => {
    if (contact && !contact.replyRead) {
      updateContact(contact.id, { replyRead: true }).catch(() => {});
    }
  }, [contact?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!contact) return null;

  const repliedDate = contact.repliedAt
    ? new Date(contact.repliedAt).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown date';

  return (
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 540 }}>
        <div className="reply-modal-header">
          <div className="contact-chip">
            <Avatar name={contact.name} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{contact.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {contact.email}{contact.company ? ` · ${contact.company}` : ''}
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} style={{ flexShrink: 0 }} type="button"><i className="ti ti-x" /></button>
        </div>
        <div className="reply-meta">
          {contact.sentSubject ? (
            <span><i className="ti ti-mail" /> Re: <em>{contact.sentSubject}</em></span>
          ) : null}
          <span><i className="ti ti-calendar" /> Replied on {repliedDate}</span>
        </div>
        <div className={`reply-bubble${contact.replySnippet ? '' : ' empty'}`}>
          {contact.replySnippet || 'No reply content was captured.'}
        </div>
        <div className="reply-modal-footer">
          <button className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /> Close</button>
        </div>
      </div>
    </div>
  );
}
