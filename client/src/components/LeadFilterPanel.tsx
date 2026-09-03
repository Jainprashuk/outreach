import type { Lead } from '../lib/api';
import {
  DEFAULT_FILTERS, filterOptions,
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

/** Checkbox list — a real multi-select is unusable at this size. */
function MultiCheck({ options, selected, onChange, empty }: {
  options: Array<{ value: string; n: number; label?: string }>;
  selected: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  if (options.length === 0) return <div style={{ fontSize: 11, color: 'var(--text3)' }}>{empty}</div>;
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  return (
    <div style={{
      maxHeight: 132, overflowY: 'auto', border: '0.5px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '6px 8px',
    }}>
      {options.map(o => (
        <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {o.label || o.value}
          </span>
          <span style={{ color: 'var(--text3)', fontSize: 11 }}>{o.n}</span>
        </label>
      ))}
    </div>
  );
}

export default function LeadFilterPanel({ leads, filters, onChange, onReset, matched }: {
  leads: Lead[];
  filters: LeadFilters;
  onChange: (patch: Partial<LeadFilters>) => void;
  onReset: () => void;
  matched: number;
}) {
  const opts = filterOptions(leads);

  return (
    <div className="section" style={{ marginBottom: 14 }}>
      <div className="section-head">
        <span className="section-title"><i className="ti ti-filter" /> Filters</span>
        <span className="contact-count-badge">{matched} of {leads.length} match</span>
      </div>

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
          <Tri value={filters.hasEmail} onChange={v => onChange({ hasEmail: v })}
            yes="Contactable" no="No email" />
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

        <Group label="Hiring flag"><Tri value={filters.hiring} onChange={v => onChange({ hiring: v })} /></Group>
        <Group label="LinkedIn profile"><Tri value={filters.hasProfile} onChange={v => onChange({ hasProfile: v })} yes="Has one" no="Missing" /></Group>
        <Group label="Post link"><Tri value={filters.hasPost} onChange={v => onChange({ hasPost: v })} yes="Has one" no="Missing" /></Group>
        <Group label="Extra links"><Tri value={filters.hasLinks} onChange={v => onChange({ hasLinks: v })} yes="Has some" no="None" /></Group>

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

        <Group label="Hard rejects">
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, height: 34 }}>
            <input type="checkbox" checked={filters.hideRejects}
              onChange={e => onChange({ hideRejects: e.target.checked })} />
            Hide fit score −999
          </label>
        </Group>

        <Group label={`Email domain${filters.domains.length ? ` (${filters.domains.length})` : ''}`}>
          <MultiCheck options={opts.domains} selected={filters.domains}
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

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-sm" type="button" onClick={onReset}
          disabled={JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)}>
          <i className="ti ti-filter-off" /> Reset all filters
        </button>
      </div>
    </div>
  );
}
