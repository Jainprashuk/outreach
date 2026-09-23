import { useState } from 'react';
import type { NaukriSchedule } from '../../../lib/api';
import { Card, Muted } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';
import { fmtTime, DAY_LABELS } from '../format';

// When the worker does things on its own.
//
// The three kind toggles are the part worth reading carefully. Refresh and
// harvest are safe to run on a clock — one re-saves your profile, the other only
// reads. Apply is off by default and the UI says why: applying should follow
// your approvals, not a timer. Turning it on means a scheduled wake will send
// applications for anything approved and still waiting.

export default function ScheduleCard({
  schedule, nextOccurrence, onSaved,
}: {
  schedule: NaukriSchedule;
  nextOccurrence: string | null;
  onSaved: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState<NaukriSchedule>(schedule);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const set = <K extends keyof NaukriSchedule>(k: K, v: NaukriSchedule[K]) =>
    setDraft(d => ({ ...d, [k]: v }));

  const toggleDay = (d: number) =>
    setDraft(s => ({
      ...s,
      days: s.days.includes(d) ? s.days.filter(x => x !== d) : [...s.days, d].sort(),
    }));

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const res = await updateNaukriConfigApi({ schedule: draft });
      onSaved(res.nextOccurrence);
    } catch (e: any) {
      setErr(e?.message || 'Could not save the schedule');
    } finally {
      setSaving(false);
    }
  };

  const noKinds = !draft.runRefresh && !draft.runHarvest && !draft.runApply;

  return (
    <Card title="Schedule" icon="ti-calendar-repeat"
      right={nextOccurrence && !noKinds && draft.enabled
        ? <Muted>Next: {fmtTime(nextOccurrence)}</Muted> : null}>

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

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Time</div>
          <input type="time" value={draft.time} onChange={e => set('time', e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Timezone</div>
          <input type="text" value={draft.timezone} onChange={e => set('timezone', e.target.value)} style={{ width: 160 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Catch-up window (hours)</div>
          <input
            type="number" min={0} max={24} value={draft.catchUpHours}
            onChange={e => set('catchUpHours', Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
      </div>
      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 14 }}>
        A missed slot only runs if you open the Mac within the catch-up window — so a Mac opened on
        Thursday does not fire Monday's runs.
      </div>

      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 6 }}>What fires on a scheduled wake</div>
      {([
        ['runRefresh', 'Refresh', 'Re-save your profile so recruiter search ranks you. Safe to run daily.'],
        ['runHarvest', 'Harvest', 'Collect new listings into the review queue. Read-only.'],
        ['runApply', 'Apply', 'Sends applications for anything already approved — without you being there.'],
      ] as const).map(([key, label, help]) => (
        <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontSize: 13 }}>
          <input type="checkbox" checked={draft[key]} onChange={e => set(key, e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            {label}
            {key === 'runApply' && draft.runApply && (
              <span style={{ color: 'var(--orange, var(--text2))' }}> — unattended</span>
            )}
            <div style={{ color: 'var(--text2)', fontSize: 12 }}>{help}</div>
          </span>
        </label>
      ))}

      {noKinds && draft.enabled && (
        <div style={{ fontSize: 12, color: 'var(--orange, var(--text2))', marginTop: 8 }}>
          Nothing is turned on, so the schedule will never fire.
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{err}</div>}

      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginTop: 12 }}>
        {saving ? 'Saving…' : 'Save schedule'}
      </button>
    </Card>
  );
}
