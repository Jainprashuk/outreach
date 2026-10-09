import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext';
import Avatar from './Avatar';

/** Who is signed in, top right. Name on the button; email, Settings and Sign out inside. */
export default function UserMenu() {
  const { user, logout } = useSession();
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

  if (!user) return null;
  // Accounts created before names were collected have none; the email's local part is the fallback.
  const display = user.name?.trim() || user.email.split('@')[0];

  return (
    <div className="usermenu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="usermenu-btn" aria-expanded={open} aria-haspopup="menu"
        onClick={() => setOpen(o => !o)}>
        <Avatar name={display} />
        <span className="usermenu-name">{display}</span>
        <i className="ti ti-chevron-down usermenu-caret" />
      </button>
      {open && (
        <div className="usermenu-panel" role="menu">
          <div className="usermenu-id">
            <strong>{display}</strong>
            <span>{user.email}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate('/settings'); }}>
            <i className="ti ti-settings" /> Settings
          </button>
          <button type="button" role="menuitem" onClick={logout}>
            <i className="ti ti-logout" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
