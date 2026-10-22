import { useState } from 'react';
import type { NaukriOverview } from '../../../lib/api';
import { Card, Muted } from '../ui';
import { queueNaukriRunApi, updateNaukriConfigApi } from '../../../lib/api';
import { fmtTime } from '../format';
import { useToast } from '../../../context/ToastContext';
import { usePlatform } from '../platform';

// Read-only health, plus the two controls that belong next to it: a probe that
// proves the whole chain end to end, and the kill switch.
//
// Each red state names the exact fix rather than the symptom. "Naukri is logged
// out" is useless on its own; "log in inside the debug Chrome window" is the
// whole action.

function Line({ ok, label, fix }: { ok: boolean; label: string; fix?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', fontSize: 13 }}>
      <i className={`ti ti-${ok ? 'circle-check' : 'circle-x'}`}
         style={{ color: ok ? 'var(--green)' : 'var(--red)', fontSize: 15, marginTop: 1 }} />
      <span>
        {label}
        {!ok && fix && <div style={{ color: 'var(--text2)', fontSize: 12 }}>{fix}</div>}
      </span>
    </div>
  );
}

export default function ConnectionCard({ overview, onChanged }: {
  overview: NaukriOverview; onChanged: () => void;
}) {
  const w = overview.worker;
  const { id: platformId, label: site, capabilities } = usePlatform();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [msg, setMsg] = useState('');

  const probe = async () => {
    setBusy(true); setMsg('');
    try {
      // Where there is no profile save to test, a (read-only) replies check
      // proves the same chain: attach, login, a real page load.
      await queueNaukriRunApi(capabilities.refresh ? 'refresh' : 'track');
      const m = capabilities.refresh
        ? 'Test queued — a refresh run proves the attach, the login and a real profile save. Watch it in Activity.'
        : `Test queued — a read-only replies check proves the attach, the ${site} login and a real page load. Watch it in Activity.`;
      toast(m, 'success'); setMsg(m);
      onChanged();
    } catch (e: any) { const m = e?.message || 'Could not queue the test run'; toast(m, 'error'); setMsg(m); }
    finally { setBusy(false); }
  };

  const togglePause = async () => {
    setBusy(true); setMsg('');
    try {
      await updateNaukriConfigApi({ safety: { pauseAll: !overview.paused } });
      // The kill switch deserves confirmation: its only other visible effect is
      // buttons quietly going grey.
      toast(overview.paused ? `Resumed — ${site} runs can start again.` : `Paused — the ${site} worker will be handed no work. Other platforms keep running.`,
        overview.paused ? 'success' : 'info');
      onChanged();
    } catch (e: any) { const m = e?.message || 'Could not change the pause switch'; toast(m, 'error'); setMsg(m); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Connection" icon="ti-plug-connected" collapsible id="connection" defaultOpen={false} scope="site"
      right={w.lastSeenAt ? <Muted>last seen {fmtTime(w.lastSeenAt)}</Muted> : null}>

      <Line ok={w.everSeen && w.online} label={w.host ? `Worker running on ${w.host}` : 'Worker running'}
            fix={w.everSeen
              ? `Your Mac is asleep or the worker stopped. It resumes ${w.nextWakeAt ? `at ${fmtTime(w.nextWakeAt)}` : 'when you open it'}.`
              : `Never checked in. Start the worker on your computer (see the Guide), or ask your admin to host it in the cloud.`} />
      <Line ok={w.chromeUp} label="Chrome on the debug port"
            fix="Run ./chrome-debug.sh in the scraper repo. Chrome refuses the debug port on your default profile, so it needs that dedicated one." />
      <Line ok={w.naukriLoggedIn} label={`Logged into ${site}`}
            fix={`Open ${site} inside the debug Chrome window and log in. The cookie persists across reboots; no password is ever stored here.`} />
      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
        Start command <code style={{ fontSize: 12 }}>npm run {platformId}-worker</code>
        {platformId !== 'naukri' && <> · or add it to <code>PLATFORMS</code> in .env for <code>npm run workers</code></>}
      </div>

      {overview.blockedUntil && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>
          Blocked until {fmtTime(overview.blockedUntil)} — {overview.blockedReason}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={probe} disabled={busy || overview.paused || !!overview.blockedUntil}>
          Test connection
        </button>
        <button className={`btn btn-sm${overview.paused ? ' btn-primary' : ''}`} onClick={togglePause} disabled={busy}>
          {overview.paused ? 'Resume' : `Pause ${site}`}
        </button>
      </div>
      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 8 }}>{msg}</div>}
    </Card>
  );
}
