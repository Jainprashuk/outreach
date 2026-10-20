import { useState } from 'react';
import type { ApplyMode, NaukriConfig } from '../../../lib/api';
import { Card, Notice } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';
import { usePlatform } from '../platform';

const MODES: Array<[ApplyMode, string]> = [['off', 'Off'], ['dry-run', 'Dry run'], ['on', 'On']];

// The caps, and the two switches that decide whether this thing is safe.
//
// autoApproveEnabled is THE gate. While it is off — the default — nothing can be
// applied to without you clicking Approve on that specific job. Turning it on
// lets a harvest approve NEW jobs whose fit score reaches the threshold (never
// predicted company-site ones); they wait in Waiting and go out on the
// schedule's Apply runs. It asks for a typed confirmation rather than a click:
// an accidental toggle here has consequences an accidental toggle elsewhere
// does not.
//
// dryRun is the opposite: it makes an apply run rehearse everything and submit
// nothing. It is how you verify a selector fix without spending a real
// application, and it costs nothing to leave on while you are unsure.

export default function ApplyCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [a, setA] = useState(config.apply);
  const toast = useToast();
  const { label, capabilities, id: platformId } = usePlatform();
  const [mode, setMode] = useState<ApplyMode>(config.applyMode || (config.safety.dryRun ? 'dry-run' : 'on'));
  const [safety, setSafety] = useState(config.safety);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [scheduleApplies, setScheduleApplies] = useState(
    !!config.schedule.enabled && (config.schedule.runApply || (config.schedule.extraSlots || []).some(s => s.runApply)),
  );

  const turnOnScheduledApply = async () => {
    setBusy(true);
    try {
      await updateNaukriConfigApi({ schedule: { enabled: true, runApply: true } });
      setScheduleApplies(true);
      toast('Apply ticked on your schedule\'s first time.', 'success');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not update the schedule', 'error'); }
    finally { setBusy(false); }
  };

  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => setA(x => ({ ...x, [k]: v }));

  const saveApply = async () => {
    setBusy(true); setMsg('');
    try {
      // The server clamps maxPerRun to its own hard cap regardless of what we
      // send; echo back what it actually stored rather than what was typed.
      const r = await updateNaukriConfigApi({ apply: a });
      setA(r.config.apply);
      { toast(`Saved. Max ${r.config.apply.maxPerRun} per run, ${r.config.apply.maxPerDay} per day.`, 'success'); setMsg(`Saved. Max ${r.config.apply.maxPerRun} per run, ${r.config.apply.maxPerDay} per day.`); };
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const setSafetyFlag = async (k: 'pauseAll' | 'dryRun', v: boolean) => {
    setBusy(true); setMsg('');
    try {
      setSafety(s => ({ ...s, [k]: v }));
      await updateNaukriConfigApi({ safety: { [k]: v } });
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  // Off / Dry run / On. Real apply stays locked on a platform whose apply step
  // is not proven on the live site yet (the server refuses it too).
  const setApplyMode = async (m: ApplyMode) => {
    if (m === mode) return;
    setBusy(true); setMsg('');
    try {
      const r = await updateNaukriConfigApi({ applyMode: m });
      setMode(r.config.applyMode || m);
      setSafety(s => ({ ...s, dryRun: m === 'dry-run' }));
      toast(`${label} apply: ${m === 'off' ? 'off' : m === 'dry-run' ? 'dry run' : 'on'}.`, 'success');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not change apply', 'error'); setMsg(e?.message || 'Could not change apply'); }
    finally { setBusy(false); }
  };

  const enableAuto = async () => {
    if (confirm.trim().toUpperCase() !== 'APPLY WITHOUT ME') return;
    setBusy(true);
    try {
      await updateNaukriConfigApi({ apply: { ...a, autoApproveEnabled: true } });
      set('autoApproveEnabled', true); setConfirm(''); onSaved();
    } catch (e: any) { toast(e?.message || 'Could not enable', 'error'); setMsg(e?.message || 'Could not enable'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Apply behaviour & safety" icon="ti-send" collapsible id="apply" defaultOpen={false} scope="site">

      <div style={{ marginBottom: 14 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Apply</div>
        <div role="radiogroup" aria-label={`${label} apply`} style={{ display: 'inline-flex', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {MODES.map(([m, text]) => {
            const locked = (m === 'on' && !capabilities.apply) || (m === 'dry-run' && !capabilities.dryRun);
            return (
              <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={busy || locked}
                title={locked ? `Real apply on ${label} isn't verified yet — use Dry run until it is.` : undefined}
                onClick={() => setApplyMode(m)} className={`btn btn-sm${mode === m ? ' btn-primary' : ''}`}
                style={{ borderRadius: 0, border: 'none' }}>
                {text}
              </button>
            );
          })}
        </div>
        <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 4 }}>
          Dry run walks the whole flow, fills every field, submits nothing and logs what it would have sent.
          {platformId !== 'naukri' && ' Off means this platform only harvests and checks replies.'}
          {!capabilities.apply && ` Real apply on ${label} unlocks once its dry runs match what you see on the site.`}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max per run</div>
          <input type="number" min={1} style={{ width: 100 }}
            value={a.maxPerRun} onChange={e => set('maxPerRun', Number(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max per day</div>
          <input type="number" min={1} style={{ width: 100 }}
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
        No limit beyond what you set here. A run never takes more than what is left of today&apos;s limit. Going well past
        30–40 a day can start to look automated to {label} — your call. The gap is randomised
        between every job — a fixed interval is a signature.
      </div>

      <label style={{ display: 'block', fontSize: 13, marginBottom: 12 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Auto-approve jobs scoring at least</div>
        <input type="number" min={50} max={100} style={{ width: 100 }}
          value={a.autoApproveMinScore} onChange={e => set('autoApproveMinScore', Number(e.target.value))} />
        <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 3 }}>
          50–100. The fit score is on every inbox row — hover it to see why. Only used while auto-approve is on.
        </div>
      </label>

      <button className="btn btn-primary btn-sm" onClick={saveApply} disabled={busy} style={{ marginBottom: 16 }}>
        {busy ? 'Saving…' : 'Save apply settings'}
      </button>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={safety.pauseAll}
            onChange={e => setSafetyFlag('pauseAll', e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Pause {label}
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>
              The kill switch: this worker gets no work at all while this is on. Other platforms keep running.
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
            While off, nothing is applied to unless you approve that specific job. While on, each harvest
            approves new jobs scoring {a.autoApproveMinScore}+ (never likely company-site ones, never duplicates you
            already applied to or approved on another platform). They wait in
            Jobs → Waiting — where you can un-approve any — and go out on the schedule&apos;s Apply runs.
          </div>
          {a.autoApproveEnabled && !scheduleApplies && (
            <Notice tone="warn" icon="ti-alert-triangle">
              None of {label}&apos;s schedule times has Apply ticked, so auto-approved jobs will wait until you press
              Apply.{' '}
              <button className="btn btn-xs" type="button" disabled={busy} onClick={turnOnScheduledApply}>Tick Apply on the schedule</button>
            </Notice>
          )}
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
