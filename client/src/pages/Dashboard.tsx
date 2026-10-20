// The Dashboard answers "what needs me today, and is everything running?". Each
// number opens the page that owns it; browsing contacts is the Contacts page's job.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import NeedsYouStrip, { type NeedsTask } from '../components/dashboard/NeedsYouStrip';
import { SendingCard, WorkersCard } from '../components/dashboard/RunningPanel';
import WeekPulse from '../components/dashboard/WeekPulse';
import RecentActivity from '../components/dashboard/RecentActivity';
import SetupChecklist, { type SetupStep } from '../components/dashboard/SetupChecklist';
import { fmtAgo, fmtWhen, plural } from '../components/dashboard/format';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { useActionQueue } from '../context/ActionQueueContext';
import { useInterviews } from '../context/InterviewContext';
import { usePulseChange } from '../context/PulseContext';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import {
  actionCenterSummaryApi, activeRunsApi, apiFetch, loadAnalyticsSummaryApi, loadTimelineApi, platformsApi, retryFailedApi,
  type ActionCenterSummary, type AnalyticsSummary, type PlatformInfo, type SendJob, type Timeline, type WorkerRunCard,
} from '../lib/api';

// Everything here also refreshes on the pulse; this is only the safety net.
const SAFETY_MS = 5 * 60_000;

