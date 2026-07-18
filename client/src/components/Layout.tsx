import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import SendJobWidget from './SendJobWidget';

function switchToClassic() {
  document.cookie = 'outreach_ui=classic;path=/;max-age=31536000';
  window.location.href = '/';
}

export default function Layout({ title, subtitle, actions, children, wide }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean; // main content manages its own layout (wizard uses this)
}) {
  const { toggleTheme } = useTheme(); // applies data-theme + provides the toggle
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = (
    <>
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon"><i className="ti ti-send" /></div>
        <span className="sidebar-logo-text">Outreach</span>
      </div>
      <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-layout-dashboard" /> Dashboard
      </NavLink>
      <NavLink to="/contacts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-users" /> Contacts
      </NavLink>
      <NavLink to="/add-contacts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-user-plus" /> Add Contacts
      </NavLink>
      <NavLink to="/templates" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-file-text" /> Templates
      </NavLink>
      <NavLink to="/analytics" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-chart-histogram" /> Analytics
      </NavLink>
      <div className="nav-section-label">Account</div>
      <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-settings" /> Settings
      </NavLink>
      <div className="sidebar-bottom">
        <button className="theme-toggle" type="button" onClick={toggleTheme}>
          <span className="tt-icon"><i className="ti ti-sun" /><i className="ti ti-moon" />Appearance</span>
          <i className="ti ti-chevron-right" style={{ fontSize: 12 }} />
        </button>
        <button
          className="theme-toggle" type="button" onClick={switchToClassic}
          title="Back to the classic HTML interface" style={{ marginTop: 8 }}
        >
          <span className="tt-icon"><i className="ti ti-arrow-back-up" />Classic UI</span>
          <i className="ti ti-chevron-right" style={{ fontSize: 12 }} />
        </button>
        <a
          href="/logout"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', textDecoration: 'none', padding: '6px 0', marginTop: 4 }}
        >
          <i className="ti ti-logout" style={{ fontSize: 14 }} />Sign out
        </a>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>{nav}</aside>
      {menuOpen && <div className="sidebar-backdrop open" onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <div className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu-btn" type="button" aria-label="Menu" onClick={() => setMenuOpen(o => !o)}>
              <i className="ti ti-menu-2" />
            </button>
            <div>
              <h1>{title}</h1>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div style={{ display: 'flex', gap: 10 }}>{actions}</div> : null}
        </div>
        {wide ? children : <div className="section" style={{ flex: 1 }}>{children}</div>}
      </div>
      <SendJobWidget />
    </div>
  );
}
