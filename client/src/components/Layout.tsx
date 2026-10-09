import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../context/SessionContext';
import { useInterviews } from '../context/InterviewContext';
import { useActionQueue } from '../context/ActionQueueContext';
import SendJobWidget from './SendJobWidget';
import NavTip from './NavTip';
import NotificationBell from './NotificationBell';
import UserMenu from './UserMenu';

/** One sidebar link. The label sits in its own span so the collapsed rail can hide it
 *  with CSS, and carries a native tooltip while collapsed since the text is gone. */
function NavItem({ to, end, icon, label, tip, badge, badgeTitle, collapsed, onNavigate }: {
  to: string; end?: boolean; icon: string; label: string; tip: string;
  badge?: number; badgeTitle?: string; collapsed: boolean; onNavigate: () => void;
}) {
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={onNavigate}>
      <i className={`ti ${icon}`} /> <span className="nav-label">{label}</span>
      {badge ? <span className="tab-badge" title={badgeTitle}>{badge}</span> : null}
      <NavTip text={tip} />
    </NavLink>
  );
}

export default function Layout({ title, subtitle, actions, children, wide, minimal }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean; // main content manages its own layout (wizard uses this)
  /** Hides the nav links but keeps the logo, theme toggle, account and Sign out.
   *  For first-run setup, where every nav link would bounce straight back here —
   *  showing links that do not work is worse than showing none. */
  minimal?: boolean;
}) {
  const { theme, toggleTheme } = useTheme(); // applies data-theme + provides the toggle
  const { owner, isAdmin } = useSession();
  const { reminders } = useInterviews();
  const actionQueue = useActionQueue();
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop only: a 64px icon rail. The phone drawer is always full width (see theme.css).
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('outreach-sidebar') === 'collapsed'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('outreach-sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* private mode */ }
  }, [collapsed]);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  // A drawer that covers the page has to be dismissable from the keyboard, and
  // focus has to come back to the control that opened it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuOpen(false); menuBtnRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // The six routes worth reaching in one click stay at the top level; the rest
  // live in a group that remembers whether it was open.
  const OTHERS = ['/add-contacts', '/jobs', '/templates', '/blocklist', '/export-contacts'];
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
  const needsYou = actionQueue.counts['needs-you'];

  const close = () => setMenuOpen(false);
  const item = (to: string, icon: string, label: string, tip: string, extra: { end?: boolean; badge?: number; badgeTitle?: string } = {}) => (
    <NavItem to={to} icon={icon} label={label} tip={tip} collapsed={collapsed} onNavigate={close} {...extra} />
  );

  const nav = (
    <>
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon"><i className="ti ti-send" /></div>
        <span className="sidebar-logo-text">Outreach</span>
        <button type="button" className="sidebar-collapse-btn" onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <i className={`ti ${collapsed ? 'ti-layout-sidebar-left-expand' : 'ti-layout-sidebar-left-collapse'}`} />
        </button>
      </div>
      {!minimal && (<>
      {item('/', 'ti-layout-dashboard', 'Dashboard', 'Your outreach at a glance — replies waiting on you, sent, bounced and follow-ups due — with every contact below it.', { end: true })}
      {item('/analytics', 'ti-chart-histogram', 'Analytics', 'How your outreach is doing: the reply funnel, which templates and companies work, response speed — plus reports as a PDF or by email.')}
      {/* High up on purpose: the people who actually got back to you are the
          ones worth checking first. Both Contacts and Leads feed this. */}
      {item('/interviews', 'ti-user-check', 'Interviews', 'People who got back to you, and the interviews in progress — stages, dates and reminders.',
        { badge: needsAttention, badgeTitle: 'Upcoming interviews or follow-ups due' })}
      {item('/contacts', 'ti-users', 'Contacts', 'Everyone in your outreach. Search and filter by status, edit details, or pick people to email.')}
      {item('/mailbox', 'ti-mail-opened', 'Mailbox', 'Replies to your emails. “Needs you” lists the ones waiting for your answer — reply right from here.',
        { badge: needsYou, badgeTitle: 'Replies waiting on you' })}
      {item('/leads', 'ti-target-arrow', 'Leads', 'Hiring posts collected from LinkedIn, with recruiters’ emails and apply links. Move the good ones to outreach.')}
      {item('/discover', 'ti-compass', 'Discover', 'Type a company: find people who work there and guess their work email. You choose who moves to outreach.')}
      {item('/naukri', 'ti-briefcase-2', 'Naukri', 'Keeps your Naukri profile fresh and applies to the jobs you approve, using a worker on your computer.')}
      {item('/campaigns', 'ti-calendar-repeat', 'Campaigns', 'Hands-off sending: give it a list and it emails a set number of people a day for you.')}
      {item('/logs', 'ti-list-details', 'Logs', 'A record of everything the app did — sends, imports, scrapes, errors — for checking what happened and when.')}

      <button type="button" className={`nav-item nav-group${inOthers && !othersOpen ? ' has-active' : ''}`}
        aria-expanded={showOthers} aria-controls="nav-others" title={collapsed ? 'Others' : undefined}
        onClick={() => setOthersOpen(o => !o)}>
        <i className="ti ti-dots" /> <span className="nav-label">Others</span>
        <i className={`ti ti-chevron-down nav-caret${showOthers ? ' open' : ''}`} />
      </button>
      <div id="nav-others" className="nav-children" hidden={!showOthers}>
        {item('/add-contacts', 'ti-user-plus', 'Add Contacts', 'Add people to your outreach — upload a CSV or type them in.')}
        {item('/jobs', 'ti-briefcase', 'Jobs', 'Open roles pulled from company job boards (Greenhouse, Lever and others) that match what you’re looking for.')}
        {item('/templates', 'ti-file-text', 'Templates', 'The emails you send, written once with {{name}}-style blanks that fill in for each person.')}
        {item('/blocklist', 'ti-ban', 'Blocklist', 'Addresses and whole companies that must never be emailed.')}
        {item('/export-contacts', 'ti-file-export', 'Export Contacts', 'Download your contacts as a spreadsheet, or share a read-only link to them.')}
      </div>

      {/* Settings and Sign out live in the top-bar user menu (UserMenu.tsx).
          Display only. routes/admin.js re-checks isAdmin on every request and is
          the actual boundary; hiding the link just keeps it out of the way. */}
      {isAdmin && <div className="nav-section-label">Account</div>}
      {isAdmin && item('/admin', 'ti-shield-lock', 'Admin', 'Manage who can use the app and see app-wide numbers. Admins only.')}
      </>)}
      <div className="sidebar-bottom">
        <button className="theme-toggle" type="button" onClick={toggleTheme}
          aria-label={`Appearance: ${theme === 'dark' ? 'dark' : 'light'}. Switch to ${theme === 'dark' ? 'light' : 'dark'}.`}>
          <span className="tt-icon"><i className="ti ti-sun" /><i className="ti ti-moon" /><span className="nav-label">Appearance</span></span>
          <span className="tt-state">{theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </div>
    </>
  );

  return (
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside id="sidebar-nav" className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Main">{nav}</aside>
      {/* Always mounted: a backdrop that only appears with .open already applied
          has nothing to transition from, so the fade never ran. */}
      <div className={`sidebar-backdrop${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <div className="main">
        <div className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu-btn" type="button" ref={menuBtnRef}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="sidebar-nav"
              onClick={() => setMenuOpen(o => !o)}>
              <i className="ti ti-menu-2" />
            </button>
            <div>
              <h1>{title}</h1>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className="topbar-actions">{actions}</div> : null}
          {owner && (
            <div className="topbar-tools">
              {!minimal && <NotificationBell />}
              <UserMenu />
            </div>
          )}
        </div>
        <main id="main">{wide ? children : <div className="section" style={{ flex: 1 }}>{children}</div>}</main>
      </div>
      <SendJobWidget />
    </div>
  );
}
