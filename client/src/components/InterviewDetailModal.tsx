import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { Field, muted } from './DetailFields';
import { useInterviews } from '../context/InterviewContext';
import { useToast } from '../context/ToastContext';
import {
  interviewFileUrl, type Interview, type InterviewFileKind, type InterviewMode,
  type InterviewStatus, type WorkMode,
} from '../lib/api';
import {
  daysSinceActivity, formatBytes, fromLocalInputValue, historyBadgeClass, historyLabel,
  INTERVIEW_BADGE_CLASS, INTERVIEW_STATUS_LABELS, INTERVIEW_STATUS_ORDER, isStale,
  MODE_LABELS, STALE_DAYS, toLocalInputValue, whenLabel, WORK_MODE_LABELS,
} from '../lib/interviews';

const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';

// The form mirrors every editable field so one Save round-trips the whole record.
interface Form {
  name: string; email: string; phone: string; company: string; role: string;
  status: InterviewStatus; rejectionReason: string;
  interviewAt: string; round: string; mode: InterviewMode; meetingLink: string;
  expectedCtc: string; offeredCtc: string; noticePeriod: string; location: string; workMode: WorkMode;
  notes: string;
}

const formOf = (iv: Interview): Form => ({
  name: iv.name, email: iv.email || '', phone: iv.phone || '',
  company: iv.company || '', role: iv.role || '',
  status: iv.status, rejectionReason: iv.rejectionReason || '',
  interviewAt: toLocalInputValue(iv.interviewAt),
  round: iv.round || '', mode: iv.mode || '', meetingLink: iv.meetingLink || '',
  expectedCtc: iv.expectedCtc || '', offeredCtc: iv.offeredCtc || '',
  noticePeriod: iv.noticePeriod || '', location: iv.location || '',
  workMode: iv.workMode || '', notes: iv.notes || '',
});

const SECTION: React.CSSProperties = {
  fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase',
  letterSpacing: 0.4, margin: '18px 0 6px', fontWeight: 600,
};

