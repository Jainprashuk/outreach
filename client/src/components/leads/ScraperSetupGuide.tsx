import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { Link } from 'react-router-dom';
import { scrapeStatusApi, workerTokenStatusApi, type ScrapeStatus } from '../../lib/api';

// The user manual for LinkedIn scraping: how it works, how to set up the worker
// on your own computer, day-to-day use, and what each failure means.
//
// Setup is not something the portal can do for you — the harvest has to run in
// a real Chrome on the user's own machine (see worker/README.md) — so the next
// best thing is a guide that knows where you are. The checklist at the top is
// live: it reads the same status the Scrape panel does and ticks steps off as
// the worker reports in.

type Tab = 'how' | 'setup' | 'use' | 'fix';
type Os = 'mac' | 'linux' | 'windows';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'how', label: 'How it works', icon: 'ti-info-circle' },
  { key: 'setup', label: 'Setup', icon: 'ti-tool' },
  { key: 'use', label: 'Daily use', icon: 'ti-calendar-event' },
  { key: 'fix', label: 'Troubleshooting', icon: 'ti-lifebuoy' },
];

const SCRAPER_REPO = 'https://github.com/Jainprashuk/linkdin-scrap.git';
const PORTAL_REPO = 'https://github.com/Jainprashuk/outreach.git';

function detectOs(): Os {
  const p = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') && !p.includes('android')) return 'linux';
  return 'mac';
}

// ── small building blocks ──────────────────────────────────────────────────

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* clipboard blocked — the text is still selectable */ }
  };
  return (
    <div style={{ position: 'relative', margin: '8px 0 4px' }}>
      <pre style={{
        margin: 0, padding: '10px 44px 10px 12px', background: 'var(--bg2)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        fontSize: 12, lineHeight: 1.55, overflowX: 'auto', whiteSpace: 'pre',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}>{children}</pre>
      <button aria-label="Copy" className="btn btn-xs" onClick={copy} type="button" title="Copy"
        style={{ position: 'absolute', top: 6, right: 6 }}>
        <i className={`ti ${copied ? 'ti-check' : 'ti-copy'}`} />
      </button>
    </div>
  );
}

const C = ({ children }: { children: ReactNode }) => (
  <code style={{ background: 'var(--bg2)', padding: '1px 5px', borderRadius: 5, fontSize: '0.92em' }}>{children}</code>
);

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '14px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{
        flexShrink: 0, width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center',
        fontSize: 12, fontWeight: 650,
        background: done ? 'var(--green-bg)' : 'var(--accent-bg)',
        color: done ? 'var(--green)' : 'var(--accent)',
      }}>
        {done ? <i className="ti ti-check" /> : n}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {title}
          {done && <span className="page-info" style={{ marginLeft: 8, color: 'var(--green)' }}>done</span>}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>{children}</div>
      </div>
    </div>
  );
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  const style = tone === 'warn'
    ? { background: 'var(--amber-bg)', color: 'var(--amber)' }
    : tone === 'danger' ? { background: 'var(--red-bg)', color: 'var(--red)' } : undefined;
  const icon = tone === 'info' ? 'ti-info-circle' : tone === 'warn' ? 'ti-alert-triangle' : 'ti-hand-stop';
  return (
    <div className="info-box" style={{ margin: '10px 0', ...style }}>
      <i className={`ti ${icon}`} />
      <span style={{ lineHeight: 1.55 }}>{children}</span>
    </div>
  );
}

const H = ({ children }: { children: ReactNode }) => (
  <h3 style={{ fontSize: 14, fontWeight: 650, margin: '18px 0 6px' }}>{children}</h3>
);
const P = ({ children }: { children: ReactNode }) => (
  <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.65, margin: '6px 0' }}>{children}</p>
);

// ── live progress ──────────────────────────────────────────────────────────

type Progress = {
  token: boolean | null;
  status: ScrapeStatus | null;
};

