// Answer a conversation without leaving the Mailbox: the AI writes a first draft from the
// whole thread, your saved profile and an optional note; you edit it, copy it, or approve
// and send it from your Gmail as a reply inside the same thread.
//
// Sending is always two clicks — "Approve & send", then a confirm naming the recipient —
// because an email can't be taken back. A draft that still has a [placeholder] the AI
// couldn't fill is stopped on the server until you fill it or say "send anyway".
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { draftReplyApi, sendReplyApi, type Contact } from '../lib/api';

const PLACEHOLDER = /\[[^\]\n]{2,40}\]/g;

export default function ReplyComposer({ contact }: { contact: Contact }) {
  const app = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [body, setBody] = useState('');
  const hasResume = !!app.sender.resume;
  // Asked for a resume → attach it by default; you can untick it.
  const [attachResume, setAttachResume] = useState(hasResume && contact.replyCategory === 'resume-requested');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState('');

  const placeholders = body.match(PLACEHOLDER) || [];

  const draft = async () => {
    setOpen(true);
    setDrafting(true);
    setError('');
    setConfirming(false);
    try {
      // The draft is told whether a resume is attached, so it only says so when true.
      const d = await draftReplyApi(contact.id, { note, attachResume });
      setBody(d.body);
      setProvider(d.provider);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDrafting(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      toast('Copied — paste it into your reply in Gmail', 'success');
    } catch {
      toast('Could not copy. Select the text and copy it yourself.', 'error');
    }
  };

  const send = async (allowPlaceholders = false) => {
    setSending(true);
    setError('');
    try {
      const updated = await sendReplyApi(contact.id, { body, attachResume, allowPlaceholders });
      app.replaceContact(updated);
      toast(`Reply sent to ${contact.name}`, 'success');
      setOpen(false);
      setBody('');
      setNote('');
      setConfirming(false);
    } catch (err: any) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <div style={{ display: 'flex', gap: 8, margin: '4px 0 16px', flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" type="button" onClick={() => draft()}>
          <i className="ti ti-sparkles" /> Draft reply with AI
        </button>
        <button className="btn btn-sm" type="button" onClick={() => { setOpen(true); setBody(''); }}>
          <i className="ti ti-pencil" /> Write reply
        </button>
      </div>
    );
  }

  return (
    <div className="reply-composer">
      <div className="reply-composer-head">
        <span><i className="ti ti-corner-up-left" /> Reply to <b>{contact.name}</b> <span className="reply-composer-to">&lt;{contact.email}&gt;</span></span>
        <button className="btn btn-sm" type="button" onClick={() => { setOpen(false); setConfirming(false); }} aria-label="Close reply">
          <i className="ti ti-x" />
        </button>
      </div>

      <div className="reply-composer-note">
        <label htmlFor={`reply-note-${contact.id}`}>Tell the AI what to say (optional)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id={`reply-note-${contact.id}`} type="text" value={note} maxLength={1000}
            placeholder="e.g. open to Bangalore, notice period 30 days, free for a call Thursday"
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !drafting) draft(); }} />
          <button className="btn btn-sm" type="button" disabled={drafting} onClick={() => draft()} style={{ flexShrink: 0 }}>
            {drafting ? <i className="ti ti-loader" /> : <i className="ti ti-sparkles" />} {body ? 'Redraft' : 'Draft'}
          </button>
        </div>
      </div>

      <textarea
        id={`reply-body-${contact.id}`}
        aria-label="Reply text"
        value={body}
        onChange={e => { setBody(e.target.value); setConfirming(false); }}
        placeholder={drafting ? 'Writing a draft…' : 'Write your reply…'}
        disabled={drafting}
        rows={9}
      />

      {placeholders.length > 0 && (
        <div className="reply-composer-warn">
          <i className="ti ti-alert-triangle" /> Fill in {placeholders.join(', ')} — the AI didn't have this fact.
          {' '}<Link to="/settings">Add it to your reply profile</Link> so it's there next time.
        </div>
      )}
      {error && <div className="reply-composer-error"><i className="ti ti-alert-circle" /> {error}</div>}

      <div className="reply-composer-foot">
        {hasResume ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={attachResume} onChange={e => setAttachResume(e.target.checked)} />
            Attach resume
          </label>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{provider ? `Drafted by ${provider} · ` : ''}No resume uploaded</span>
        )}
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" type="button" disabled={!body.trim()} onClick={copy}>
            <i className="ti ti-copy" /> Copy
          </button>
          {!confirming ? (
            <button className="btn btn-sm btn-primary" type="button" disabled={!body.trim() || drafting || sending}
              onClick={() => setConfirming(true)}>
              <i className="ti ti-send" /> Approve &amp; send
            </button>
          ) : (
            <>
              <button className="btn btn-sm" type="button" onClick={() => setConfirming(false)} disabled={sending}>Cancel</button>
              <button className="btn btn-sm btn-primary" type="button" disabled={sending}
                onClick={() => send(placeholders.length > 0)}>
                {sending ? <i className="ti ti-loader" /> : <i className="ti ti-send" />}
                {' '}{placeholders.length ? 'Send anyway' : `Send to ${contact.email}`}{attachResume ? ' with resume' : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
