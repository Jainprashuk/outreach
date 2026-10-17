// Admin → AI logs: the switch that moves every account onto its own AI keys
// (lib/ai/keys.js), the grace date, and how many accounts are ready. Turning it
// off is the instant rollback: everyone runs on your env keys again.
import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import Switch from './Switch';
import { adminAiRolloutApi, adminSetAiRolloutApi, type AiRollout } from '../lib/api';

const GRACE_DAYS = 7;
const day = (iso: string) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
// <input type="date"> speaks yyyy-mm-dd in local time; the grace ends at the END of that day.
const toInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + GRACE_DAYS * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const endOfDay = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T23:59:00`).toISOString();

export default function AiKeysRollout() {
  const toast = useToast();
  const [r, setR] = useState<AiRollout | null>(null);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminAiRolloutApi().then(v => { setR(v); setDate(toInput(v.graceUntil)); }).catch(() => setR(null));
  }, []);

  const apply = async (change: { enforce?: boolean; graceUntil?: string | null }, done: string) => {
    setBusy(true);
    try {
      const v = await adminSetAiRolloutApi(change);
      setR(v); setDate(toInput(v.graceUntil));
      toast(done, 'success');
    } catch (e: any) { toast(e.message || 'That did not work', 'error'); }
    finally { setBusy(false); }
  };

  if (!r) return null;
  const c = r.counts;

  const toggle = (on: boolean) => {
    if (on) {
      const until = endOfDay(date || toInput(null));
      if (!window.confirm(`Start the move to users' own AI keys?\n\nAccounts with no key keep using your keys until ${day(until)}. `
        + `The banner and bell notice appear now, and the announcement email goes out (if lifecycle emails and that type are on).`)) return;
      apply({ enforce: true, graceUntil: until }, 'Rollout started');
    } else {
      if (!window.confirm('Turn the rollout off? Every account goes back to running on your keys.')) return;
      apply({ enforce: false }, 'Rollout off — everyone is on your keys again');
    }
  };

  return (
    <div className="an-card" style={{ marginBottom: 16 }}>
      <div className="an-card-body" style={{ fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <i className="ti ti-key" style={{ fontSize: 16 }} />
          <b style={{ fontSize: 13.5 }}>AI keys rollout</b>
          <span style={{ flex: 1 }} />
          <Switch label="Users bring their own AI keys" checked={r.enforce} disabled={busy} onChange={toggle} />
        </div>
        <div style={{ color: 'var(--text2)', marginBottom: 10 }}>
          {!r.enforce && 'Off: every account runs on your keys, as before. Users can already add their own in Settings.'}
          {r.enforce && r.inGrace && r.graceUntil && <>Grace period until <b>{day(r.graceUntil)}</b>: accounts without a key still use yours.</>}
          {r.enforce && !r.inGrace && 'On: accounts without their own key have no AI, unless you turn on the fallback for them (Overview → account → Use my AI keys).'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <label htmlFor="ai-grace" style={{ color: 'var(--text2)' }}>Grace ends</label>
          <input id="ai-grace" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 'auto' }} disabled={busy} />
          {r.enforce && (
            <button className="btn btn-xs" type="button" disabled={busy || !date || endOfDay(date) === r.graceUntil}
              onClick={() => apply({ graceUntil: endOfDay(date) }, 'Grace date saved')}>
              Save date
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text2)' }}>
          <span>{c.active} active</span>
          <span style={{ color: 'var(--green)' }}>{c.withBackup} with Groq + a backup</span>
          <span style={{ color: 'var(--green)' }}>{c.groqOnly} with Groq only</span>
          <span>{c.fallback} on your fallback</span>
          <span style={{ color: c.none ? 'var(--red)' : undefined }}>{c.none} with no Groq key</span>
        </div>
      </div>
    </div>
  );
}
