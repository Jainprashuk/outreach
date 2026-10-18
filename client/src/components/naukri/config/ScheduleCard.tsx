import { useState } from 'react';
import type { NaukriSchedule, NaukriSlot, NaukriOccurrence } from '../../../lib/api';
import { Card, Muted, Hint } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';
import { fmtTime, DAY_LABELS } from '../format';
import { useToast } from '../../../context/ToastContext';

// When the worker does things on its own.
//
// Up to three times a day, each with its own steps. The usual shape is one
// morning wake that refreshes, harvests and applies, plus an afternoon
// apply-only time — which is how auto-approved jobs reach the daily cap rather
// than stopping at one run's worth. Apply is off on the first time by default:
// applying should follow approvals, and ticking it means a scheduled wake sends
// applications for anything approved and waiting.
//
// The first time is stored as the schedule's own time + toggles (as before);
// times two and three are `extraSlots`. To the user they are just "times".

const MAX_TIMES = 3;
const KINDS = [
  ['runRefresh', 'Refresh', 'Re-save your profile so recruiter search ranks you'],
  ['runHarvest', 'Harvest', 'Collect new listings into the inbox (read-only)'],
  ['runApply', 'Apply', 'Send applications for jobs in Waiting — unattended'],
  ['runTrack', 'Track replies', 'Read what recruiters did (viewed, shortlisted, contacted) from Naukri — read-only'],
] as const;

type Kind = typeof KINDS[number][0];

