import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import { useInterviews } from '../context/InterviewContext';
import { useToast } from '../context/ToastContext';
import { AlreadyTrackedError, type Interview, type InterviewSource, type InterviewStatus } from '../lib/api';
import { INTERVIEW_STATUS_LABELS, INTERVIEW_STATUS_ORDER } from '../lib/interviews';

/** What the caller knows about the person before the record exists. */
export interface InterviewSeed {
  sourceType: InterviewSource;
  sourceId?: string | null;
  name: string;
  email?: string;
  company?: string;
  role?: string;
}

/**
 * The "they called me" dialog. Creating an Interview never writes to the source
 * Contact or Lead — anything corrected here is stored on the new record only.
 */
export default function MoveToInterviewModal({ seed, onClose, onCreated }: {
  seed: InterviewSeed;
  onClose: () => void;
  /** Fired for a new record AND for an existing one (409), so the caller can open it. */
  onCreated: (interview: Interview, alreadyExisted: boolean) => void;
}) {
  const store = useInterviews();
  const toast = useToast();

  const [name, setName] = useState(seed.name || '');
  const [email, setEmail] = useState(seed.email || '');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState(seed.company || '');
  const [role, setRole] = useState(seed.role || '');
  const [status, setStatus] = useState<InterviewStatus>('initial-discussion');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!name.trim()) { setErr('A name is required'); return; }
    setSaving(true); setErr('');
    try {
      const created = await store.create({
        sourceType: seed.sourceType,
        sourceId: seed.sourceId ?? null,
        name, email, phone, company, role, status, note,
      });
      toast(`${created.name} is now tracked in Interviews`, 'success');
      onCreated(created, false);
    } catch (e: any) {
      // Already tracked — hand the caller the existing record instead of erroring.
      if (e instanceof AlreadyTrackedError) {
        toast('Already tracked in Interviews — opening that record', 'info');
        await store.reload().catch(() => { /* the modal still opens on the returned row */ });
        onCreated(e.interview, true);
        return;
      }
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      {node}
    </label>
  );

  // Portalled to <body>: this modal is opened from inside a table cell, and
  // .table-card keeps a filled `transform` from its fadeInUp animation, which
  // would otherwise make it the containing block for our position:fixed wrap
  // and clip it with overflow-x. Same reason StatusBadge portals its popups.
  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 520, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div className="contact-chip" style={{ minWidth: 0 }}>
            <Avatar name={name || seed.name || '?'} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Move to Interviews</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {seed.sourceType === 'manual' ? 'New record' : `From ${seed.sourceType}s`}
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /></button>
        </div>

        <div className="info-box" style={{ marginTop: 12 }}>
          <i className="ti ti-info-circle" />
          <span>
            The original {seed.sourceType === 'manual' ? 'record' : seed.sourceType} stays exactly where it is
            with its own status untouched. Details you correct below are stored on the interview record only.
          </span>
        </div>

        {err && (
          <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent' }}>
            <i className="ti ti-alert-triangle" /><span>{err}</span>
          </div>
        )}

        {field('Name', <input type="text" value={name} style={{ width: '100%' }}
          onChange={e => setName(e.target.value)} />)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('Email', <input type="email" value={email} style={{ width: '100%' }}
            placeholder="add or override" onChange={e => setEmail(e.target.value)} />)}
          {field('Phone', <input type="tel" value={phone} style={{ width: '100%' }}
            placeholder="the number they called from" onChange={e => setPhone(e.target.value)} />)}
          {field('Company', <input type="text" value={company} style={{ width: '100%' }}
            onChange={e => setCompany(e.target.value)} />)}
          {field('Role', <input type="text" value={role} style={{ width: '100%' }}
            onChange={e => setRole(e.target.value)} />)}
        </div>

        {field('Where it stands',
          <select value={status} style={{ width: '100%' }}
            onChange={e => setStatus(e.target.value as InterviewStatus)}>
            {INTERVIEW_STATUS_ORDER.map(s => (
              <option key={s} value={s}>{INTERVIEW_STATUS_LABELS[s]}</option>
            ))}
          </select>)}

        {field('Note (optional)',
          <textarea rows={2} value={note} style={{ width: '100%' }}
            placeholder="e.g. Called on 9 Sep about the backend role"
            onChange={e => setNote(e.target.value)} />)}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm btn-primary" type="button" onClick={submit} disabled={saving}>
            {saving ? <><i className="ti ti-loader" /> Adding…</> : <><i className="ti ti-user-check" /> Add to Interviews</>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