export default function Dashboard() {
  const app = useApp();
  const toast = useToast();
  const actionQueue = useActionQueue();
  const { interviews, loaded: interviewsLoaded, reminders } = useInterviews();

  const [summary, setSummary] = useState<ActionCenterSummary | null>(null);
  const [jobs, setJobs] = useState<SendJob[] | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [runs, setRuns] = useState<WorkerRunCard[] | null>(null);
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const silentChecking = useRef(false);

  // A failed refresh keeps what is on screen; the next pulse or tick tries again.
  const loadSummary = useCallback(() => actionCenterSummaryApi().then(setSummary).catch(() => {}), []);
  const loadSending = useCallback(() => Promise.all([
    apiFetch<SendJob[]>('/api/jobs/active-all').then(setJobs).catch(() => {}),
    loadTimelineApi('24h', 'all').then(setTimeline).catch(() => {}),
  ]), []);
  const loadWorkers = useCallback(() => Promise.all([
    activeRunsApi().then(r => setRuns(r.runs)).catch(() => {}),
    platformsApi().then(r => setPlatforms(r.platforms)).catch(() => {}),
  ]), []);
  const loadAnalytics = useCallback(() => loadAnalyticsSummaryApi().then(setAnalytics).catch(() => {}), []);

  useEffect(() => { app.initMeta().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useVisibleInterval(() => { loadSummary(); loadSending(); loadWorkers(); loadAnalytics(); }, SAFETY_MS);
  usePulseChange(p => p.jobs, () => { loadSending(); loadSummary(); });
  usePulseChange(p => p.runs || '', loadWorkers);
  usePulseChange(p => p.mailbox, () => { loadAnalytics(); loadSummary(); });
  // An approval, delete or send elsewhere in the app moves the to-do counts.
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) { firstVersion.current = false; return; }
    loadSummary();
  }, [app.contactsVersion, loadSummary]);

  // Auto mailbox check: on load if stale, every 15 min, and on tab re-focus (same as classic)
  useEffect(() => {
    if (!app.metaLoaded || !app.sender.email) return;
    const STALE_MS = 10 * 60 * 1000;

    const silentCheck = async () => {
      if (silentChecking.current) return;
      silentChecking.current = true;
      try {
        const result = await app.checkMailbox();
        app.setSenderMailboxCheckedAt(result.lastCheckedAt ? new Date(result.lastCheckedAt) : new Date());
        const parts: string[] = [];
        if (result.bounced?.length) parts.push(`${result.bounced.length} bounce${result.bounced.length !== 1 ? 's' : ''}`);
        if (result.replied?.length) parts.push(`${result.replied.length} repl${result.replied.length !== 1 ? 'ies' : 'y'}`);
        if (parts.length) toast(`Found ${parts.join(' and ')}`, result.bounced?.length ? 'error' : 'success');
      } catch { /* silent */ }
      finally { silentChecking.current = false; }
    };

    const last = app.sender.lastMailboxCheckAt;
    let t: ReturnType<typeof setTimeout> | null = null;
    if (!last || Date.now() - last.getTime() > STALE_MS) t = setTimeout(silentCheck, 2000);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') silentCheck();
    }, 15 * 60 * 1000);

    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const l = app.sender.lastMailboxCheckAt;
      if (!l || Date.now() - l.getTime() > STALE_MS) silentCheck();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { if (t) clearTimeout(t); clearInterval(interval); document.removeEventListener('visibilitychange', onVis); };
  }, [app.metaLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkMailbox = async () => {
    setChecking(true);
    try {
      const result = await app.checkMailbox();
      app.setSenderMailboxCheckedAt(result.lastCheckedAt ? new Date(result.lastCheckedAt) : new Date());
      const parts: string[] = [];
      if (result.bounced?.length) parts.push(`${result.bounced.length} bounce${result.bounced.length !== 1 ? 's' : ''}: ${result.bounced.map((b: any) => b.name).join(', ')}`);
      if (result.replied?.length) parts.push(`${result.replied.length} repl${result.replied.length !== 1 ? 'ies' : 'y'}: ${result.replied.map((r: any) => r.name).join(', ')}`);
      if (parts.length === 0) toast(`Scanned ${result.scanned} message${result.scanned !== 1 ? 's' : ''}. Nothing new.`, 'info');
      else toast(`Found ${parts.join(' and ')}`, result.bounced?.length ? 'error' : 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const retryFailed = async () => {
    setRetrying(true);
    try {
      const data = await retryFailedApi();
      if (data.retried === 0) toast('No failed emails to retry.', 'info');
      else toast(`${plural(data.retried, 'contact')} reset to queued. Open Send to send them again.`, 'success');
      loadSummary();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setRetrying(false);
    }
  };

  // ── Needs you ──────────────────────────────────────────────────────────────
  const enabledPlatforms = (platforms || []).filter(p => p.enabled && p.overview);
  const needsAnswer = enabledPlatforms.reduce((s, p) => s + (p.overview?.needsAnswerCount || 0), 0);
  const toReview = enabledPlatforms.reduce((s, p) => s + (p.overview?.reviewCount || 0), 0);
  const soon = reminders.soon;
  const tasks: NeedsTask[] = [
    { key: 'replies', n: actionQueue.counts['needs-you'], title: 'Replies need you', detail: 'People who wrote back and are waiting on your answer',
      tone: 'amber', cta: 'Open Mailbox', to: '/mailbox?tab=needs-you' },
    { key: 'interviews-soon', n: soon.length, title: soon.length === 1 ? 'Interview coming up' : 'Interviews coming up',
      detail: soon.slice(0, 2).map(iv => `${iv.company}${iv.interviewAt ? `, ${fmtWhen(iv.interviewAt)}` : ''}`).join(' · '),
      tone: 'amber', cta: 'Prepare', to: soon.length === 1 ? `/interviews?open=${soon[0].id}` : '/interviews' },
    { key: 'failed', n: summary?.failed || 0, title: 'Failed sends', detail: 'Gmail did not accept these. Reset them to the queue and send again.',
      tone: 'red', cta: 'Retry', onClick: retryFailed, busy: retrying },
    { key: 'needs-answer', n: needsAnswer, title: 'Job applications need answers', detail: 'Applications stopped on a screening question',
      tone: 'amber', cta: 'Answer', to: '/job-platforms?tab=review' },
    { key: 'followup-due', n: summary?.followUpDue || 0, title: 'Follow-ups due', detail: 'No reply yet to your email, ready for a follow-up',
      tone: 'accent', cta: 'Review and send', to: '/contacts?tab=followup-due' },
    { key: 'chase', n: actionQueue.counts['follow-up'], title: 'Gone quiet', detail: 'People who stopped replying 7+ days after your answer',
      tone: 'accent', cta: 'Open Mailbox', to: '/mailbox?tab=follow-up' },
    { key: 'pending', n: summary?.pending || 0, title: 'Drafts to approve', detail: 'Emails waiting for your OK before they can send',
      tone: 'accent', cta: 'Review', to: '/send/step2' },
    { key: 'ready', n: summary?.ready || 0, title: 'Approved, not sent', detail: 'Approved emails ready to go out',
      tone: 'accent', cta: 'Send', to: '/send/step3' },
    { key: 'jobs-review', n: toReview, title: 'Jobs to review', detail: 'Matched jobs on your job platforms waiting for approval',
      tone: 'accent', cta: 'Review', to: '/job-platforms?tab=review' },
    { key: 'stale-interviews', n: reminders.stale.length, title: 'Interviews without an update', detail: 'No change in 3+ days. Follow up or update the status.',
      tone: 'accent', cta: 'Update', to: '/interviews' },
    { key: 'leads', n: summary?.newLeads || 0, title: 'New leads', detail: 'Hiring posts and leads you have not looked at yet',
      tone: 'accent', cta: 'Open Leads', to: '/leads' },
  ];
  const needsLoading = !summary || !actionQueue.loaded || !interviewsLoaded;

  // ── New account ────────────────────────────────────────────────────────────
  const hasTemplates = Object.keys(app.templates).length > 0;
  const hasContacts = !!analytics && analytics.metrics.total > 0;
  const steps: SetupStep[] = [
    { key: 'gmail', title: 'Connect Gmail', detail: 'Add your Gmail address and app password so emails send from you',
      done: !!summary?.gmailConnected, to: '/settings', cta: 'Connect' },
    { key: 'template', title: 'Write your first template', detail: 'The email people get. Variables fill in each person\'s name and company.',
      done: hasTemplates, to: '/templates', cta: 'Create template' },
    { key: 'contacts', title: 'Add people to email', detail: 'Paste a list, import a CSV, or find people at a company in Discover',
      done: hasContacts, to: '/add-contacts', cta: 'Add contacts' },
  ];
  const setupKnown = !!summary && !!analytics && app.metaLoaded;
  const showSetup = setupKnown && steps.some(s => !s.done);

  // ── Header status line ─────────────────────────────────────────────────────
  const quotaPause = (jobs || []).find(j => j.status === 'paused' && j.pauseReason === 'gmail_daily_limit');
  const lastChecked = app.sender.lastMailboxCheckAt;
  const status: Array<{ text: string; tone?: 'amber' | 'green' }> = [];
  if (actionQueue.counts['needs-you']) status.push({ text: `${plural(actionQueue.counts['needs-you'], 'reply', 'replies')} need you`, tone: 'amber' });
  if (soon.length) status.push({ text: `${plural(soon.length, 'interview')} today or tomorrow`, tone: 'amber' });
  if (quotaPause) status.push({ text: quotaPause.pausedUntil ? `Sending paused until ${fmtWhen(quotaPause.pausedUntil)}` : 'Sending paused by Gmail\'s daily limit', tone: 'amber' });
  if (!status.length && !needsLoading) {
    // Nothing urgent: name the first thing that is ready, not "nothing to do".
    const next = tasks.find(t => t.n > 0);
    status.push(next ? { text: `${next.n} ${next.title.toLowerCase()}` } : { text: 'Nothing waiting on you', tone: 'green' });
  }
  status.push({ text: !app.metaLoaded ? 'Loading…' : lastChecked ? `Mailbox checked ${fmtAgo(lastChecked)}` : 'Mailbox not checked yet' });
  const subtitle = (
    <span className="dash-status-line">
      {status.map(s => (
        <span key={s.text}>{s.tone && <i className={`dash-dot ${s.tone}`} aria-hidden="true" />}{s.text}</span>
      ))}
    </span>
  );

  return (
    <Layout title="Dashboard" subtitle={subtitle} actions={
      <>
        <button className="btn" onClick={checkMailbox} disabled={checking} type="button" title="Check Gmail for new replies and bounces">
          <i className={`ti ${checking ? 'ti-loader' : 'ti-mail-search'}`} /> {checking ? 'Checking…' : 'Check mailbox'}
        </button>
        <Link to="/campaigns/new" className="btn btn-primary"><i className="ti ti-plus" /> New campaign</Link>
      </>
    }>
      <div className="dash">
        {showSetup && <SetupChecklist steps={steps} />}
        {/* A brand-new account sees only the checklist; one that is partly set up
            (say, job platforms but no Gmail yet) keeps the rest below it. */}
        {!(showSetup && !hasContacts) && (
          <>
            <NeedsYouStrip tasks={tasks} loading={needsLoading} />
            <div className="dash-two">
              <SendingCard jobs={jobs} timeline={timeline} />
              <WorkersCard runs={runs} platforms={platforms} mailboxCheckedAt={lastChecked} />
            </div>
            <WeekPulse analytics={analytics} interviews={interviews} />
            <RecentActivity activity={analytics?.activity || null} interviews={interviews} />
          </>
        )}
      </div>
    </Layout>
  );
}
