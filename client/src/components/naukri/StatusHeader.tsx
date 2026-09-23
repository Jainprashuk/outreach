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

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

export interface Readiness { tone: Tone; icon: string; text: string; canRun: boolean }

export function readiness(o: NaukriOverview): Readiness {
  const { worker } = o;

  // Ordered by what blocks hardest. A captcha block outranks everything: while
  // it holds, nothing runs no matter how healthy the machine looks.
  if (o.blockedUntil) {
    return { tone: 'bad', icon: 'ti-hand-stop', canRun: false,
      text: `Naukri challenged the account. Everything is paused until ${fmtTime(o.blockedUntil)}`
          + `${o.blockedReason ? ` — ${o.blockedReason}` : ''}. Do not work around this.` };
  }
  if (o.paused) {
    return { tone: 'bad', icon: 'ti-player-pause', canRun: false,
      text: 'Paused. Turn off "Pause all" in Configuration → Apply behaviour & Safety to run anything.' };
  }
  if (!worker.everSeen) {
    return { tone: 'idle', icon: 'ti-plug-connected-x', canRun: true,
      text: 'Worker has never checked in. Run `npm run naukri-worker` on your Mac.' };
  }
  if (!worker.online) {
    const when = worker.nextWakeAt
      ? `at the next wake, ${fmtTime(worker.nextWakeAt)}`
      : 'when you next open your Mac';
    // Still runnable on purpose: queueing from a phone with the Mac shut is the
    // point of having a queue.
    return { tone: 'idle', icon: 'ti-zzz', canRun: true,
      text: `Your Mac is asleep. Anything you start will be queued and run ${when}.` };
  }
  if (!worker.chromeUp) {
    return { tone: 'warn', icon: 'ti-browser', canRun: true,
      text: 'Chrome is not on the debug port. The worker will try to launch it; if it fails, run ./chrome-debug.sh.' };
  }
  if (!worker.naukriLoggedIn) {
    return { tone: 'warn', icon: 'ti-lock', canRun: false,
      text: 'Chrome is up but Naukri is logged out. Log in inside the debug Chrome window — no run will start until you do.' };
  }
  if (o.dryRun) {
    return { tone: 'warn', icon: 'ti-test-pipe', canRun: true,
      text: 'Ready — but DRY RUN is on. Apply runs will fill everything and submit nothing.' };
  }
  return { tone: 'ok', icon: 'ti-circle-check', canRun: true,
    text: o.nextOccurrence ? `Ready. Next scheduled run ${fmtTime(o.nextOccurrence)}.` : 'Ready. No schedule set.' };
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--green)', warn: 'var(--orange, var(--text2))',
  bad: 'var(--red)', idle: 'var(--text2)',
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

export default function StatusHeader({ overview }: { overview: NaukriOverview }) {
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
        </div>
        {/* The raw facts under the sentence, so a state the sentence does not
            cover is still diagnosable without opening the database. */}
        <div style={{
          marginTop: 5, display: 'flex', gap: 14, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--text2)',
        }}>
          <Dot on={w.online}>{w.online ? 'Mac online' : 'Mac offline'}{w.host ? ` · ${w.host}` : ''}</Dot>
          <Dot on={w.chromeUp}>Chrome</Dot>
          <Dot on={w.naukriLoggedIn}>Naukri session</Dot>
          {overview.dryRun && <span style={{ color: 'var(--orange, var(--text2))' }}>dry run</span>}
          {overview.autoApprove && <span style={{ color: 'var(--red)' }}>auto-approve on</span>}
          <span>{overview.appliedToday} applied today</span>
        </div>
      </div>
    </div>
  );
}
