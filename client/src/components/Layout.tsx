import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../context/SessionContext';
import { useInterviews } from '../context/InterviewContext';
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
  const { owner } = useSession();
  const { reminders } = useInterviews();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  // The six routes worth reaching in one click stay at the top level; the rest
  // live in a group that remembers whether it was open.
  const OTHERS = ['/add-contacts', '/jobs', '/templates', '/export-contacts'];
  const inOthers = OTHERS.some(p => pathname === p || pathname.startsWith(p + '/'));
  const [othersOpen, setOthersOpen] = useState(() => {
    try { return localStorage.getItem('outreach-nav-others') === 'open'; } catch { return false; }
  });
  // Never hide the page you are actually on.
  const showOthers = othersOpen || inOthers;
  useEffect(() => {
    try { localStorage.setItem('outreach-nav-others', othersOpen ? 'open' : 'closed'); } catch { /* private mode */ }
  }, [othersOpen]);
  // Everything the reminder popup would nag about, surfaced permanently in the rail
  // so a dismissed popup doesn't mean a forgotten interview.
  const needsAttention = reminders.soon.length + reminders.stale.length;

  const nav = (
    <>
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon"><i className="ti ti-send" /></div>
        <span className="sidebar-logo-text">Outreach</span>
      </div>
      <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-layout-dashboard" /> Dashboard
      </NavLink>
      <NavLink to="/analytics" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-chart-histogram" /> Analytics
      </NavLink>
      {/* High up on purpose: the people who actually got back to you are the
          ones worth checking first. Both Contacts and Leads feed this. */}
      <NavLink to="/interviews" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-user-check" /> Interviews
        {needsAttention > 0 && (
          <span className="tab-badge" title="Upcoming interviews or follow-ups due">{needsAttention}</span>
        )}
      </NavLink>
      <NavLink to="/contacts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-users" /> Contacts
      </NavLink>
      <NavLink to="/leads" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-target-arrow" /> Leads
      </NavLink>
      <NavLink to="/campaigns" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-calendar-repeat" /> Campaigns
      </NavLink>

      <button type="button" className={`nav-item nav-group${inOthers && !othersOpen ? ' has-active' : ''}`}
        aria-expanded={showOthers} aria-controls="nav-others"
        onClick={() => setOthersOpen(o => !o)}>
        <i className="ti ti-dots" /> Others
        <i className={`ti ti-chevron-down nav-caret${showOthers ? ' open' : ''}`} />
      </button>
      <div id="nav-others" className="nav-children" hidden={!showOthers}>
        <NavLink to="/add-contacts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
          <i className="ti ti-user-plus" /> Add Contacts
        </NavLink>
        <NavLink to="/jobs" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
          <i className="ti ti-briefcase" /> Jobs
        </NavLink>
        <NavLink to="/templates" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
          <i className="ti ti-file-text" /> Templates
        </NavLink>
        <NavLink to="/export-contacts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
          <i className="ti ti-file-export" /> Export Contacts
        </NavLink>
      </div>

      <div className="nav-section-label">Account</div>
      <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setMenuOpen(false)}>
        <i className="ti ti-settings" /> Settings
      </NavLink>
      <div className="sidebar-bottom">
        <button className="theme-toggle" type="button" onClick={toggleTheme}>
          <span className="tt-icon"><i className="ti ti-sun" /><i className="ti ti-moon" />Appearance</span>
          <i className="ti ti-chevron-right" style={{ fontSize: 12 }} />
        </button>
        {owner && (
          <>
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
          </>
        )}
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
          {actions ? <div className="topbar-actions">{actions}</div> : null}
        </div>
        {wide ? children : <div className="section" style={{ flex: 1 }}>{children}</div>}
      </div>
      <SendJobWidget />
    </div>
  );
}
