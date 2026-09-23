import { useState } from 'react';
import type { NaukriConfig, NaukriProfileFields } from '../../../lib/api';
import { updateNaukriConfigApi } from '../../../lib/api';

// You, in the form the screening questions ask for.
//
// These are not just stored — they are what {{placeholders}} in the answer bank
// resolve to at apply time, so changing your expected CTC here updates every
// answer rule that quotes it. That indirection is the whole reason this card
// exists separately from the answer bank.

const toList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export default function ProfileCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [p, setP] = useState<NaukriProfileFields>(config.profile);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const set = <K extends keyof NaukriProfileFields>(k: K, v: NaukriProfileFields[K]) =>
    setP(x => ({ ...x, [k]: v }));

  const num = (v: string) => (v === '' ? null : Number(v));

  const save = async () => {
    setSaving(true); setMsg('');
    try { await updateNaukriConfigApi({ profile: p }); setMsg('Saved.'); onSaved(); }
    catch (e: any) { setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const Field = ({ label, k, type = 'text', width = 180, hint }: {
    label: string; k: keyof NaukriProfileFields; type?: string; width?: number; hint?: string;
  }) => (
    <label style={{ fontSize: 13, marginBottom: 10, display: 'inline-block', marginRight: 12 }}>
      <div className="page-info" style={{ marginBottom: 4 }}>
        {label}{hint && <span style={{ opacity: .7 }}> · {hint}</span>}
      </div>
      <input
        className="input" type={type} style={{ width }}
        value={(p[k] as string | number | null) ?? ''}
        onChange={e => set(k, (type === 'number' ? num(e.target.value) : e.target.value) as NaukriProfileFields[typeof k])}
      />
    </label>
  );

  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <i className="ti ti-user" />
        <strong style={{ flex: 1 }}>Profile</strong>
      </div>

      <div>
        <Field label="Full name" k="fullName" />
        <Field label="Email" k="email" />
        <Field label="Phone" k="phone" width={150} />
      </div>
      <div>
        <Field label="Current company" k="currentCompany" />
        <Field label="Current designation" k="currentDesignation" />
        <Field label="Current location" k="currentLocation" width={150} />
      </div>
      <div>
        <Field label="Notice period" k="noticePeriodDays" type="number" width={110} hint="days" />
        <Field label="Current CTC" k="currentCtcLpa" type="number" width={110} hint="LPA" />
        <Field label="Expected CTC" k="expectedCtcLpa" type="number" width={110} hint="LPA" />
        <Field label="Total experience" k="totalExperienceMonths" type="number" width={130} hint="months" />
      </div>
      <div>
        <Field label="Highest qualification" k="highestQualification" width={220} />
      </div>

      <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
        <div className="page-info" style={{ marginBottom: 4 }}>Preferred locations</div>
        <input className="input" style={{ width: '100%' }} placeholder="comma separated"
          value={(p.preferredLocations || []).join(', ')}
          onChange={e => set('preferredLocations', toList(e.target.value))} />
      </label>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
        <div className="page-info" style={{ marginBottom: 4 }}>Skills</div>
        <input className="input" style={{ width: '100%' }} placeholder="comma separated"
          value={(p.skills || []).join(', ')}
          onChange={e => set('skills', toList(e.target.value))} />
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={p.willingToRelocate}
          onChange={e => set('willingToRelocate', e.target.checked)} />
        Willing to relocate
      </label>

      {msg && <div className="page-info" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save profile'}
      </button>
    </div>
  );
}
