import type { NaukriOverview } from '../../lib/api';
import { fmtTime } from './format';

// The readiness line.
//
// Modelled on ScrapePanel's readiness(), and it keeps the rule that made that
// one useful: every state maps to a specific, actionable sentence. Never a bare
// "offline" — always what is wrong and what you do about it. A worker panel that
// says "not ready" and stops teaches you to ignore it.
//
// Written fresh against Naukri's states rather than imported from the LinkedIn
// panel, so that file stays untouched and the two can diverge.

type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'run';

export interface Readiness {
  tone: Tone; icon: string; text: string; canRun: boolean;
  /** Two or three words for the platform switcher card. */
  short: string;
}

const RUN_LABEL: Record<string, string> = { refresh: 'Refresh profile', harvest: 'Harvest', apply: 'Apply', track: 'Check replies', probe: 'Test' };
export const runLabel = (kind: string, dryRun?: boolean) => (kind === 'apply' && dryRun ? 'Dry run apply' : RUN_LABEL[kind] || kind);

// Whether an admin hosts this account's workers on the cloud VM. Set once by
// the Job Platforms page from /api/scrapes/worker-token, the way
// setNaukriPlatform scopes the API calls, so every readiness() caller — the
// switcher, the cards, the header — words "not connected" for the right setup.
let cloudHosted = false;
export const setCloudHosted = (on: boolean) => { cloudHosted = on; };

/** The sentence alone. `withRun` adds the "running" state the switcher shows. */
export function readiness(o: NaukriOverview, { withRun = false }: { withRun?: boolean } = {}): Readiness {
  const { worker } = o;
  const L = o.label || 'Naukri';
  const naukri = !o.platform || o.platform === 'naukri';

  if (withRun && o.activeRun) {
    const k = runLabel(o.activeRun.kind, o.activeRun.dryRun);
    return { tone: 'run', icon: 'ti-activity', canRun: false, short: `${k} running`, text: `${k} is running on ${L}.` };
  }
  // Ordered by what blocks hardest. A captcha block outranks everything: while
  // it holds, nothing runs no matter how healthy the machine looks.
  if (o.blockedUntil) {
    return { tone: 'bad', icon: 'ti-hand-stop', canRun: false,
      short: `Paused until ${new Date(o.blockedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      text: `${L} challenged the account. ${naukri ? 'Everything' : `${L} runs are`} paused until ${fmtTime(o.blockedUntil)}`
          + `${o.blockedReason ? ` — ${o.blockedReason}` : ''}. ${naukri ? '' : 'Other platforms keep running. '}Do not work around this.` };
  }
  if (o.paused) {
    return { tone: 'bad', icon: 'ti-player-pause', canRun: false, short: 'Paused by you',
      text: naukri
        ? 'Paused. Turn off "Pause all" in Configuration → Apply behaviour & Safety to run anything.'
        : `${L} is paused. Turn off "Pause ${L}" in Configuration → Apply behaviour & safety to run anything.` };
  }
  // Never checked in: nothing would ever pick a run up, so nothing may be
  // queued — a run started here used to sit in "queued" for ever.
  if (!worker.everSeen) {
    return cloudHosted
      ? { tone: 'warn', icon: 'ti-cloud-off', canRun: false, short: 'Not connected',
          text: `Your cloud worker for ${L} hasn't connected yet. It usually does within a minute of being set up; if it stays like this, ask your admin.` }
      : { tone: 'warn', icon: 'ti-plug-connected-x', canRun: false, short: 'Not set up',
          text: `${L} isn't set up yet: no worker has ever connected, so nothing can run. Set up the worker on your computer (see the Guide), or ask your admin to host it in the cloud.` };
  }
  if (!worker.online) {
    if (cloudHosted) {
      return { tone: 'warn', icon: 'ti-cloud-off', canRun: true, short: 'Offline',
        text: `Your cloud worker for ${L} is offline. Anything you start is queued and runs when it reconnects — usually within minutes. If it stays offline, tell your admin.` };
    }
    const when = worker.nextWakeAt
      ? `at the next wake, ${fmtTime(worker.nextWakeAt)}`
      : 'when you next open your computer';
    // Still runnable on purpose: queueing from a phone with the Mac shut is the
    // point of having a queue.
    return { tone: 'idle', icon: 'ti-zzz', canRun: true, short: 'Computer asleep',
      text: `Your computer is asleep or the worker is stopped. Anything you start will be queued and run ${when}.` };
  }
  if (!worker.chromeUp) {
    return { tone: 'warn', icon: 'ti-browser', canRun: true, short: 'Chrome closed',
      text: 'Chrome is not on the debug port. The worker will try to launch it; if it fails, run ./chrome-debug.sh.' };
  }
  if (!worker.naukriLoggedIn && o.capabilities?.publicHarvest) {
    return { tone: 'warn', icon: 'ti-lock', canRun: true, short: 'Logged out',
      text: `${L} is logged out. Searches still harvest (its job search is public); log in inside the debug Chrome window for your job feed, check replies and apply.` };
  }
  if (!worker.naukriLoggedIn) {
    return { tone: 'warn', icon: 'ti-lock', canRun: false, short: 'Log back in',
      text: `Chrome is up but ${L} is logged out. Log in inside the debug Chrome window — no ${naukri ? '' : `${L} `}run will start until you do.` };
  }
  if (o.dryRun) {
    return { tone: 'warn', icon: 'ti-test-pipe', canRun: true, short: 'Ready, dry run',
      text: 'Ready — but DRY RUN is on. Apply runs will fill everything and submit nothing.' };
  }
  return { tone: 'ok', icon: 'ti-circle-check', canRun: true, short: o.applyMode === 'off' && !naukri ? 'Ready, read-only' : 'Ready',
    text: o.nextOccurrence ? `Ready. Next scheduled run ${fmtTime(o.nextOccurrence)}.` : 'Ready. No schedule set.' };
}

export const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--green)', warn: 'var(--amber, var(--text2))',
  bad: 'var(--red)', idle: 'var(--text3)', run: 'var(--accent)',
};

