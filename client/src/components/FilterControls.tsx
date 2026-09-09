import { useState } from 'react';
import type { TriState } from '../lib/leadFilters';

// Shared filter-panel primitives. Extracted from LeadFilterPanel so
// PostingFilterPanel can reuse them rather than fork them — leaving them inside
// one page's panel would make the second consumer look like a mistake.
//
// TriState still lives in lib/leadFilters.ts: it is a working public API used by
// LeadFilters, and moving it would churn that for no gain.
export type { TriState };

export function Group({ label, children, wide }: {
  label: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="form-group" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label className="form-label">{label}</label>
      {children}
    </div>
  );
}

/** Yes / No / Any — the shape most of these fields take. */
export function Tri({ value, onChange, yes = 'Yes', no = 'No' }: {
  value: TriState; onChange: (v: TriState) => void; yes?: string; no?: string;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as TriState)}>
      <option value="any">Any</option>
      <option value="yes">{yes}</option>
      <option value="no">{no}</option>
    </select>
  );
}

/** Checkbox list — a native multi-select is unusable at these option counts. */
export function MultiCheck({ options, selected, onChange, empty, search }: {
  options: Array<{ value: string; n: number; label?: string }>;
  selected: string[];
  onChange: (v: string[]) => void;
  empty: string;
  search?: boolean;
}) {
  const [q, setQ] = useState('');
  if (options.length === 0) return <div style={{ fontSize: 11, color: 'var(--text3)' }}>{empty}</div>;

  const shown = q.trim()
    ? options.filter(o => (o.label || o.value).toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);

  return (
    <div>
      {search && options.length > 8 && (
        <input type="text" placeholder={`Filter ${options.length} options…`} value={q}
          onChange={e => setQ(e.target.value)} style={{ marginBottom: 6, fontSize: 12 }} />
      )}
      <div style={{
        maxHeight: 150, overflowY: 'auto', border: '0.5px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: '6px 8px',
      }}>
        {shown.length === 0 && <div style={{ fontSize: 11, color: 'var(--text3)' }}>No match</div>}
        {shown.map(o => (
          <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.label || o.value}
            </span>
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>{o.n}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <button className="btn btn-xs" type="button" style={{ marginTop: 6 }} onClick={() => onChange([])}>
          Clear {selected.length} selected
        </button>
      )}
    </div>
  );
}
