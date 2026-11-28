import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import { useSession } from '../context/SessionContext';
import AdminEmailsCard from '../components/AdminEmailsCard';
import AdminEmailSchedule from '../components/AdminEmailSchedule';
import AdminIssues from '../components/AdminIssues';
import AdminSending from '../components/AdminSending';
import AdminAiLogs from '../components/AdminAiLogs';
import AdminPlatformRuns from '../components/AdminPlatformRuns';
import AdminServerLogs from '../components/AdminServerLogs';
import UserEmailsModal from '../components/UserEmailsModal';
import AdminUserDrawer from '../components/AdminUserDrawer';
import AdminOverviewPanel from '../components/admin/AdminOverviewPanel';
import AdminAccountsPanel, { type AccountFilter } from '../components/admin/AdminAccountsPanel';
import AdminRequestsPanel from '../components/admin/AdminRequestsPanel';
import AdminMailActivity from '../components/admin/AdminMailActivity';
import {
  adminOverviewApi, adminInviteApi, adminEmailsApi, adminIssuesApi, adminSendingApi,
  accessRequestsApi,
  type AdminOverview, type AdminUserRow, type AccessRequestRow, type AdminEmailsView, type SendingAlert,
} from '../lib/api';
import '../styles/admin-redesign.css';

// One section per hash. The old tab keys are kept so existing links still land.
type Sec = 'overview' | 'accounts' | 'requests' | 'mail' | 'sending' | 'platform-runs' | 'emails' | 'issues' | 'ai' | 'server-logs' | 'perf';
const SECS: Sec[] = ['overview', 'accounts', 'requests', 'mail', 'sending', 'platform-runs', 'emails', 'issues', 'ai', 'server-logs', 'perf'];
const secOf = (hash: string): Sec => {
  const h = hash.replace(/^#/, '') as Sec;
  return SECS.includes(h) ? h : 'overview';
};

const NAV: Array<{ group: string; items: Array<{ id: Sec; icon: string; label: string }> }> = [
  { group: 'Home', items: [{ id: 'overview', icon: 'ti-layout-dashboard', label: 'Overview' }] },
  { group: 'People', items: [
    { id: 'accounts', icon: 'ti-users', label: 'Accounts' },
    { id: 'requests', icon: 'ti-inbox', label: 'Access requests' },
  ] },
  { group: 'Operations', items: [
    { id: 'mail', icon: 'ti-mail', label: 'Email activity' },
    { id: 'sending', icon: 'ti-send', label: 'Sending' },
    { id: 'platform-runs', icon: 'ti-briefcase', label: 'Job runs' },
    { id: 'emails', icon: 'ti-mail-cog', label: 'Lifecycle emails' },
  ] },
  { group: 'Diagnostics', items: [
    { id: 'issues', icon: 'ti-alert-triangle', label: 'Issues' },
    { id: 'ai', icon: 'ti-sparkles', label: 'Gemini logs' },
    { id: 'server-logs', icon: 'ti-terminal-2', label: 'Server logs' },
    { id: 'perf', icon: 'ti-activity-heartbeat', label: 'System performance' },
  ] },
];

const SUBTITLE: Record<Sec, string> = {
  overview: "What needs you, and how the app is doing. Every account in aggregate — no one else's contacts or emails are shown here.",
  accounts: "Every account, with counts only. Click a row for details and actions.",
  requests: "People who tried to sign in and weren't on the list.",
  mail: "What each account has sent and how it went, batch by batch. Counts only — never a recipient or message.",
  sending: 'How email is moving across every account: live batches, what is scheduled, what ran, and whether the scheduler is firing.',
  'platform-runs': 'Recent job-platform runs across accounts. Status and numeric results only.',
  emails: 'Lifecycle email switches, what is due next, and what was sent.',
  issues: 'Everything that failed for anyone, with the raw error — including recipient addresses.',
  ai: 'Every AI request for anyone, in full — the prompt (reply text, conversations, profiles) and the raw answer.',
  'server-logs': 'Live output of every container on the server: the portal and each cloud worker.',
  perf: 'Route and query latency, slow requests and container load on the server, with 7 days of history.',
};

export default function Admin() {
  const toast = useToast();
  const { user } = useSession();
  const location = useLocation();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [reqFilter, setReqFilter] = useState<'pending' | 'all'>('pending');
  const [emailsOpen, setEmailsOpen] = useState<string | null>(null);
  // Set from the Overview so "3 never signed in" lands on that filter.
  const [accountFilter, setAccountFilter] = useState<AccountFilter>('all');
  const [inviteOpen, setInviteOpen] = useState(false);

  // One account's drawer. ?user=<id> opens it (Analytics links here).
  const [drawerId, setDrawerId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('user'));
  const openDrawer = (uid: string | null) => {
    setDrawerId(uid);
    const url = new URL(window.location.href);
    if (uid) url.searchParams.set('user', uid); else url.searchParams.delete('user');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  };

  const [sec, setSec] = useState<Sec>(() => secOf(window.location.hash));
  const pickSec = (s: Sec) => {
    setSec(s);
    window.history.replaceState(null, '', s === 'overview' ? window.location.pathname + window.location.search : `${window.location.search}#${s}`);
    window.scrollTo({ top: 0 });
  };
  // A notification clicked while already on /admin navigates without a remount.
  useEffect(() => {
    setSec(secOf(location.hash));
    const uid = new URLSearchParams(location.search).get('user');
    if (uid) setDrawerId(uid);
  }, [location.key, location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const goAccounts = (f: AccountFilter) => { setAccountFilter(f); pickSec('accounts'); };

  // Shown in the nav, so a new failure is visible from every section.
  const [openIssues, setOpenIssues] = useState<number | null>(null);
  const [sendAlerts, setSendAlerts] = useState<SendingAlert[]>([]);
  const [sendingCritical, setSendingCritical] = useState(0);
  const loadSignals = useCallback(() => {
    adminIssuesApi({ status: 'open', limit: '1' })
      .then(d => setOpenIssues(Object.values(d.open).reduce((n, g) => n + (g?.issues || 0), 0)))
      .catch(() => {});
    adminSendingApi(7)
      .then(d => {
        setSendAlerts(d.alerts.filter(a => a.level !== 'info'));
        setSendingCritical(d.alerts.filter(a => a.level === 'critical').length);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { loadSignals(); }, [loadSignals]);

  // Shared by the Lifecycle emails card and the accounts table, so a switch
  // flipped in one is reflected in the other's "will it actually send" view.
  const [emails, setEmails] = useState<AdminEmailsView | null>(null);
  const loadEmails = useCallback(async () => {
    try { setEmails(await adminEmailsApi()); } catch (e: any) { toast(e.message || 'Could not load email settings', 'error'); }
  }, [toast]);
  useEffect(() => { loadEmails(); }, [loadEmails]);

  // Switching the range (or the requests filter) keeps what is shown, dimmed.
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);

  const load = useCallback(async (d: number) => {
    setOverviewLoading(true);
    try {
      setData(await adminOverviewApi(d));
      setError('');
    } catch (e: any) {
      setError(e.message || 'Could not load');
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async (f: 'pending' | 'all') => {
    setRequestsLoading(true);
    try {
      setRequests((await accessRequestsApi(f)).requests);
    } catch { /* the overview tile still shows the count */ }
    finally { setRequestsLoading(false); }
  }, []);

  useEffect(() => { load(days); }, [load, days]);
  useEffect(() => { loadRequests(reqFilter); }, [loadRequests, reqFilter]);

  const refreshAll = () => { load(days); loadRequests(reqFilter); loadSignals(); };

  const invite = async (email: string, notify: boolean) => {
    try {
      const r = await adminInviteApi(email, { notify });
      toast(
        r.warning ? `${email} was added, but the email did not send — tell them yourself.`
          : r.emailed ? `${email} was added and emailed.`
          : `${email} was added. They have not been told.`,
        r.warning ? 'info' : 'success',
      );
      await load(days);
      return true;
    } catch (err: any) {
      toast(err.message || 'Could not whitelist that address', 'error');
      return false;
    }
  };

  const act = async (row: AdminUserRow, fn: () => Promise<any>, done: string) => {
    if (!row.id) return;
    setBusyId(row.id);
    try {
      const r = await fn();
      toast(typeof r?.revoked === 'number' ? `${done} (${r.revoked} session(s) ended)` : done, 'success');
      await load(days);
    } catch (err: any) {
      toast(err.message || 'That did not work', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (row: AccessRequestRow, fn: () => Promise<any>, done: string) => {
    setBusyId(row.id);
    try {
      const r = await fn();
      // An approval whose email failed still granted access — say so, rather
      // than letting the admin assume the person was notified.
      toast(r?.warning ? `${done} — but the email did not send, so tell them yourself.` : done,
        r?.warning ? 'info' : 'success');
      await Promise.all([loadRequests(reqFilter), load(days)]);
    } catch (err: any) {
      toast(err.message || 'That did not work', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pending = data?.totals.pendingRequests || 0;
  const badge = (id: Sec) => {
    if (id === 'accounts' && data) return <span className="adm-count">{data.totals.users}</span>;
    if (id === 'requests' && pending > 0) return <span className="adm-pill warn" aria-label={`${pending} waiting`}>{pending}</span>;
    if (id === 'issues' && openIssues) return <span className="adm-pill bad" aria-label={`${openIssues} open`}>{openIssues}</span>;
    if (id === 'sending' && sendingCritical > 0) return <span className="adm-pill bad" aria-label={`${sendingCritical} critical`}>{sendingCritical}</span>;
    return null;
  };
  const usesFleet = sec === 'overview' || sec === 'accounts' || sec === 'requests' || sec === 'mail';

  const drawerRow = drawerId && data ? data.users.find(x => x.id === drawerId) : null;
  const emailsRow = emailsOpen && data ? data.users.find(x => x.id === emailsOpen) : null;

  return (
    <Layout
      title="Admin"
      subtitle={SUBTITLE[sec]}
      wide
      actions={usesFleet ? (
        <button type="button" className="btn btn-sm" onClick={refreshAll} disabled={overviewLoading}>
          <i className={`ti ${overviewLoading ? 'ti-loader' : 'ti-refresh'}`} aria-hidden="true" /> Refresh
        </button>
      ) : undefined}
    >
      <div className="section" style={{ flex: 1 }}>
        <div className="adm-layout">
          <nav className="adm-nav" aria-label="Admin sections">
            {NAV.map(g => (
              <div key={g.group} style={{ display: 'contents' }}>
                <div className="adm-nav-group">{g.group}</div>
                {g.items.map(n => (
                  <button key={n.id} type="button" className={'adm-nav-item' + (sec === n.id ? ' on' : '')}
                    // Labels are hidden while this menu is a rail (main sidebar open).
                    title={n.label} aria-label={n.label}
                    aria-current={sec === n.id ? 'page' : undefined} onClick={() => pickSec(n.id)}>
                    <i className={'ti ' + n.icon} aria-hidden="true" />
                    <span className="adm-nav-label">{n.label}</span>
                    {badge(n.id)}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <main className="adm-main">
            {usesFleet && error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
            {usesFleet && !data && !error && <div className="skeleton" style={{ height: 160 }} />}

            {sec === 'overview' && data && (
              <AdminOverviewPanel
                data={data} days={days} setDays={setDays} loading={overviewLoading}
                openIssues={openIssues} sendAlerts={sendAlerts}
                go={pickSec} goAccounts={goAccounts} openDrawer={openDrawer}
              />
            )}
            {sec === 'accounts' && data && (
              <AdminAccountsPanel
                data={data} loading={overviewLoading} selfId={user?.id} busyId={busyId}
                emailsConfig={emails?.config || null}
                filter={accountFilter} setFilter={setAccountFilter}
                inviteOpen={inviteOpen} setInviteOpen={setInviteOpen} invite={invite}
                act={act} openDrawer={openDrawer} openEmails={setEmailsOpen}
              />
            )}
            {sec === 'requests' && (
              <AdminRequestsPanel
                requests={requests} filter={reqFilter} setFilter={setReqFilter} loading={requestsLoading}
                pending={pending} busyId={busyId} decide={decide}
                onAddDirectly={() => { setInviteOpen(true); goAccounts('all'); }}
              />
            )}

            {sec === 'mail' && data && <AdminMailActivity users={data.users} openDrawer={openDrawer} />}
            {sec === 'sending' && <AdminSending onAlertCount={setSendingCritical} />}
            {sec === 'platform-runs' && <AdminPlatformRuns accounts={data?.users || []} />}
            {sec === 'issues' && <AdminIssues onOpenCount={setOpenIssues} />}
            {sec === 'ai' && <AdminAiLogs />}
            {sec === 'server-logs' && <AdminServerLogs />}
            {sec === 'perf' && <AdminServerLogs path="/perf" title="System performance" />}
            {sec === 'emails' && (
              <>
                <AdminEmailsCard data={emails} reload={loadEmails} />
                <AdminEmailSchedule />
              </>
            )}
          </main>
        </div>

        {/* Outside the sections so ?user=<id> opens over whichever is showing. */}
        {drawerRow && (
          <AdminUserDrawer
            row={drawerRow} isSelf={drawerRow.id === user?.id}
            onClose={() => openDrawer(null)}
            onChanged={() => load(days)}
            onOpenEmails={() => setEmailsOpen(drawerRow.id)}
          />
        )}
        {emailsRow && (
          <UserEmailsModal
            row={emailsRow} config={emails?.config || null}
            onClose={() => setEmailsOpen(null)}
            onChanged={(blockedByAdmin) => setData(d => d && ({
              ...d,
              users: d.users.map(x => x.id === emailsRow.id ? { ...x, emails: { blockedByAdmin, optOut: x.emails?.optOut || [] } } : x),
            }))}
          />
        )}
      </div>
    </Layout>
  );
}
