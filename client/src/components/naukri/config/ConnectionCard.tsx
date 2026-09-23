import { useState } from 'react';
import type { NaukriOverview } from '../../../lib/api';
import { queueNaukriRunApi, updateNaukriConfigApi } from '../../../lib/api';
import { fmtTime } from '../format';

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
         style={{ color: ok ? 'var(--ok, #16a34a)' : 'var(--danger, #dc2626)', fontSize: 15, marginTop: 1 }} />
      <span>
        {label}
        {!ok && fix && <div className="page-info" style={{ fontSize: 12 }}>{fix}</div>}
      </span>
    </div>
  );
}

export default function ConnectionCard({ overview, onChanged }: {
  overview: NaukriOverview; onChanged: () => void;
}) {
  const w = overview.worker;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const probe = async () => {
    setBusy(true); setMsg('');
    try {
      await queueNaukriRunApi('refresh');
      setMsg('Queued a refresh. Watch it in Activity — it proves the attach, the login and a real save.');
      onChanged();
    } catch (e: any) { setMsg(e?.message || 'Could not queue the test run'); }
    finally { setBusy(false); }
  };

  const togglePause = async () => {
    setBusy(true); setMsg('');
    try {
      await updateNaukriConfigApi({ safety: { pauseAll: !overview.paused } });
      onChanged();
    } catch (e: any) { setMsg(e?.message || 'Could not change the pause switch'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <i className="ti ti-plug-connected" />
        <strong style={{ flex: 1 }}>Connection</strong>
        {w.lastSeenAt && <span className="page-info">last seen {fmtTime(w.lastSeenAt)}</span>}
      </div>

      <Line ok={w.everSeen && w.online} label={w.host ? `Worker running on ${w.host}` : 'Worker running'}
            fix={w.everSeen
              ? `Your Mac is asleep or the worker stopped. It resumes ${w.nextWakeAt ? `at ${fmtTime(w.nextWakeAt)}` : 'when you open it'}.`
              : 'Never checked in. Run `npm run naukri-worker` on your Mac.'} />
      <Line ok={w.chromeUp} label="Chrome on the debug port"
            fix="Run ./chrome-debug.sh in the scraper repo. Chrome refuses the debug port on your default profile, so it needs that dedicated one." />
      <Line ok={w.naukriLoggedIn} label="Logged into Naukri"
            fix="Open naukri.com inside the debug Chrome window and log in. The cookie persists across reboots; no password is ever stored here." />

      {overview.blockedUntil && (
        <div style={{ fontSize: 12, color: 'var(--danger, #dc2626)', marginTop: 8 }}>
          Blocked until {fmtTime(overview.blockedUntil)} — {overview.blockedReason}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={probe} disabled={busy || overview.paused || !!overview.blockedUntil}>
          Test connection
        </button>
        <button className={`btn btn-sm${overview.paused ? ' btn-primary' : ''}`} onClick={togglePause} disabled={busy}>
          {overview.paused ? 'Resume' : 'Pause all'}
        </button>
      </div>
      {msg && <div className="page-info" style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