function Checklist({ p }: { p: Progress }) {
  const w = p.status?.worker;
  const items: { label: string; ok: boolean | null; hint: string }[] = [
    { label: 'Worker token generated', ok: p.token, hint: 'Step 4' },
    { label: 'Worker has checked in', ok: w ? w.everSeen : null, hint: 'Step 7' },
    { label: 'Worker online now', ok: w ? w.online : null, hint: 'Step 7' },
    { label: 'Debug Chrome running', ok: w ? (w.online ? w.chromeUp : null) : null, hint: 'Step 6' },
    { label: 'LinkedIn logged in', ok: w ? (w.online ? w.linkedinLoggedIn : null) : null, hint: 'Step 6' },
  ];
  const allOk = items.every(i => i.ok === true);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Your setup, live</strong>
        {allOk && <span className="badge badge-sent">ready to scrape</span>}
        {p.status?.blockedUntil && <span className="badge badge-rejected">paused (checkpoint)</span>}
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
        The Scrape button on this page finds fresh LinkedIn hiring posts — recruiters and hiring
        managers saying "we're hiring, email me" — and adds them here as leads, with any email
        addresses and apply links pulled out.
      </P>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
        {box('ti-click', '1. You queue a scrape', 'Here, or on a schedule. The portal just records the request.')}
        {arrow}
        {box('ti-device-laptop', '2. Your computer picks it up', 'A small worker on your machine checks the portal every 20 seconds.')}
        {arrow}
        {box('ti-brand-chrome', '3. Your Chrome reads LinkedIn', 'It scrolls your own logged-in LinkedIn search results — no clicks, no messages.')}
        {arrow}
        {box('ti-database-import', '4. Leads land here', 'Only the harvested posts are sent back. Duplicates are skipped.')}
      </div>

      <H>Why it runs on your computer, not in the cloud</H>
      <P>
        LinkedIn restricts accounts that look automated. The scraper therefore uses a real, visible
        Chrome window with your real login, on your own internet connection — exactly what you would
        see if you scrolled yourself. A cloud server can't do that, so each person runs the worker
        on their own machine, logged into their own LinkedIn account.
      </P>

      <H>What stays on your machine</H>
      <P>
        Your LinkedIn password and session cookie never leave your computer — you log in inside the
        Chrome window, and the portal never sees it. The only thing sent to the portal is the list of
        hiring posts that were found. Your worker token identifies which account the leads belong to,
        so your runs, leads and any LinkedIn pause are yours alone.
      </P>

      <H>What you need</H>
      <ul style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' }}>
        <li>A <strong>Mac</strong> or a <strong>Linux desktop</strong> (not a headless server). Windows is not supported yet.</li>
        <li>Google Chrome, Node.js 18+, Python 3.12 and git.</li>
        <li>Your own LinkedIn account.</li>
        <li>About 20 minutes, once.</li>
      </ul>

      <Note tone="warn">
        Scraping is against LinkedIn's terms even when it's gentle. The limits are built in — one short,
        read-only run a day, capped at 20 searches — and if LinkedIn ever shows a security check, all
        scraping pauses for 7 days on its own. Don't try to work around either.
      </Note>
    </>
  );
}

