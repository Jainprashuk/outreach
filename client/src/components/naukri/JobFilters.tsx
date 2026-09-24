import { useState } from 'react';
import type { NaukriJobQuery } from '../../lib/api';
import { Muted, Hint } from './ui';

// Filters for the review queue.
//
// Deliberately NOT the same thing as Configuration → Filters. Those decide what
// the worker stores at all, and changing them is a decision about future
// harvests. These only narrow what you are looking at right now, so they are
// cheap to fiddle with, reset in one click, and never touch your config.
//
// The search box is debounced by the caller; everything else applies on change,
// because a dropdown you have to "apply" is a dropdown people forget to apply.

export interface Draft {
  q: string; location: string;
  minExp: string; maxExp: string; minSalary: string; maxAge: string;
  sort: NonNullable<NaukriJobQuery['sort']>;
  /** '' = all. Otherwise only jobs of that apply type. */
  applyType: '' | 'native' | 'external';
}

export const EMPTY: Draft = {
  q: '', location: '', minExp: '', maxExp: '', minSalary: '', maxAge: '', sort: 'newest',
  applyType: '',
};

// Draft -> query, dropping anything blank so the server sees only real filters.
export function toQuery(d: Draft): NaukriJobQuery {
  const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
  return {
    q: d.q.trim() || undefined,
    location: d.location.trim() || undefined,
    minExp: n(d.minExp), maxExp: n(d.maxExp),
    minSalary: n(d.minSalary), maxAge: n(d.maxAge),
    sort: d.sort === 'newest' ? undefined : d.sort,
    applyType: d.applyType || undefined,
  };
}

export const activeCount = (d: Draft) =>
  (['q', 'location', 'minExp', 'maxExp', 'minSalary', 'maxAge'] as const)
    .filter(k => d[k].trim() !== '').length
  + (d.sort !== 'newest' ? 1 : 0) + (d.applyType ? 1 : 0);

export default function JobFilters({ draft, onChange, total, showing, truncated, typeCounts }: {
  draft: Draft;
  onChange: (next: Draft) => void;
  total: number;
  showing: number;
  truncated?: boolean;
  typeCounts?: { all: number; external: number; native: number };
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  const active = activeCount(draft);

  const Num = ({ k, placeholder, width = 86 }: { k: keyof Draft; placeholder: string; width?: number }) => (
    <input
      type="number" min={0} placeholder={placeholder} value={draft[k] as string}
      onChange={e => set(k, e.target.value as Draft[typeof k])}
      style={{ width }}
    />
  );

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Apply type, as chips rather than a checkbox buried in the panel below.
          It is the first thing worth filtering on — roughly half the board hands
          off to the employer's own site and the worker cannot apply to those —
          so hiding it behind a disclosure meant nobody found it. */}
      {typeCounts && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 9, flexWrap: 'wrap', alignItems: 'center' }}>
          {([
            ['', 'All', typeCounts.all, 'ti-list'],
            ['native', 'Naukri apply', typeCounts.native, 'ti-bolt'],
            ['external', 'Company site', typeCounts.external, 'ti-external-link'],
          ] as const).map(([value, label, n, icon]) => (
            <button
              key={value || 'all'} type="button"
              onClick={() => set('applyType', value as Draft['applyType'])}
              className={`btn btn-sm${draft.applyType === value ? ' btn-primary' : ''}`}
            >
              <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
              <span className="contact-count-badge" style={{ marginLeft: 6 }}>{n}</span>
            </button>
          ))}
          <Hint style={{ marginTop: 0, flexBasis: '100%' }}>
            “Company site” is an employer already seen handing off to their own careers page — the worker
            cannot apply to those. “Naukri apply” is everything else, which is a prediction rather than a
            promise: an employer we have not seen do it yet still might.
          </Hint>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text" placeholder="Search title, company or skill…"
          value={draft.q} onChange={e => set('q', e.target.value)}
          style={{ flex: 1, minWidth: 190 }}
        />
        <select value={draft.sort} onChange={e => set('sort', e.target.value as Draft['sort'])} style={{ width: 150 }}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="experience">Least experience</option>
          <option value="company">Company A–Z</option>
        </select>
        <button className={`btn btn-sm${active ? ' btn-primary' : ''}`} type="button" onClick={() => setOpen(v => !v)}>
          <i className="ti ti-filter" /> Filters
          {active > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{active}</span>}
          <i className={`ti ti-chevron-${open ? 'up' : 'down'}`} style={{ marginLeft: 4, fontSize: 12 }} />
        </button>
        {active > 0 && (
          <button className="btn btn-sm" type="button" onClick={() => onChange(EMPTY)}>Clear</button>
        )}
      </div>

      {open && (
        <div style={{
          marginTop: 10, padding: '12px 14px',
          background: 'var(--bg2)', border: '0.5px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end',
        }}>
          <label>
            <span className="form-label">Experience (yrs)</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Num k="minExp" placeholder="min" width={74} />
              <Muted>to</Muted>
              <Num k="maxExp" placeholder="max" width={74} />
            </span>
          </label>

          <label>
            <span className="form-label">Min salary (LPA)</span>
            <Num k="minSalary" placeholder="any" width={100} />
          </label>

          <label>
            <span className="form-label">Posted within (days)</span>
            <Num k="maxAge" placeholder="any" width={110} />
          </label>

          <label style={{ flex: 1, minWidth: 150 }}>
            <span className="form-label">Location</span>
            <input
              type="text" placeholder="e.g. Gurugram" value={draft.location}
              onChange={e => set('location', e.target.value)} style={{ width: '100%' }}
            />
          </label>

          <Hint style={{ flexBasis: '100%', marginTop: 0 }}>
            Experience matches when the listing&apos;s band overlaps yours — a 3–8 yrs role still shows at 4.
            Listings that don&apos;t publish pay are kept, since most of Naukri hides it.
          </Hint>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <Muted>
          {active > 0
            ? `${total} match${total === 1 ? '' : 'es'}${showing < total ? ` · showing ${showing}` : ''}`
            : `${total} awaiting review${showing < total ? ` · showing ${showing}` : ''}`}
          {truncated && ' · count is a floor, narrow the filters for an exact number'}
        </Muted>
      </div>
    </div>
  );
}
