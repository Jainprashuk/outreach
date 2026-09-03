import { useEffect, useRef, useState } from 'react';
import type { Lead } from '../lib/api';
import {
  countAdvanced, DEFAULT_FILTERS, filterOptions,
  type LeadFilters, type SortKey, type TriState,
} from '../lib/leadFilters';

const fmtRun = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Group({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="form-group" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label className="form-label">{label}</label>
      {children}
    </div>
  );
}

/** Yes / No / Any — the shape most of these fields take. */
function Tri({ value, onChange, yes = 'Yes', no = 'No' }: {
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
function MultiCheck({ options, selected, onChange, empty, search }: {
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

export default function LeadFilterPanel({ leads, filters, onChange, onReset, matched, onClose }: {
  leads: Lead[];
  filters: LeadFilters;
  onChange: (patch: Partial<LeadFilters>) => void;
  onReset: () => void;
  matched: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const ref = useRef<HTMLDivElement>(null);
  const opts = filterOptions(leads);
  const advCount = countAdvanced(filters);

  // Click-outside and Escape close the popover. `mousedown` rather than `click`
  // so a drag that starts inside doesn't count as an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      const t = e.target as Node;
      if (!ref.current.contains(t) && !(t as HTMLElement).closest?.('[data-filter-trigger]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS);

  return (
    <div ref={ref} style={{
      // 220 clears the selection bulk-bar (200) but stays under modals and the
      // mobile sidebar backdrop (250+).
      position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 220,
      width: 'min(580px, calc(100vw - 32px))',
      background: 'var(--bg)', border: '0.5px solid var(--border-md)',
      borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
      display: 'flex', flexDirection: 'column', maxHeight: '70vh',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: '0.5px solid var(--border)', flexShrink: 0,
      }}>
        <div className="nav-tabs" style={{ marginBottom: 0 }}>
          <div className={`nav-tab${tab === 'basic' ? ' active' : ''}`} onClick={() => setTab('basic')}>Basic</div>
          <div className={`nav-tab${tab === 'advanced' ? ' active' : ''}`} onClick={() => setTab('advanced')}>
            Advanced{advCount > 0 ? ` (${advCount})` : ''}
          </div>
        </div>
        <span className="contact-count-badge" style={{ marginLeft: 'auto' }}>{matched} of {leads.length}</span>
        <button className="btn btn-xs" type="button" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <div style={{ padding: '14px', overflowY: 'auto', flex: 1 }}>
        {tab === 'basic' ? (
          <div className="form-grid">
            <Group label="Status">
              <select value={filters.status} onChange={e => onChange({ status: e.target.value as LeadFilters['status'] })}>
                <option value="all">Any status</option>
                <option value="new">New</option>
                <option value="added-to-outreach">Added to outreach</option>
              </select>
            </Group>

            <Group label="Sort by">
              <select value={filters.sort} onChange={e => onChange({ sort: e.target.value as SortKey })}>
                <option value="fit-desc">Fit score — high to low</option>
                <option value="fit-asc">Fit score — low to high</option>
                <option value="newest">Recently imported</option>
                <option value="oldest">Oldest imported</option>
                <option value="name">Name A–Z</option>
                <option value="email">Email A–Z</option>
              </select>
            </Group>

            <Group label="Has an email">
              <Tri value={filters.hasEmail} onChange={v => onChange({ hasEmail: v })} yes="Contactable" no="No email" />
            </Group>

            <Group label="Email type">
              <select value={filters.emailKind} onChange={e => onChange({ emailKind: e.target.value as LeadFilters['emailKind'] })}>
                <option value="any">Any</option>
                <option value="corporate">Work domain</option>
                <option value="freemail">Personal (gmail etc.)</option>
              </select>
            </Group>

            <Group label="Fit score at least">
              <input type="number" placeholder="e.g. 5" value={filters.fitMin}
                onChange={e => onChange({ fitMin: e.target.value })} />
            </Group>

            <Group label="Fit score at most">
              <input type="number" placeholder="no limit" value={filters.fitMax}
                onChange={e => onChange({ fitMax: e.target.value })} />
            </Group>

            <Group label="Hard rejects" wide>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                <input type="checkbox" checked={filters.hideRejects}
                  onChange={e => onChange({ hideRejects: e.target.checked })} />
                Hide leads scored −999
              </label>
            </Group>

            <Group label={`Search query${filters.queries.length ? ` (${filters.queries.length})` : ''}`} wide>
              <MultiCheck options={opts.queries} selected={filters.queries} search
                onChange={v => onChange({ queries: v })}
                empty="No query recorded — re-import to backfill" />
            </Group>
          </div>
        ) : (
          <div className="form-grid">
            <Group label="Company">
              <select value={filters.company} onChange={e => onChange({ company: e.target.value as LeadFilters['company'] })}>
                <option value="any">Any</option>
                <option value="known">Known or inferable</option>
                <option value="unknown">Unknown</option>
              </select>
            </Group>

            <Group label="Role">
              <select value={filters.role} onChange={e => onChange({ role: e.target.value as LeadFilters['role'] })}>
                <option value="any">Any</option>
                <option value="set">Filled in</option>
                <option value="unset">Empty</option>
              </select>
            </Group>

            <Group label="Addresses per person">
              <select value={filters.addresses} onChange={e => onChange({ addresses: e.target.value as LeadFilters['addresses'] })}>
                <option value="any">Any</option>
                <option value="single">Single address</option>
                <option value="multi">Several addresses</option>
              </select>
            </Group>

            <Group label="Outreach result">
              <select value={filters.contact} onChange={e => onChange({ contact: e.target.value as LeadFilters['contact'] })}>
                <option value="any">Any</option>
                <option value="created">New contact created</option>
                <option value="existing">Contact already existed</option>
              </select>
            </Group>

            <Group label="Imported">
              <select value={filters.importedWithin} onChange={e => onChange({ importedWithin: e.target.value as LeadFilters['importedWithin'] })}>
                <option value="any">Any time</option>
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </Group>

            <Group label="Hiring flag"><Tri value={filters.hiring} onChange={v => onChange({ hiring: v })} /></Group>
            <Group label="LinkedIn profile"><Tri value={filters.hasProfile} onChange={v => onChange({ hasProfile: v })} yes="Has one" no="Missing" /></Group>
            <Group label="Post link"><Tri value={filters.hasPost} onChange={v => onChange({ hasPost: v })} yes="Has one" no="Missing" /></Group>
            <Group label="Extra links"><Tri value={filters.hasLinks} onChange={v => onChange({ hasLinks: v })} yes="Has some" no="None" /></Group>

            <Group label={`Email domain${filters.domains.length ? ` (${filters.domains.length})` : ''}`} wide>
              <MultiCheck options={opts.domains} selected={filters.domains} search
                onChange={v => onChange({ domains: v })} empty="No email addresses yet" />
            </Group>

            <Group label={`Source${filters.sources.length ? ` (${filters.sources.length})` : ''}`}>
              <MultiCheck options={opts.sources} selected={filters.sources}
                onChange={v => onChange({ sources: v })} empty="No sources recorded" />
            </Group>

            <Group label={`Harvest run${filters.runs.length ? ` (${filters.runs.length})` : ''}`}>
              <MultiCheck options={opts.runs.map(r => ({ ...r, label: fmtRun(r.value) }))}
                selected={filters.runs} onChange={v => onChange({ runs: v })} empty="No run data" />
            </Group>
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px',
        borderTop: '0.5px solid var(--border)', flexShrink: 0,
      }}>
        <button className="btn btn-sm" type="button" onClick={onReset} disabled={isDefault}>
          <i className="ti ti-filter-off" /> Reset all
        </button>
        <button className="btn btn-sm btn-primary" type="button" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Show {matched} lead{matched !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
