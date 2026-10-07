import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { Link } from 'react-router-dom';
import { naukriOverviewApi, workerTokenStatusApi, type NaukriOverview } from '../../lib/api';
import {
  C, Code, H, Note, P, Step, detectOs, PORTAL_REPO, SCRAPER_REPO, type Os,
} from '../leads/ScraperSetupGuide';

// The user manual for the Naukri auto-apply worker — the same shape as the
// LinkedIn scraping guide, because it is the same kind of setup: a worker on your
// own computer, driving your own logged-in Chrome. The checklist at the top is
// live and reads the same overview the Naukri tab does.
//
// If you already set up LinkedIn scraping, most of this is done: the same token,
// the same .env and the same debug Chrome serve both workers.

type Tab = 'how' | 'setup' | 'use' | 'fix';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'how', label: 'How it works', icon: 'ti-info-circle' },
  { key: 'setup', label: 'Setup', icon: 'ti-tool' },
  { key: 'use', label: 'Daily use', icon: 'ti-calendar-event' },
  { key: 'fix', label: 'Troubleshooting', icon: 'ti-lifebuoy' },
];

type Progress = { token: boolean | null; overview: NaukriOverview | null };

function Checklist({ p }: { p: Progress }) {
  const o = p.overview;
  const w = o?.worker;
  const items: { label: string; ok: boolean | null; hint: string }[] = [
    { label: 'Worker token generated', ok: p.token, hint: 'Step 3' },
    { label: 'Worker has checked in', ok: w ? w.everSeen : null, hint: 'Step 6' },
    { label: 'Worker online now', ok: w ? w.online : null, hint: 'Step 6' },
    { label: 'Debug Chrome running', ok: w ? (w.online ? w.chromeUp : null) : null, hint: 'Step 5' },
    { label: 'Naukri logged in', ok: w ? (w.online ? w.naukriLoggedIn : null) : null, hint: 'Step 5' },
  ];
  const allOk = items.every(i => i.ok === true);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Your setup, live</strong>
        {allOk && <span className="badge badge-sent">ready to run</span>}
        {o?.dryRun && <span className="badge badge-pending">dry run on</span>}
        {o?.paused && <span className="badge badge-rejected">paused</span>}
        {o?.blockedUntil && <span className="badge badge-rejected">blocked (captcha)</span>}
        {w?.host && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>last seen on {w.host}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '6px 16px' }}>
        {items.map(i => (
          <div key={i.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <i className={`ti ${i.ok === true ? 'ti-circle-check' : i.ok === false ? 'ti-circle-x' : 'ti-circle-dashed'}`}
              style={{ color: i.ok === true ? 'var(--green)' : i.ok === false ? 'var(--red)' : 'var(--text3)', fontSize: 16 }} />
            <span>{i.label}</span>
            {i.ok !== true && <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>· {i.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const Ul = ({ children }: { children: ReactNode }) => (
  <ul style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' }}>{children}</ul>
);

// ── tabs ───────────────────────────────────────────────────────────────────

function HowItWorks() {
  const box = (icon: string, title: string, text: string) => (
    <div style={{ flex: '1 1 150px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 20, color: 'var(--accent)' }} />
      <div style={{ fontWeight: 600, fontSize: 13, margin: '6px 0 2px' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>{text}</div>
    </div>
  );
  const arrow = <i className="ti ti-arrow-right" style={{ alignSelf: 'center', color: 'var(--text3)' }} />;
  return (
    <>
      <P>
        The Naukri tab keeps your Naukri profile fresh and applies to jobs for you — but only to the jobs
        <strong> you approve</strong>. It does three kinds of work, which you can run by hand or on a schedule:
      </P>
      <Ul>
        <li><strong>Refresh</strong> — re-saves your profile so recruiter search ranks you as active today.</li>
        <li><strong>Harvest</strong> — collects matching job listings into this tab for you to review.</li>
        <li><strong>Apply</strong> — applies to the jobs you approved, and nothing else.</li>
      </Ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
        {box('ti-download', '1. Harvest', 'Listings matching your searches and filters arrive here as “to review”.')}
        {arrow}
        {box('ti-checks', '2. You approve', 'In Review you approve or skip each job. Nothing is applied to without this.')}
        {arrow}
        {box('ti-device-laptop', '3. Your computer applies', 'The worker opens each approved job in your own Chrome and applies.')}
        {arrow}
        {box('ti-circle-check', '4. Results land here', 'Applied, or skipped with the reason — e.g. a question it had no answer for.')}
      </div>

      <H>Why it runs on your computer</H>
      <P>
        Like LinkedIn scraping, it drives a real, visible Chrome logged into your own Naukri account, on
        your own internet connection. A cloud server can't do that without looking like a bot, so the
        worker runs on your machine and this portal only hands it work and records the results.
      </P>

      <H>What it will never do</H>
      <Ul>
        <li>Apply to a job you didn't approve (unless you switch on auto-approve yourself).</li>
        <li>Guess an answer. A screening question with no matching rule in <strong>Answers</strong> skips the job and tells you which question it was.</li>
        <li>Store your Naukri password. You log in inside Chrome; only that browser holds the session.</li>
        <li>Keep going after a captcha. It stops everything for 7 days on its own.</li>
      </Ul>

      <H>What you need</H>
      <Ul>
        <li>A <strong>Mac</strong> or a <strong>Linux desktop</strong>. Windows is not supported yet.</li>
        <li>Google Chrome, Node.js 18+ and git.</li>
        <li>Your own Naukri account, and your resume.</li>
        <li>About 15 minutes — less if LinkedIn scraping is already set up.</li>
      </Ul>

      <Note tone="warn">
        Automated applying is against Naukri’s terms. The worker is built to be gentle — a daily cap
        on applications, randomised pacing, and a hard 7-day stop on any captcha — but the account is
        yours, and so is the risk. Start with <strong>Dry run</strong> on.
      </Note>
    </>
  );
}

function Setup({ os, setOs, progress, origin }: {
  os: Os; setOs: (o: Os) => void; progress: Progress; origin: string;
}) {
  const w = progress.overview?.worker;
  const prereq = os === 'mac'
    ? `# Homebrew first, if you don't have it: https://brew.sh
brew install node git
# and Google Chrome from https://www.google.com/chrome`
    : `# Debian / Ubuntu
sudo apt update
sudo apt install -y nodejs npm git curl
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb`;

  const envFile = `cat > ~/Desktop/outreach/.env <<'EOF'
WORKER_SECRET=paste-your-worker-token-here
OUTREACH_URL=${origin}
EOF`;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <span className="page-info">Your computer:</span>
        <div className="seg-toggle">
          {([['mac', 'macOS'], ['linux', 'Linux'], ['windows', 'Windows']] as [Os, string][]).map(([k, label]) => (
            <button key={k} className={`btn btn-xs${os === k ? ' active' : ''}`} onClick={() => setOs(k)} type="button">
              {label}
            </button>
          ))}
        </div>
      </div>

      <Checklist p={progress} />

      <Note>
        <strong>Already scraping LinkedIn?</strong> Steps 1–4 are done — the Naukri worker uses the same
        token, the same <C>.env</C> and the same debug Chrome. Skip to step 5 and log into Naukri.
      </Note>

      {os === 'windows' ? (
        <Note tone="warn">
          The worker doesn't run on Windows yet. Use a Mac or a Linux desktop.
        </Note>
      ) : (
        <>
          <Step n={1} title="Install the tools">
            Chrome, Node.js and git. Skip anything you already have.
            <Code>{prereq}</Code>
          </Step>

          <Step n={2} title="Download the code">
            The worker lives in this portal's repository. It also needs the scraper repository for one
            file — <C>chrome-debug.sh</C>, which opens the dedicated Chrome window both workers share.
            <Code>{`cd ~/Desktop
git clone ${PORTAL_REPO} outreach
git clone ${SCRAPER_REPO} linkdin-post
cd outreach && npm install`}</Code>
            If git asks for access, ask the admin to add your GitHub account to both repositories.
          </Step>

          <Step n={3} title="Generate your worker token" done={progress.token === true}>
            Open <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 550 }}>Settings</Link> → <strong>Scrape worker token</strong> →
            {' '}<strong>Generate</strong>, and copy it. It's shown <strong>once</strong>. One token serves both
            workers. Treat it like a password; revoke it from the same card if the computer is lost.
          </Step>

          <Step n={4} title="Connect the worker to your account" done={w?.everSeen}>
            Create the worker's settings file, then paste your token over the placeholder.
            <Code>{envFile}</Code>
            <Note tone="danger">
              Put only these lines in this file. Never copy someone else's <C>.env</C>.
            </Note>
          </Step>

          <Step n={5} title="Open the debug Chrome and log into Naukri"
            done={!!w?.online && w.chromeUp && w.naukriLoggedIn}>
            This opens a <strong>separate</strong> Chrome window with its own profile; your normal Chrome is
            untouched. In it, go to <C>naukri.com</C> and log in once — the login is remembered after that.
            <Code>{`~/Desktop/linkdin-post/chrome-debug.sh`}</Code>
            Leave this window open. If you scrape LinkedIn too, stay logged into both sites in the same window.
          </Step>

          <Step n={6} title="Start the worker" done={!!w?.online}>
            <Code>{`cd ~/Desktop/outreach
npm run naukri-worker`}</Code>
            Within about 20 seconds the checklist above turns green. Keep the terminal open.
            Running LinkedIn scraping as well? <C>npm run workers</C> starts Chrome and both workers in one terminal.
          </Step>

          <Step n={7} title="Fill in the Configuration tab">
            Back on the Naukri tab, open <strong>Configuration</strong> and go through the cards:
            <Ul>
              <li><strong>Searches</strong> and <strong>Filters</strong> — what to harvest: roles, locations, experience, salary.</li>
              <li><strong>Profile</strong> and <strong>Resume &amp; headline</strong> — what Refresh keeps up to date.</li>
              <li><strong>Answers</strong> — rules for screening questions (notice period, current CTC…). The more you add, the fewer jobs get skipped.</li>
              <li><strong>Apply behaviour &amp; safety</strong> — the daily cap, <strong>Dry run</strong>, auto-approve and <strong>Pause all</strong>.</li>
              <li><strong>Schedule</strong> — optional: which days and time Refresh / Harvest run by themselves.</li>
            </Ul>
          </Step>

          <Step n={8} title="Do a safe first run">
            Turn <strong>Dry run</strong> on, then press <strong>Harvest</strong>, approve two or three jobs in
            {' '}<strong>Review</strong>, and press <strong>Apply</strong>. A dry run fills every form and submits nothing —
            check <strong>Skipped</strong> for questions that need an answer rule. When it looks right, turn Dry run off.
          </Step>

          <Note>
            All set when the line at the top of the Naukri tab says <strong>Ready.</strong>
          </Note>
        </>
      )}
    </>
  );
}

function DailyUse({ os }: { os: Os }) {
  return (
    <>
      <H>A normal day</H>
      <ol style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' }}>
        <li>Make sure the worker is running and the debug Chrome window is open.</li>
        <li><strong>Harvest</strong> (or let the schedule do it) — new jobs appear under <strong>Review</strong>.</li>
        <li>Approve the ones you want, skip the rest. Approved jobs wait under <strong>Waiting</strong>.</li>
        <li>Press <strong>Apply</strong>. Progress shows under <strong>Activity</strong>; results under <strong>Applied</strong> and <strong>Skipped</strong>.</li>
        <li>Check <strong>Skipped</strong> now and then: add an answer rule for any question that keeps coming up.</li>
      </ol>

      <H>Scheduling</H>
      <P>
        In <strong>Configuration → Schedule</strong> choose days and a time for Refresh and Harvest. Apply is off in
        the schedule by default on purpose — applying should follow your approvals, not a clock. The computer has
        to be awake and the worker running at that time; anything queued while it sleeps runs when it wakes.
      </P>
      {os === 'mac' && (
        <>
          <P>To have your Mac wake itself a few minutes before a 09:30 schedule:</P>
          <Code>{`sudo pmset repeat wakeorpoweron MTWRFSU 09:25:00
pmset -g sched        # confirm`}</Code>
        </>
      )}

      <H>Rules that keep your account safe</H>
      <Ul>
        <li><strong>Keep the Chrome window visible</strong> during a run, and don't click around Naukri in it.</li>
        <li><strong>Respect the daily cap.</strong> Lots of applications in a few minutes is what gets accounts flagged.</li>
        <li><strong>If Naukri shows a captcha, stop.</strong> Everything pauses for 7 days automatically. Solve it by hand in the window and wait it out.</li>
        <li><strong>One worker per account.</strong> Two would drive the same Chrome and could apply to the same job twice.</li>
        <li><strong>Pause all</strong> (in Apply behaviour &amp; safety) stops everything instantly if something looks wrong.</li>
      </Ul>

      <H>Stopping</H>
      <P>
        Press <C>Ctrl+C</C> in the worker's terminal. A run in progress stops cleanly. The Chrome window can stay open.
      </P>
    </>
  );
}

function Troubleshooting() {
  const rows: [string, ReactNode][] = [
    ['“Worker has never checked in”',
      <>The worker hasn't reached the portal. Check it's running (step 6), that <C>OUTREACH_URL</C> in <C>.env</C> is this site's address, and that the token is pasted correctly.</>],
    ['Worker log shows 401 / unauthorised',
      <>The token is wrong or was revoked. Generate a new one in <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 550 }}>Settings</Link>, update <C>WORKER_SECRET</C> in <C>.env</C>, restart the worker — and the LinkedIn worker too, since they share it.</>],
    ['“Your Mac is asleep”',
      <>The worker stopped or the computer slept. Start it again; queued runs begin once it's back.</>],
    ['“Chrome is not on the debug port”',
      <>The worker tries to open it for you. If that fails, run <C>~/Desktop/linkdin-post/chrome-debug.sh</C> by hand and read its message.</>],
    ['“Naukri is logged out”',
      <>Log into naukri.com inside the <strong>debug</strong> Chrome window — the one <C>chrome-debug.sh</C> opened — not your normal Chrome.</>],
    ['Jobs keep landing in Skipped',
      <>Usually a screening question with no answer rule. Open the job in <strong>Skipped</strong> to see the question, then add a rule in <strong>Configuration → Answers</strong>.</>],
    ['Apply ran but nothing was submitted',
      <><strong>Dry run</strong> is on (the top line says so). Turn it off in Apply behaviour &amp; safety.</>],
    ['“Naukri challenged the account”',
      <>A captcha appeared. This is the safety stop: all runs are paused for 7 days. Solve the captcha by hand in the window and wait — restarting the worker won't lift it, the pause is on the server.</>],
    ['“Another Naukri worker is already running”',
      <>Only one may run per computer. Close the other terminal, or stop <C>npm run workers</C> if it's running there.</>],
  ];
  return (
    <>
      <div className="table-card" style={{ overflowX: 'auto', marginTop: 4 }}>
        <table style={{ width: '100%' }}>
          <thead><tr><th style={{ textAlign: 'left', width: '34%' }}>You see</th><th style={{ textAlign: 'left' }}>What to do</th></tr></thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ verticalAlign: 'top', fontWeight: 550, fontSize: 12.5 }}>{k}</td>
                <td style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.55 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <H>Where the logs are</H>
      <P>
        The worker's terminal. Each run's steps and any error also show under <strong>Activity</strong> on the Naukri tab.
      </P>
    </>
  );
}

// ── the modal ──────────────────────────────────────────────────────────────

export default function NaukriSetupGuide({ onClose, initialTab = 'how' }: {
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [os, setOs] = useState<Os>(detectOs);
  const [progress, setProgress] = useState<Progress>({ token: null, overview: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Poll while open, so the checklist ticks over as the user works through it.
  const load = useCallback(async () => {
    const [token, overview] = await Promise.all([
      workerTokenStatusApi().then(r => r.registered).catch(() => null),
      naukriOverviewApi().catch(() => null),
    ]);
    setProgress({ token, overview });
  }, []);
  // Paused while the tab is hidden; refreshes the moment it is visible again.
  useVisibleInterval(load, 5000);

  const origin = window.location.origin;

  // Portalled, like the LinkedIn guide, so an animated ancestor can't pin it to the page.
  return createPortal(
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" aria-label="Naukri setup guide"
        style={{ maxWidth: 780, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0 }}><i className="ti ti-book" /> Naukri setup guide</h2>
              <div className="page-info" style={{ marginTop: 4 }}>
                How the auto-apply worker works, and how to set it up on your own computer.
              </div>
            </div>
            <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button">
              <i className="ti ti-x" />
            </button>
          </div>
          <div className="nav-tabs" style={{ display: 'flex', marginTop: 14, overflowX: 'auto' }}>
            {TABS.map(t => (
              <button key={t.key} className={`nav-tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}
                type="button" style={{ background: 'none', border: 'none', borderBottom: '2px solid', borderBottomColor: tab === t.key ? 'var(--accent)' : 'transparent', cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <i className={`ti ${t.icon}`} />{t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '14px 22px 22px', overflowY: 'auto', minHeight: 0 }}>
          {tab === 'how' && (
            <>
              <HowItWorks />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={() => setTab('setup')} type="button">
                  Start setup <i className="ti ti-arrow-right" />
                </button>
              </div>
            </>
          )}
          {tab === 'setup' && <Setup os={os} setOs={setOs} progress={progress} origin={origin} />}
          {tab === 'use' && <DailyUse os={os} />}
          {tab === 'fix' && <Troubleshooting />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export type { Tab as NaukriGuideTab };
