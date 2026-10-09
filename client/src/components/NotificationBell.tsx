import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationContext';
import { relativeTime } from '../lib/format';
import type { NotificationSeverity } from '../lib/api';

const ICON: Record<NotificationSeverity, string> = {
  success: 'ti-circle-check',
  info: 'ti-info-circle',
  warning: 'ti-alert-triangle',
  error: 'ti-circle-x',
};

/** The bell next to "New entry": unread badge, and a feed of what the app did for you. */
export default function NotificationBell() {
  const { items, unread, hasUnreadError, markRead, markAllRead, clear, clearAll } = useNotifications();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openItem = (id: string, link: string, read: boolean) => {
    if (!read) markRead([id]).catch(() => {});
    if (link) { setOpen(false); navigate(link); }
  };

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="notif-btn"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)}>
        <i className="ti ti-bell" />
        {unread > 0 && (
          <span className={`notif-badge${hasUnreadError ? ' error' : ''}`}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <span className="notif-head-actions">
              <button type="button" className="notif-markall" disabled={unread === 0} onClick={() => markAllRead()}>
                Mark all read
              </button>
              <button type="button" className="notif-markall" disabled={items.length === 0} onClick={() => clearAll()}>
                Clear all
              </button>
            </span>
          </div>
          {items.length === 0 ? (
            <div className="notif-empty">
              <i className="ti ti-bell-check" />
              <div>You're all caught up</div>
              <span>Finished sends, new replies and anything that needs you will show up here.</span>
            </div>
          ) : (
            <ul className="notif-list">
              {items.map(n => (
                <li key={n.id} className="notif-row">
                  <button type="button" className={`notif-item${n.read ? '' : ' unread'}`}
                    onClick={() => openItem(n.id, n.link, n.read)}>
                    <span className={`notif-icon ${n.severity}`}><i className={`ti ${ICON[n.severity]}`} /></span>
                    <span className="notif-text">
                      <span className="notif-title">{n.title}</span>
                      {n.body && <span className="notif-body">{n.body}</span>}
                      <span className="notif-time">{relativeTime(n.createdAt)}</span>
                    </span>
                    {!n.read && <span className="notif-dot" aria-label="Unread" />}
                  </button>
                  <button type="button" className="notif-clear" aria-label={`Clear: ${n.title}`} title="Clear"
                    onClick={() => clear(n.id)}>
                    <i className="ti ti-x" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