/** Label + control, stacked. The detail modal's editable counterpart to <Field>. */
function Input({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
        {label}
        {hint ? <span style={{ color: 'var(--text3)' }}> · {hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

const ROW: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 };

export default function InterviewDetailModal({ interview, onClose }: {
  interview: Interview;
  onClose: () => void;
}) {
  const store = useInterviews();
  const toast = useToast();

  const [form, setForm] = useState<Form>(() => formOf(interview));
  const [saving, setSaving] = useState(false);
  const [busyKind, setBusyKind] = useState<InterviewFileKind | null>(null);
  const [err, setErr] = useState('');
  const cvRef = useRef<HTMLInputElement>(null);
  const jdRef = useRef<HTMLInputElement>(null);

  // The list can refresh underneath an open modal (upload, follow-up); pull the
  // fresh row so file metadata and history stay in step without losing edits.
  const live = store.interviews.find(x => x.id === interview.id) || interview;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const original = useMemo(() => formOf(live), [live]);
  const dirty = (Object.keys(form) as Array<keyof Form>).some(k => form[k] !== original[k]);
  const statusChanged = form.status !== live.status;
  const stale = isStale(live);

  const save = async () => {
    if (!form.name.trim()) { setErr('A name is required'); return; }
    // A rejection you can't explain later is a rejection you'll re-litigate.
    if (statusChanged && form.status === 'rejected' && !form.rejectionReason.trim()) {
      setErr('Add a reason for the rejection — it goes into the status history.');
      return;
    }
    setSaving(true); setErr('');
    try {
      await store.update(live.id, { ...form, interviewAt: fromLocalInputValue(form.interviewAt) });
      toast('Interview updated', 'success');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const followUp = async () => {
    try {
      await store.markFollowedUp(live.id);
      toast('Marked as followed up', 'success');
    } catch (e: any) {
      toast('Could not update: ' + e.message, 'error');
    }
  };

  const pickFile = async (kind: InterviewFileKind, file: File | undefined) => {
    if (!file) return;
    setBusyKind(kind); setErr('');
    try {
      await store.uploadFile(live.id, kind, file);
      toast(`${kind.toUpperCase()} uploaded`, 'success');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyKind(null);
    }
  };

  const dropFile = async (kind: InterviewFileKind) => {
    if (!window.confirm(`Remove the stored ${kind.toUpperCase()}?`)) return;
    setBusyKind(kind);
    try {
      await store.removeFile(live.id, kind);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyKind(null);
    }
  };

  const del = async () => {
    if (!window.confirm(`Remove ${live.name} from Interviews? The original contact or lead is left untouched.`)) return;
    try {
      await store.remove(live.id);
      toast('Removed from Interviews', 'success');
      onClose();
    } catch (e: any) {
      toast('Could not remove: ' + e.message, 'error');
    }
  };

  const sourceLink = live.sourceType === 'contact' ? '/contacts'
    : live.sourceType === 'lead' ? '/leads' : null;

  const fileRow = (kind: InterviewFileKind, label: string, accept: string, ref: React.RefObject<HTMLInputElement>) => {
    const file = live[kind];
    return (
      <div style={{
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        padding: 12, marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
            {file ? (
              <div style={{ fontSize: 12, color: 'var(--text2)', wordBreak: 'break-all' }}>
                {file.filename} · {formatBytes(file.size)} · {fmtDateTime(file.uploadedAt)}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Nothing uploaded yet</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {file && (
              <a className="btn btn-sm" href={interviewFileUrl(live.id, kind)}>
                <i className="ti ti-download" /> Download
              </a>
            )}
            <button className="btn btn-sm" type="button" disabled={busyKind === kind}
              onClick={() => ref.current?.click()}>
              <i className="ti ti-upload" /> {file ? 'Replace' : 'Upload'}
            </button>
            {file && (
              <button className="btn btn-sm" type="button" disabled={busyKind === kind}
                onClick={() => dropFile(kind)} style={{ color: 'var(--red)' }}>
                <i className="ti ti-trash" />
              </button>
            )}
          </div>
        </div>
        <input ref={ref} type="file" accept={accept} style={{ display: 'none' }}
          onChange={e => { pickFile(kind, e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    );
  };

  // Portalled for the same reason as MoveToInterviewModal — see the note there.
  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" style={{ maxWidth: 720, maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div className="contact-chip" style={{ minWidth: 0 }}>
            <Avatar name={live.name} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'normal' }}>{live.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {[live.role, live.company].filter(Boolean).join(' · ') || muted('no company or role set')}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <span className={`badge ${INTERVIEW_BADGE_CLASS[live.status]}`}>
              {INTERVIEW_STATUS_LABELS[live.status]}
            </span>
            <button className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /></button>
          </div>
        </div>

        {stale && (
          <div className="info-box" style={{
            background: 'var(--amber-bg)', color: 'var(--amber)', borderColor: 'transparent', marginTop: 12,
          }}>
            <i className="ti ti-clock-exclamation" />
            <span>
              No update for {daysSinceActivity(live)} days. Chase it, or{' '}
              <a href="#" onClick={e => { e.preventDefault(); followUp(); }}>mark it as followed up</a>{' '}
              to reset the {STALE_DAYS}-day timer.
            </span>
          </div>
        )}

        {err && (
          <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent', marginTop: 12 }}>
            <i className="ti ti-alert-triangle" /><span>{err}</span>
          </div>
        )}

        <div style={SECTION}>Status</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {INTERVIEW_STATUS_ORDER.map(s => (
            <button key={s} type="button"
              className={`btn btn-sm${form.status === s ? ' btn-primary' : ''}`}
              onClick={() => set('status', s)}>
              {INTERVIEW_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {form.status === 'rejected' && (
          <Input label="Reason for rejection" hint="stored on the status history">
            <textarea rows={2} value={form.rejectionReason} style={{ width: '100%' }}
              placeholder="e.g. Went with someone with more Kubernetes experience"
              onChange={e => set('rejectionReason', e.target.value)} />
          </Input>
        )}

        <div style={SECTION}>Who</div>
        <div style={ROW}>
          <Input label="Name"><input type="text" value={form.name} style={{ width: '100%' }}
            onChange={e => set('name', e.target.value)} /></Input>
          <Input label="Phone" hint="add or override">
            <input type="tel" value={form.phone} style={{ width: '100%' }} placeholder="+91 …"
              onChange={e => set('phone', e.target.value)} /></Input>
          <Input label="Email" hint="add or override">
            <input type="email" value={form.email} style={{ width: '100%' }}
              onChange={e => set('email', e.target.value)} /></Input>
          <Input label="Company"><input type="text" value={form.company} style={{ width: '100%' }}
            onChange={e => set('company', e.target.value)} /></Input>
          <Input label="Role"><input type="text" value={form.role} style={{ width: '100%' }}
            onChange={e => set('role', e.target.value)} /></Input>
        </div>

        <div style={SECTION}>Interview</div>
        <div style={ROW}>
          <Input label="Date & time" hint="drives the reminder">
            <input type="datetime-local" value={form.interviewAt} style={{ width: '100%' }}
              onChange={e => set('interviewAt', e.target.value)} /></Input>
          <Input label="Round"><input type="text" value={form.round} style={{ width: '100%' }}
            placeholder="e.g. HR screen, Tech 2" onChange={e => set('round', e.target.value)} /></Input>
          <Input label="Mode">
            <select value={form.mode} style={{ width: '100%' }}
              onChange={e => set('mode', e.target.value as InterviewMode)}>
              {(Object.keys(MODE_LABELS) as InterviewMode[]).map(m => (
                <option key={m} value={m}>{MODE_LABELS[m]}</option>
              ))}
            </select></Input>
          <Input label="Meeting link">
            <input type="url" value={form.meetingLink} style={{ width: '100%' }} placeholder="https://…"
              onChange={e => set('meetingLink', e.target.value)} /></Input>
        </div>
        {live.interviewAt && (
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
            <i className="ti ti-calendar-event" /> Scheduled: {whenLabel(live.interviewAt)}
            {live.meetingLink ? (
              <> · <a href={live.meetingLink} target="_blank" rel="noopener noreferrer">join link</a></>
            ) : null}
          </div>
        )}

        <div style={SECTION}>Compensation & logistics</div>
        <div style={ROW}>
          <Input label="Expected CTC"><input type="text" value={form.expectedCtc} style={{ width: '100%' }}
            placeholder="e.g. 24 LPA" onChange={e => set('expectedCtc', e.target.value)} /></Input>
          <Input label="Offered CTC"><input type="text" value={form.offeredCtc} style={{ width: '100%' }}
            placeholder="e.g. 21-23 LPA" onChange={e => set('offeredCtc', e.target.value)} /></Input>
          <Input label="Notice period"><input type="text" value={form.noticePeriod} style={{ width: '100%' }}
            placeholder="e.g. 60 days" onChange={e => set('noticePeriod', e.target.value)} /></Input>
          <Input label="Location"><input type="text" value={form.location} style={{ width: '100%' }}
            placeholder="e.g. Bengaluru" onChange={e => set('location', e.target.value)} /></Input>
          <Input label="Work mode">
            <select value={form.workMode} style={{ width: '100%' }}
              onChange={e => set('workMode', e.target.value as WorkMode)}>
              {(Object.keys(WORK_MODE_LABELS) as WorkMode[]).map(m => (
                <option key={m} value={m}>{WORK_MODE_LABELS[m]}</option>
              ))}
            </select></Input>
        </div>

        <div style={SECTION}>Notes</div>
        <textarea rows={4} value={form.notes} style={{ width: '100%' }}
          placeholder="Anything worth remembering — who called, what they asked, what you promised to send."
          onChange={e => set('notes', e.target.value)} />

        <div style={SECTION}>Documents</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
          Stored per interview — every role gets its own CV and JD. Max 5 MB each.
        </div>
        {fileRow('cv', 'CV shared for this role', '.pdf,.doc,.docx', cvRef)}
        {fileRow('jd', 'Job description from HR', '.pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp', jdRef)}

        <div style={SECTION}>Record</div>
        <Field label="Source">
          {live.sourceType === 'manual' ? muted('Added manually')
            : sourceLink ? (
              <Link to={sourceLink}>
                {live.sourceType === 'contact' ? 'From Contacts' : 'From Leads'}
              </Link>
            ) : muted(live.sourceType)}
        </Field>
        <Field label="Last activity">
          {fmtDateTime(live.lastActivityAt)}
          <span style={{ color: 'var(--text3)' }}> · {daysSinceActivity(live)} day(s) ago</span>
        </Field>
        <Field label="Added">{fmtDateTime(live.createdAt)}</Field>

        <div style={SECTION}>History</div>
        {(live.statusHistory || []).length === 0 ? muted('Nothing recorded yet') : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...(live.statusHistory || [])].reverse().map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 }}>
                <span className={`badge ${historyBadgeClass(h.status)}`} style={{ fontSize: 10 }}>
                  {historyLabel(h.status)}
                </span>
                <span style={{ color: 'var(--text3)' }}>{fmtDateTime(h.changedAt)}</span>
                {h.note ? <span style={{ color: 'var(--text2)' }}>{h.note}</span> : null}
              </div>
            ))}
          </div>
        )}

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'space-between',
          marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border)', flexWrap: 'wrap',
        }}>
          <button className="btn btn-sm" type="button" onClick={del} style={{ color: 'var(--red)' }}>
            <i className="ti ti-trash" /> Remove from Interviews
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" type="button" onClick={followUp}
              title={`Resets the ${STALE_DAYS}-day follow-up timer without changing the status`}>
              <i className="ti ti-bell-check" /> Mark followed up
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={save} disabled={!dirty || saving}>
              {saving ? <><i className="ti ti-loader" /> Saving…</> : <><i className="ti ti-device-floppy" /> Save</>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