export default function ScheduleCard({
  schedule, upcoming, pollSeconds, onSaved,
}: {
  schedule: NaukriSchedule;
  upcoming: NaukriOccurrence[];
  pollSeconds: number;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<NaukriSchedule>({ ...schedule, extraSlots: schedule.extraSlots || [] });
  const [poll, setPoll] = useState(pollSeconds);
  const [next, setNext] = useState<NaukriOccurrence[]>(upcoming);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const set = <K extends keyof NaukriSchedule>(k: K, v: NaukriSchedule[K]) =>
    setDraft(d => ({ ...d, [k]: v }));

  // Times as one list for editing: index 0 is the schedule's own.
  const times: NaukriSlot[] = [
    { time: draft.time, runRefresh: draft.runRefresh, runHarvest: draft.runHarvest, runApply: draft.runApply, runTrack: draft.runTrack !== false },
    ...draft.extraSlots,
  ];
  const setTime = (i: number, patch: Partial<NaukriSlot>) => {
    if (i === 0) { setDraft(d => ({ ...d, ...patch })); return; }
    setDraft(d => ({ ...d, extraSlots: d.extraSlots.map((s, j) => (j === i - 1 ? { ...s, ...patch } : s)) }));
  };
  const addTime = () => setDraft(d => ({
    ...d, extraSlots: [...d.extraSlots, { time: d.extraSlots.length ? '18:00' : '14:00', runRefresh: false, runHarvest: false, runApply: true, runTrack: false }],
  }));
  const removeTime = (i: number) => setDraft(d => ({ ...d, extraSlots: d.extraSlots.filter((_, j) => j !== i - 1) }));

  const toggleDay = (d: number) =>
    setDraft(s => ({
      ...s,
      days: s.days.includes(d) ? s.days.filter(x => x !== d) : [...s.days, d].sort(),
    }));

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const { lastFiredAt: _ignored, ...schedulePatch } = draft;
      const res = await updateNaukriConfigApi({ schedule: schedulePatch, worker: { pollSeconds: poll } });
      setNext(res.upcoming || []);
      setPoll(res.config.worker?.pollSeconds ?? poll);
      toast(draft.enabled && res.nextOccurrence
        ? `Schedule saved — next run ${fmtTime(res.nextOccurrence)}.`
        : 'Schedule saved — automatic runs are off.', 'success');
      onSaved();
    } catch (e: any) {
      const m = e?.message || 'Could not save the schedule';
      toast(m, 'error'); setErr(m);
    } finally {
      setSaving(false);
    }
  };

  const nothingOn = times.every(t => !t.runRefresh && !t.runHarvest && !t.runApply && !t.runTrack);
  const applyAnywhere = times.some(t => t.runApply);

  return (
    <Card title="Schedule" icon="ti-calendar-repeat" collapsible id="schedule" defaultOpen={false}
      right={draft.enabled && next[0] ? <Muted>Next: {fmtTime(next[0].at)}</Muted> : null}>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13 }}>
        <input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} />
        Run automatically
      </label>

      <div style={{ marginBottom: 12 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 6 }}>Days</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DAY_LABELS.map((label, d) => (
            <button
              key={d} type="button" onClick={() => toggleDay(d)}
              className={`btn btn-sm${draft.days.includes(d) ? ' btn-primary' : ''}`}
              style={{ minWidth: 46 }}
            >{label}</button>
          ))}
        </div>
      </div>

      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 6 }}>Times, and what each one does</div>
      {times.map((t, i) => (
        <div key={i} style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '8px 10px', marginBottom: 6, background: 'var(--bg2)', borderRadius: 'var(--radius)',
        }}>
          <input type="time" value={t.time} onChange={e => setTime(i, { time: e.target.value })} style={{ width: 110 }} />
          {KINDS.map(([key, label, help]) => (
            <label key={key} title={help} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={!!t[key as Kind]} onChange={e => setTime(i, { [key]: e.target.checked })} />
              {label}
            </label>
          ))}
          {i > 0 && (
            <button className="btn btn-xs" type="button" onClick={() => removeTime(i)} style={{ marginLeft: 'auto' }}>
              <i className="ti ti-trash" /> Remove
            </button>
          )}
        </div>
      ))}
      {times.length < MAX_TIMES && (
        <button className="btn btn-sm" type="button" onClick={addTime} style={{ marginBottom: 6 }}>
          <i className="ti ti-plus" /> Add a time
        </button>
      )}
      <Hint style={{ marginBottom: 12 }}>
        Refresh re-saves your profile · Harvest fills the inbox (read-only) · Apply sends jobs in Waiting, freshest
        postings first · Track replies reads recruiter actions (read-only). A second Apply time (e.g. 14:00) gets the
        day&apos;s new listings out while they are fresh.
        {applyAnywhere
          ? ' Apply is ticked, so scheduled wakes send applications without you there — within the daily cap.'
          : ' Apply is not ticked anywhere, so approved and auto-approved jobs only go out when you press Apply.'}
      </Hint>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Timezone</div>
          <input type="text" value={draft.timezone} onChange={e => set('timezone', e.target.value)} style={{ width: 160 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Catch-up window (hours)</div>
          <input
            type="number" min={0} max={12} value={draft.catchUpHours}
            onChange={e => set('catchUpHours', Math.min(12, Math.max(0, Number(e.target.value))))}
            style={{ width: 90 }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Worker check-in (seconds)</div>
          <input
            type="number" min={15} max={120} value={poll}
            onChange={e => setPoll(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
      </div>
      <Hint style={{ marginBottom: 12 }}>
        A missed time still runs if your Mac wakes within the catch-up window; if it slept through two, only the
        later one runs. The check-in is how often the worker asks for work (15–120s) — it uses a new value from
        its next check-in, no restart needed.
      </Hint>

      {draft.enabled && next.length > 0 && (
        <div style={{ fontSize: 12, marginBottom: 10 }}>
          <div style={{ color: 'var(--text2)', marginBottom: 3 }}>Next runs (as saved)</div>
          {next.slice(0, 4).map(o => (
            <div key={o.at}>{fmtTime(o.at)} — {o.kinds.join(' + ')}</div>
          ))}
        </div>
      )}

      {nothingOn && draft.enabled && (
        <div style={{ fontSize: 12, color: 'var(--orange, var(--text2))', marginTop: 8 }}>
          Nothing is ticked, so the schedule will never fire.
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{err}</div>}

      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginTop: 6 }}>
        {saving ? 'Saving…' : 'Save schedule'}
      </button>
    </Card>
  );
}