const Dot = ({ on, children }: { on: boolean; children: React.ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
    <span style={{
      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: on ? 'var(--green)' : 'var(--text3)',
    }} />
    {children}
  </span>
);

export default function StatusHeader({ overview, onHelp }: { overview: NaukriOverview; onHelp?: () => void }) {
  const r = readiness(overview);
  const w = overview.worker;

  return (
    <div style={{
      background: r.tone === 'bad' ? 'var(--red-bg)' : 'var(--bg2)',
      border: `0.5px solid ${r.tone === 'bad' ? 'color-mix(in srgb, var(--red) 25%, transparent)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-lg)',
      padding: '11px 14px',
      marginBottom: 14,
      display: 'flex', alignItems: 'flex-start', gap: 10,
    }}>
      <i className={`ti ${r.icon}`} style={{ color: TONE_COLOR[r.tone], fontSize: 17, marginTop: 1, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: r.tone === 'bad' ? 'var(--red)' : 'var(--text)', lineHeight: 1.5 }}>
          {r.text}
          {onHelp && !overview.worker.everSeen && (
            <button className="btn btn-xs" type="button" onClick={onHelp} style={{ marginLeft: 8 }}>
              <i className="ti ti-book" /> Setup guide
            </button>
          )}
        </div>
        {/* The raw facts under the sentence, so a state the sentence does not
            cover is still diagnosable without opening the database. */}
        <div style={{
          marginTop: 5, display: 'flex', gap: 14, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--text2)',
        }}>
          <Dot on={w.online}>{w.online ? 'Worker online' : 'Worker offline'}{w.host ? ` · ${w.host}` : ''}</Dot>
          <Dot on={w.chromeUp}>Chrome</Dot>
          <Dot on={w.naukriLoggedIn}>{overview.label || 'Naukri'} session</Dot>
          {overview.dryRun && <span style={{ color: 'var(--orange, var(--text2))' }}>dry run</span>}
          {overview.autoApprove && <span style={{ color: 'var(--red)' }}>auto-approve on</span>}
          <span>{overview.appliedToday} applied today</span>
        </div>
      </div>
    </div>
  );
}