function Setup({ os, setOs, progress, origin }: {
  os: Os; setOs: (o: Os) => void; progress: Progress; origin: string;
}) {
  const w = progress.status?.worker;

  const prereq = os === 'mac'
    ? `# Homebrew first, if you don't have it: https://brew.sh
brew install node python@3.12 git
# and Google Chrome from https://www.google.com/chrome`
    : `# Debian / Ubuntu
sudo apt update
sudo apt install -y nodejs npm python3.12 python3.12-venv git curl
# Google Chrome (not Chromium)
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

      {os === 'windows' ? (
        <Note tone="warn">
          The worker doesn't run on Windows yet — the scraper's browser control and shutdown handling
          are Mac/Linux only. Use a Mac or a Linux desktop, or ask the admin about Windows support.
        </Note>
      ) : (
        <>
          <Step n={1} title="Install the tools">
            Chrome, Node.js, Python 3.12 and git. Skip anything you already have.
            <Code>{prereq}</Code>
          </Step>

          <Step n={2} title="Download the code">
            Two repositories: the scraper, and the worker that connects it to this portal. Put both on
            your Desktop — the worker looks for the scraper at <C>~/Desktop/linkdin-post</C>.
            <Code>{`cd ~/Desktop
git clone ${SCRAPER_REPO} linkdin-post
git clone ${PORTAL_REPO} outreach
cd outreach && npm install`}</Code>
            If git asks for access, ask the admin to add your GitHub account to both repositories.
          </Step>

          <Step n={3} title="Install the scraper">
            It lives in its own Python environment inside the scraper folder.
            <Code>{`cd ~/Desktop/linkdin-post
python3.12 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/jl --help        # should list the commands`}</Code>
          </Step>

          <Step n={4} title="Generate your worker token" done={progress.token === true}>
            Open <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 550 }}>Settings</Link> → <strong>Scrape worker token</strong> →
            {' '}<strong>Generate</strong>, and copy it. It is shown <strong>once</strong>. It tells the
            portal the worker is yours — treat it like a password. If the computer is lost, revoke it
            from the same card.
          </Step>

          <Step n={5} title="Connect the worker to your account" done={w?.everSeen}>
            Create the worker's settings file, then paste your token over the placeholder. The portal
            address below is already filled in for you.
            <Code>{envFile}</Code>
            <Note tone="danger">
              Put only these lines in this file. Never copy someone else's <C>.env</C> — it can
              contain their email password and keys.
            </Note>
            Scraper somewhere other than <C>~/Desktop/linkdin-post</C>? Add a third line:
            {' '}<C>JL_REPO=/full/path/to/it</C>.
          </Step>

          <Step n={6} title="Open the scraping Chrome and log into LinkedIn"
            done={!!w?.online && w.chromeUp && w.linkedinLoggedIn}>
            This opens a <strong>separate</strong> Chrome window with its own profile — your normal
            Chrome is untouched. Log into LinkedIn in it once; the login is remembered after that.
            <Code>{`~/Desktop/linkdin-post/chrome-debug.sh
# after logging in, check it:
cd ~/Desktop/linkdin-post && .venv/bin/jl doctor`}</Code>
            <C>jl doctor</C> should say <strong>li_at cookie present</strong>. Leave this window open.
          </Step>

          <Step n={7} title="Start the worker" done={!!w?.online}>
            <Code>{`cd ~/Desktop/outreach
npm run scrape-worker`}</Code>
            You should see <C>worker up — portal {origin}</C>, and within about 20 seconds the
            checklist above turns green. Keep this terminal open while you want scraping available.
          </Step>

          <Step n={8} title="Optional: start automatically at login">
            So you don't have to remember step 7. {os === 'mac' ? 'This installs a launchd agent.' : 'This installs a systemd user service — run it from a terminal inside your desktop session.'}
            <Code>{`cd ~/Desktop/outreach && worker/install-worker.sh
tail -f ~/.job-leads/worker.log      # watch it`}</Code>
            {os === 'mac'
              ? <>Remove it later with <C>launchctl bootout gui/$UID/com.prashuk.scrape-worker</C>.</>
              : <>Remove it later with <C>systemctl --user disable --now outreach-scrape-worker</C>.</>}
          </Step>

          <Step n={9} title="Optional: choose your default searches">
            The list of searches you pick from in the Scrape panel comes from <C>queries</C> in
            {' '}<C>~/Desktop/linkdin-post/config.json</C>. Edit it to match the roles you want —
            e.g. <C>"Hiring React Developer"</C>, <C>"Technical Recruiter SDE"</C> — and restart the
            worker. You can also type a one-off search in the panel.
          </Step>

          <Note>
            All set when the Scrape panel says <strong>Ready — runs immediately.</strong>
          </Note>
        </>
      )}
    </>
  );
}

function DailyUse({ os }: { os: Os }) {
  return (
    <>
      <H>Running a scrape</H>
      <ol style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' }}>
        <li>Make sure the worker is running and the scraping Chrome window is open.</li>
        <li>Click <strong>Scrape</strong> at the top of this page, pick up to 20 searches, and press <strong>Scrape now</strong>.</li>
        <li>Watch the progress bar. A run takes a few minutes; the Chrome window will scroll by itself — don't use it meanwhile.</li>
        <li>When it finishes, new leads appear in this table. Open one to see the post, emails and apply links, then <strong>Move to outreach</strong>.</li>
      </ol>

      <H>Scheduling</H>
      <P>
        In the Scrape panel, open <strong>Schedule</strong> to run on chosen days at a set time. The
        computer has to be awake and the worker running at that time — a schedule can't wake a
        sleeping machine, and anything queued while it sleeps runs when it wakes.
      </P>
      {os === 'mac' ? (
        <>
          <P>To have your Mac wake itself a few minutes before a 09:30 schedule:</P>
          <Code>{`sudo pmset repeat wakeorpoweron MTWRFSU 09:25:00
pmset -g sched        # confirm`}</Code>
        </>
      ) : os === 'linux' ? (
        <>
          <P>Linux has no repeating wake timer by default. A one-off wake (needs root):</P>
          <Code>{`sudo rtcwake -m no -t "$(date +%s -d 'tomorrow 09:25')"`}</Code>
        </>
      ) : null}

      <H>Rules that keep your account safe</H>
      <ul style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 18, margin: '6px 0' }}>
        <li><strong>Keep the Chrome window visible.</strong> {os === 'mac' ? 'Lid open, ' : ''}not minimised. A locked screen is fine; a closed lid or minimised window finds nothing and the run is marked failed.</li>
        <li><strong>Once a day is plenty.</strong> The schedule deliberately has no more frequent option.</li>
        <li><strong>Don't click around LinkedIn in the scraping window during a run.</strong></li>
        <li><strong>If LinkedIn shows a security check, stop.</strong> Scraping pauses for 7 days automatically. Complete the check in the window by hand, then wait it out — there's no override, on purpose.</li>
        <li><strong>One worker per account.</strong> Don't run it on two computers with the same token.</li>
      </ul>

      <H>Stopping</H>
      <P>
        Press <C>Ctrl+C</C> in the worker's terminal. A run in progress is stopped cleanly and marked
        failed. The Chrome window can stay open.
      </P>
    </>
  );
}

