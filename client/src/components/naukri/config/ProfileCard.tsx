import { useState } from 'react';
import type { NaukriConfig, NaukriProfileFields } from '../../../lib/api';
import { Card } from '../ui';
import { updateNaukriConfigApi, naukriProfileFromResumeApi, isAiKeyRequired } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

// You, in the form the screening questions ask for.
//
// These are not just stored — they are what {{placeholders}} in the answer bank
// resolve to at apply time, so changing your expected CTC here updates every
// answer rule that quotes it. That indirection is the whole reason this card
// exists separately from the answer bank.

const toList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

type Suggested = Awaited<ReturnType<typeof naukriProfileFromResumeApi>>['suggested'];
type Pick = 'skills' | 'totalExperienceMonths' | 'currentDesignation' | 'currentCompany' | 'currentLocation' | 'highestQualification';
const PICK_LABEL: Record<Pick, string> = {
  skills: 'Skills', totalExperienceMonths: 'Total experience', currentDesignation: 'Current designation',
  currentCompany: 'Current company', currentLocation: 'Current location', highestQualification: 'Highest qualification',
};
const yrs = (m: number | null | undefined) => (m == null ? '' : `${Math.floor(m / 12)} yrs ${m % 12} mo`);

export default function ProfileCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [p, setP] = useState<NaukriProfileFields>(config.profile);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const set = <K extends keyof NaukriProfileFields>(k: K, v: NaukriProfileFields[K]) =>
    setP(x => ({ ...x, [k]: v }));

  const num = (v: string) => (v === '' ? null : Number(v));

  // Fill from resume: AI reads the resume and SUGGESTS values; you tick which
  // to take. Empty fields are ticked for you; ones you already filled are not.
  const [reading, setReading] = useState(false);
  const [sugg, setSugg] = useState<Suggested | null>(null);
  const [take, setTake] = useState<Record<Pick, boolean>>({} as Record<Pick, boolean>);
  const newSkills = sugg ? sugg.skills.filter(s => !p.skills.some(x => x.toLowerCase() === s.toLowerCase())) : [];

  const fillFromResume = async () => {
    setReading(true);
    try {
      const { suggested } = await naukriProfileFromResumeApi();
      const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);
      const t = {} as Record<Pick, boolean>;
      (Object.keys(PICK_LABEL) as Pick[]).forEach((k) => {
        const has = k === 'skills' ? suggested.skills.length > 0 : !empty(suggested[k]);
        t[k] = has && (k === 'skills' || empty(p[k]));
      });
      setSugg(suggested); setTake(t);
    } catch (e: any) {
      toast(isAiKeyRequired(e) ? e.message : (e?.message || 'Could not read the resume'), 'error');
    } finally { setReading(false); }
  };

  const applySuggestions = () => {
    if (!sugg) return;
    setP((x) => {
      const next = { ...x };
      if (take.skills) next.skills = [...x.skills, ...newSkills];
      if (take.totalExperienceMonths && sugg.totalExperienceMonths != null) next.totalExperienceMonths = sugg.totalExperienceMonths;
      for (const k of ['currentDesignation', 'currentCompany', 'currentLocation', 'highestQualification'] as const) {
        if (take[k] && sugg[k]) next[k] = sugg[k];
      }
      return next;
    });
    setSugg(null);
    toast('Filled in — check it, add CTC and notice period, then Save profile.', 'success');
  };

  const save = async () => {
    setSaving(true); setMsg('');
    try { await updateNaukriConfigApi({ profile: p }); { toast('Saved.', 'success'); setMsg('Saved.'); }; onSaved(); }
    catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const Field = ({ label, k, type = 'text', width = 180, hint }: {
    label: string; k: keyof NaukriProfileFields; type?: string; width?: number; hint?: string;
  }) => (
    <label style={{ fontSize: 13, marginBottom: 10, display: 'inline-block', marginRight: 12 }}>
      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>
        {label}{hint && <span style={{ opacity: .7 }}> · {hint}</span>}
      </div>
      <input
        type={type} style={{ width }}
        value={(p[k] as string | number | null) ?? ''}
        onChange={e => set(k, (type === 'number' ? num(e.target.value) : e.target.value) as NaukriProfileFields[typeof k])}
      />
    </label>
  );

  return (
    <Card title="Profile" icon="ti-user" collapsible id="profile" defaultOpen={false} scope="shared"
      right={<button className="btn btn-xs" type="button" onClick={fillFromResume} disabled={reading}
        title="Read skills, experience and current role from your resume — you choose what to keep">
        {reading ? <><i className="ti ti-loader-2 tc-spin" /> Reading…</> : <><i className="ti ti-sparkles" /> Fill from resume</>}
      </button>}>

      {sugg && (
        <div style={{ padding: 10, background: 'var(--bg2)', borderRadius: 'var(--radius)', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>From your resume — tick what to use</div>
          {(Object.keys(PICK_LABEL) as Pick[]).map((k) => {
            const value = k === 'skills'
              ? (newSkills.length ? `add ${newSkills.length}: ${newSkills.join(', ')}` : '')
              : k === 'totalExperienceMonths' ? yrs(sugg.totalExperienceMonths) : (sugg[k] as string);
            if (!value) return null;
            const now = k === 'skills' ? '' : k === 'totalExperienceMonths' ? yrs(p.totalExperienceMonths) : (p[k] as string);
            return (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, padding: '3px 0' }}>
                <input type="checkbox" checked={!!take[k]} onChange={e => setTake(t => ({ ...t, [k]: e.target.checked }))} style={{ marginTop: 3 }} />
                <span>
                  <strong>{PICK_LABEL[k]}:</strong> {value}
                  {now && now !== value && <span style={{ color: 'var(--text2)' }}> (now: {now})</span>}
                </span>
              </label>
            );
          })}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-sm btn-primary" type="button" onClick={applySuggestions}>Use ticked</button>
            <button className="btn btn-sm" type="button" onClick={() => setSugg(null)}>Cancel</button>
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 6 }}>
            Only skills that appear in your resume are suggested. Nothing is saved until you press Save profile.
          </div>
        </div>
      )}

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
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Preferred locations</div>
        <input type="text" style={{ width: '100%' }} placeholder="comma separated"
          value={(p.preferredLocations || []).join(', ')}
          onChange={e => set('preferredLocations', toList(e.target.value))} />
      </label>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Skills</div>
        <input type="text" style={{ width: '100%' }} placeholder="comma separated"
          value={(p.skills || []).join(', ')}
          onChange={e => set('skills', toList(e.target.value))} />
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={p.willingToRelocate}
          onChange={e => set('willingToRelocate', e.target.checked)} />
        Willing to relocate
      </label>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save profile'}
      </button>
    </Card>
  );
}
