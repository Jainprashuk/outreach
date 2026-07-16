// Port of statusBadge + openStatusEdit + showStatusHistory from js/app.js.
// Hover → status-history popup; double-click → status-edit dropdown (when editable).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BADGE_CLASS, STATUS_LABELS, STATUS_OPTIONS } from '../lib/format';
import type { Contact } from '../lib/api';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';

const fmtDate = (d: string) => new Date(d).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export default function StatusBadge({ status, contact, onChanged }: {
  status: string;
  contact?: Contact;         // provided → hover history + dblclick edit enabled
  onChanged?: () => void;
}) {
  const { updateContact } = useApp();
  const toast = useToast();
  const badgeRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [popup, setPopup] = useState<{ top: number; left: number } | null>(null);
  const [dropdown, setDropdown] = useState<{ top: number; left: number } | null>(null);

  const editable = !!contact;

  const openHistory = () => {
    if (!editable || dropdown) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = badgeRef.current!.getBoundingClientRect();
    setPopup({ top: rect.bottom + 6, left: rect.left });
  };

  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setPopup(null), 150);
  };

  const openEdit = (e: React.MouseEvent) => {
    if (!editable) return;
    e.stopPropagation();
    setPopup(null);
    const rect = badgeRef.current!.getBoundingClientRect();
    setDropdown({ top: rect.bottom + 4, left: rect.left });
  };

  // Close the dropdown on any outside click (mirrors the once-listener in app.js)
  useEffect(() => {
    if (!dropdown) return;
    const close = () => setDropdown(null);
    const t = setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', close); };
  }, [dropdown]);

  const pick = async (value: string) => {
    setDropdown(null);
    if (!contact || value === contact.status) return;
    try {
      await updateContact(contact.id, { status: value as Contact['status'] });
      onChanged?.();
    } catch (err: any) {
      toast('Could not update status: ' + err.message, 'error');
    }
  };

  const history = contact?.statusHistory || [];

  return (
    <>
      <span
        ref={badgeRef}
        className={`badge ${BADGE_CLASS[status] || 'badge-queued'}`}
        onDoubleClick={editable ? openEdit : undefined}
        onMouseEnter={editable ? openHistory : undefined}
        onMouseLeave={editable ? scheduleHide : undefined}
        style={editable ? { cursor: 'pointer' } : undefined}
        title={editable ? 'Hover: history · Double-click: change' : undefined}
      >
        {STATUS_LABELS[status] || status}
      </span>

      {popup && createPortal(
        <div
          className="status-history-popup"
          style={{ top: popup.top, left: popup.left }}
          onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); }}
          onMouseLeave={scheduleHide}
        >
          <div className="sh-title">Status History</div>
          {history.length ? [...history].reverse().map((h, i) => (
            <div className="sh-row" key={i}>
              <span className={`badge ${BADGE_CLASS[h.status] || 'badge-queued'}`} style={{ fontSize: 10 }}>
                {STATUS_LABELS[h.status] || h.status}
              </span>
              <span className="sh-date">{fmtDate(h.changedAt)}</span>
              {h.note ? <span className="sh-note">{h.note}</span> : null}
            </div>
          )) : (
            <div style={{ color: 'var(--text3)', fontSize: 12, padding: '4px 0' }}>No history recorded yet</div>
          )}
        </div>,
        document.body,
      )}

      {dropdown && createPortal(
        <div className="status-edit-dropdown" style={{ top: dropdown.top, left: dropdown.left }}>
          {STATUS_OPTIONS.map(opt => (
            <div
              key={opt.value}
              className={`status-edit-option${opt.value === status ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(opt.value); }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