function Troubleshooting({ os }: { os: Os }) {
  const rows: [string, ReactNode][] = [
    ['“Worker has never checked in”',
      <>The worker hasn't reached the portal yet. Check it's running (step 7), that <C>OUTREACH_URL</C> in <C>.env</C> is this site's address, and that the token is pasted correctly.</>],
    ['Worker log shows 401 / unauthorised',
      <>The token is wrong or was revoked. Generate a new one in <Link to="/settings" style={{ color: 'var(--accent)', fontWeight: 550 }}>Settings</Link>, update <C>WORKER_SECRET</C> in <C>.env</C>, restart the worker.</>],
    ['“Your computer is asleep” / worker offline',
      <>The worker stopped or the machine slept. Restart it, or install it to start at login (step 8). Queued runs start once it's back.</>],
    ['“LinkedIn is logged out”',
      <>Log into LinkedIn inside the <strong>scraping</strong> Chrome window (the one <C>chrome-debug.sh</C> opened), not your normal Chrome.</>],
    ['“Chrome is not running”',
      <>The worker launches it for you. If that fails, run <C>~/Desktop/linkdin-post/chrome-debug.sh</C> by hand and read its message.</>],
    ['Run failed with 0 posts seen',
      <>The Chrome window wasn't drawing — {os === 'mac' ? 'lid closed, ' : ''}minimised, or covered by a wake with the screen off. Keep it visible and try again. Two zero runs in a row with the window visible usually means LinkedIn changed its page — tell the admin.</>],
    ['“Harvesting is paused until …”',
      <>LinkedIn showed a security check. This is the safety stop: wait out the 7 days. Don't restart the worker to get around it — the pause is on the server.</>],
    ['“Another scrape worker is already running”',
      <>Only one worker may run per computer. Stop the other one (or the one installed at login{os === 'mac' ? ': launchctl bootout gui/$UID/com.prashuk.scrape-worker' : ': systemctl --user stop outreach-scrape-worker'}).</>],
    ['chrome-debug.sh: “never opened port 9222”',
      <>Another Chrome is using that port, or Chrome isn't installed where expected. Quit the scraping Chrome completely and run it again.</>],
    ['Leads arrive but no emails',
      <>Normal for many posts — not every recruiter writes an address. Apply links are still captured; use the filters to show only leads with an email.</>],
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
        Running by hand: the worker's terminal. Installed at login: <C>~/.job-leads/worker.log</C>.
        Chrome launch problems: <C>~/.job-leads/chrome-debug.log</C>. Each run's error also shows in
        the Scrape panel's <strong>History</strong>.
      </P>
    </>
  );
}

// ── the modal ──────────────────────────────────────────────────────────────

export default function ScraperSetupGuide({ onClose, initialTab = 'how' }: {
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [os, setOs] = useState<Os>(detectOs);
  const [progress, setProgress] = useState<Progress>({ token: null, status: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Poll while open, so the checklist ticks over as the user works through it.
  const load = useCallback(async () => {
    const [token, status] = await Promise.all([
      workerTokenStatusApi().then(r => r.registered).catch(() => null),
      scrapeStatusApi().catch(() => null),
    ]);
    setProgress({ token, status });
  }, []);
  // Paused while the tab is hidden; refreshes the moment it is visible again.
  useVisibleInterval(load, 5000);

  const origin = window.location.origin;

  // Portalled like MoveToInterviewModal: an ancestor keeps a `transform` from
  // its fadeInUp animation, which would become the containing block for the
  // position:fixed wrap and pin the dialog to the page instead of the viewport.
  return createPortal(
    <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" aria-label="LinkedIn scraping guide"
        style={{ maxWidth: 780, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0 }}><i className="ti ti-book" /> LinkedIn scraping guide</h2>
              <div className="page-info" style={{ marginTop: 4 }}>
                How lead scraping works, and how to set it up on your own computer.
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
          {tab === 'fix' && <Troubleshooting os={os} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export type { Tab as GuideTab };
// Shared with the Naukri guide (components/naukri/NaukriSetupGuide.tsx) so both read alike.
export { Code, C, Step, Note, H, P, detectOs, SCRAPER_REPO, PORTAL_REPO };
export type { Os };
