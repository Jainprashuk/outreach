import { useState } from 'react';
import type { NaukriConfig } from '../../../lib/api';
import { Card } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';

// The caps, and the two switches that decide whether this thing is safe.
//
// autoApproveEnabled is THE gate. While it is off — the default — nothing can be
// applied to without you clicking Approve on that specific job. Turning it on
// means the worker decides, so it asks for a typed confirmation rather than a
// click: an accidental toggle here has consequences an accidental toggle
// elsewhere does not.
//
// dryRun is the opposite: it makes an apply run rehearse everything and submit
// nothing. It is how you verify a selector fix without spending a real
// application, and it costs nothing to leave on while you are unsure.

export default function ApplyCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [a, setA] = useState(config.apply);
  const [safety, setSafety] = useState(config.safety);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => setA(x => ({ ...x, [k]: v }));

  const saveApply = async () => {
    setBusy(true); setMsg('');
    try {
      // The server clamps maxPerRun to its own hard cap regardless of what we
      // send; echo back what it actually stored rather than what was typed.
      const r = await updateNaukriConfigApi({ apply: a });
      setA(r.config.apply);
      setMsg(`Saved. Max ${r.config.apply.maxPerRun} per run, ${r.config.apply.maxPerDay} per day.`);
      onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const setSafetyFlag = async (k: 'pauseAll' | 'dryRun', v: boolean) => {
    setBusy(true); setMsg('');
    try {
      setSafety(s => ({ ...s, [k]: v }));
      await updateNaukriConfigApi({ safety: { [k]: v } });
      onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const enableAuto = async () => {
    if (confirm.trim().toUpperCase() !== 'APPLY WITHOUT ME') return;
    setBusy(true);
    try {
      await updateNaukriConfigApi({ apply: { ...a, autoApproveEnabled: true } });
      set('autoApproveEnabled', true); setConfirm(''); onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not enable'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Apply behaviour & safety" icon="ti-send">

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max per run</div>
          <input type="number" min={1} max={20} style={{ width: 100 }}
            value={a.maxPerRun} onChange={e => set('maxPerRun', Number(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max per day</div>
          <input type="number" min={1} max={200} style={{ width: 100 }}
            value={a.maxPerDay} onChange={e => set('maxPerDay', Number(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Gap min (ms)</div>
          <input type="number" min={500} style={{ width: 110 }}
            value={a.delayMinMs} onChange={e => set('delayMinMs', Number(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Gap max (ms)</div>
          <input type="number" min={500} style={{ width: 110 }}
            value={a.delayMaxMs} onChange={e => set('delayMaxMs', Number(e.target.value))} />
        </label>
      </div>
      <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 12 }}>
        Max per run is capped at 20 server-side whatever you type here. The gap is randomised between
        every job — a fixed interval is a signature.
      </div>

      <label style={{ display: 'block', fontSize: 13, marginBottom: 12 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Cover note, where Naukri offers one</div>
        <textarea rows={3} style={{ width: '100%' }}
          value={a.coverNote} onChange={e => set('coverNote', e.target.value)} />
      </label>

      <button className="btn btn-primary btn-sm" onClick={saveApply} disabled={busy} style={{ marginBottom: 16 }}>
        {busy ? 'Saving…' : 'Save apply settings'}
      </button>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 10 }}>
          <input type="checkbox" checked={safety.dryRun}
            onChange={e => setSafetyFlag('dryRun', e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Dry run
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>
              Walk the whole flow, fill every field, submit nothing, and log what it would have sent.
            </div>
          </span>
        </label>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={safety.pauseAll}
            onChange={e => setSafetyFlag('pauseAll', e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Pause all
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>
              The kill switch. The worker is handed no work at all while this is on.
            </div>
          </span>
        </label>

        <div style={{ padding: 10, borderRadius: 6, background: 'var(--bg2)' }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            Auto-approve: <strong style={{ color: a.autoApproveEnabled ? 'var(--orange, var(--text2))' : 'inherit' }}>
              {a.autoApproveEnabled ? 'ON' : 'off'}
            </strong>
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 8 }}>
            While off, nothing is applied to unless you approve that specific job. Turning it on lets the
            worker send applications on its own, including on a schedule while you are asleep.
          </div>
          {a.autoApproveEnabled ? (
            <button className="btn btn-sm" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try { await updateNaukriConfigApi({ apply: { ...a, autoApproveEnabled: false } }); set('autoApproveEnabled', false); onSaved(); }
                finally { setBusy(false); }
              }}>
              Turn auto-approve off
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder='type: APPLY WITHOUT ME' value={confirm}
                onChange={e => setConfirm(e.target.value)} style={{ flex: 1, minWidth: 170 }} />
              <button className="btn btn-sm" disabled={busy || confirm.trim().toUpperCase() !== 'APPLY WITHOUT ME'}
                onClick={enableAuto}>Enable</button>
            </div>
          )}
        </div>
      </div>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 10 }}>{msg}</div>}
    </Card>
  );
}
