// The roles box for Discover searches: several roles, comma-separated, shown as
// chips so it's clear they're separate searches — plus your saved defaults.
import { useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { saveDefaultRolesApi } from '../../lib/api';

export const MAX_ROLES = 5;

/** "CTO, cto ,  Engineering  Manager" → ["CTO", "Engineering Manager"]. */
export const parseRoles = (text: string) => {
  const seen = new Set<string>();
  return text.split(',').map(r => r.replace(/\s+/g, ' ').trim())
    .filter(r => r && !seen.has(r.toLowerCase()) && !!seen.add(r.toLowerCase()));
};

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x.toLowerCase() === (b[i] || '').toLowerCase());

export default function RolesInput({ value, onChange, defaults, onDefaultsSaved, onEnter, placeholder }: {
  value: string;
  onChange: (text: string) => void;
  defaults: string[];
  onDefaultsSaved: (roles: string[]) => void;
  onEnter?: () => void;
  placeholder?: string;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const roles = parseRoles(value);
  const used = roles.slice(0, MAX_ROLES);

  const save = async (next: string[]) => {
    setSaving(true);
    try {
      const r = await saveDefaultRolesApi(next);
      onDefaultsSaved(r.defaultRoles);
      toast(next.length ? 'Saved — searches will start with these roles' : 'Default roles cleared', 'success');
    } catch (err: any) { toast(err.message, 'error'); } finally { setSaving(false); }
  };

  return (
    <div>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter(); }}
        placeholder={placeholder || 'engineering manager, CTO, recruiter — empty finds anyone'} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6, minHeight: 22 }}>
        {used.map(r => <span key={r} className="contact-count-badge">{r}</span>)}
        {roles.length > MAX_ROLES && (
          <span style={{ fontSize: 11, color: 'var(--red)' }}>only the first {MAX_ROLES} are searched</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          {roles.length
            ? `${used.length} role${used.length === 1 ? '' : 's'} · ${used.length} web search${used.length === 1 ? '' : 'es'}`
            : 'Separate several roles with commas'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {defaults.length > 0 && !same(roles, defaults) && (
            <button type="button" className="btn btn-xs" disabled={saving} onClick={() => onChange(defaults.join(', '))}
              title={defaults.join(', ')}>
              <i className="ti ti-arrow-back-up" /> My defaults
            </button>
          )}
          {roles.length > 0 && !same(used, defaults) && (
            <button type="button" className="btn btn-xs" disabled={saving} onClick={() => save(used)}>
              <i className="ti ti-bookmark" /> Save as default
            </button>
          )}
          {defaults.length > 0 && same(used, defaults) && (
            <button type="button" className="btn btn-xs" disabled={saving} onClick={() => save([])}
              title="Stop pre-filling these roles">
              <i className="ti ti-bookmark-off" /> Clear default
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
