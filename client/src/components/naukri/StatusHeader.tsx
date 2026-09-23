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
  ok: 'var(--ok, #16a34a)', warn: 'var(--warn, #d97706)',
  bad: 'var(--danger, #dc2626)', idle: 'var(--text2)',
};

export default function StatusHeader({ overview }: { overview: NaukriOverview }) {
  const r = readiness(overview);
  const w = overview.worker;

  return (
    <div className="card" style={{ padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <i className={`ti ${r.icon}`} style={{ color: TONE_COLOR[r.tone], fontSize: 18, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>{r.text}</div>
          {/* The raw facts under the sentence, so a state the sentence doesn't
              cover is still diagnosable without opening the database. */}
          <div className="page-info" style={{ marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
            <span>{w.online ? '● Mac online' : '○ Mac offline'}{w.host ? ` · ${w.host}` : ''}</span>
            <span>{w.chromeUp ? '● Chrome up' : '○ Chrome down'}</span>
            <span>{w.naukriLoggedIn ? '● Naukri logged in' : '○ Naukri logged out'}</span>
            {overview.autoApprove && (
              <span style={{ color: TONE_COLOR.warn }}>● auto-approve ON</span>
            )}
            <span>{overview.appliedToday} applied today</span>
          </div>
        </div>
      </div>
    </div>
  );
}
