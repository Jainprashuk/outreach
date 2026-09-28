import { useEffect, useRef, useState } from 'react';
import { Group, MultiCheck, Tri } from './FilterControls';
import {
  contactChips, contactFilterOptions, DEFAULT_CONTACT_FILTERS,
  type ContactFilters, type ContactSortKey, type ShareContact,
} from '../lib/exportContactFilters';

function DateRange({ from, to, onFrom, onTo }: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="date" value={from} onChange={e => onFrom(e.target.value)} style={{ flex: 1 }} />
      <span style={{ color: 'var(--text3)', fontSize: 12 }}>to</span>
      <input type="date" value={to} onChange={e => onTo(e.target.value)} style={{ flex: 1 }} />
    </div>
  );
}

// Same popover conventions as LeadFilterPanel: Basic/Advanced tabs, click-outside
// and Escape to close, a matched count and a reset in the footer.
export default function ExportContactFilterPanel({ contacts, filters, onChange, onReset, matched, withDates, onClose }: {
  contacts: ShareContact[];
  filters: ContactFilters;
  onChange: (patch: Partial<ContactFilters>) => void;
  onReset: () => void;
  matched: number;
  withDates: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const ref = useRef<HTMLDivElement>(null);
  const opts = contactFilterOptions(contacts);
  const advCount = contactChips(filters).filter(c =>
    c.keys.some(k => ['templates', 'domains', 'emailKind', 'company', 'role', 'approval', 'followedUp'].includes(k))).length;

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

  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_CONTACT_FILTERS);

  return (
    <div ref={ref} className="filter-panel" style={{
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
          <button type="button" className={`nav-tab${tab === 'basic' ? ' active' : ''}`} onClick={() => setTab('basic')}>Basic</button>
          <button type="button" className={`nav-tab${tab === 'advanced' ? ' active' : ''}`} onClick={() => setTab('advanced')}>
            Advanced{advCount > 0 ? ` (${advCount})` : ''}
          </button>
        </div>
        <span className="contact-count-badge" style={{ marginLeft: 'auto' }}>{matched} of {contacts.length}</span>
        <button aria-label="Close" className="btn btn-xs" type="button" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <div style={{ padding: '14px', overflowY: 'auto', flex: 1 }}>
        {tab === 'basic' ? (
          <div className="form-grid">
            <Group label="Sort by">
              <select value={filters.sort} onChange={e => onChange({ sort: e.target.value as ContactSortKey })}>
                <option value="newest">Newest added</option>
                <option value="oldest">Oldest added</option>
                <option value="name">Name A–Z</option>
                <option value="company">Company A–Z</option>
                <option value="email">Email A–Z</option>
                {withDates && <option value="last-sent">Most recently emailed</option>}
              </select>
            </Group>
            <Group label="Came from">
              <select value={filters.source} onChange={e => onChange({ source: e.target.value as ContactFilters['source'] })}>
                <option value="any">Anywhere</option>
                <option value="lead">LinkedIn leads</option>
                <option value="outreach">Added directly (CSV, manual)</option>
              </select>
            </Group>
            <Group label="Replied"><Tri value={filters.replied} onChange={v => onChange({ replied: v })} /></Group>
            <Group label="Delivered"><Tri value={filters.delivered} onChange={v => onChange({ delivered: v })} yes="Delivered" no="Not delivered" /></Group>

            <Group label={`Status${filters.statuses.length ? ` (${filters.statuses.length})` : ''}`} wide>
              <MultiCheck options={opts.statuses} selected={filters.statuses}
                onChange={v => onChange({ statuses: v })} empty="No contacts yet" />
            </Group>
            <Group label={`Reply category${filters.categories.length ? ` (${filters.categories.length})` : ''}`} wide>
              <MultiCheck options={opts.categories} selected={filters.categories}
                onChange={v => onChange({ categories: v })} empty="No replies yet" />
            </Group>

            {withDates && (
              <>
                <Group label="Added" wide>
                  <DateRange from={filters.createdFrom} to={filters.createdTo}
                    onFrom={v => onChange({ createdFrom: v })} onTo={v => onChange({ createdTo: v })} />
                </Group>
                <Group label="Last sent" wide>
                  <DateRange from={filters.sentFrom} to={filters.sentTo}
                    onFrom={v => onChange({ sentFrom: v })} onTo={v => onChange({ sentTo: v })} />
                </Group>
                <Group label="Replied on" wide>
                  <DateRange from={filters.repliedFrom} to={filters.repliedTo}
                    onFrom={v => onChange({ repliedFrom: v })} onTo={v => onChange({ repliedTo: v })} />
                </Group>
              </>
            )}
          </div>
        ) : (
          <div className="form-grid">
            <Group label="Email type">
              <select value={filters.emailKind} onChange={e => onChange({ emailKind: e.target.value as ContactFilters['emailKind'] })}>
                <option value="any">Any</option>
                <option value="corporate">Work email</option>
                <option value="freemail">Personal (Gmail, Outlook…)</option>
              </select>
            </Group>
            <Group label="Approval">
              <select value={filters.approval} onChange={e => onChange({ approval: e.target.value as ContactFilters['approval'] })}>
                <option value="any">Any</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </Group>
            <Group label="Company">
              <select value={filters.company} onChange={e => onChange({ company: e.target.value as ContactFilters['company'] })}>
                <option value="any">Any</option>
                <option value="known">Known</option>
                <option value="unknown">Missing</option>
              </select>
            </Group>
            <Group label="Role">
              <select value={filters.role} onChange={e => onChange({ role: e.target.value as ContactFilters['role'] })}>
                <option value="any">Any</option>
                <option value="set">Set</option>
                <option value="unset">Missing</option>
              </select>
            </Group>
            <Group label="Follow-up sent"><Tri value={filters.followedUp} onChange={v => onChange({ followedUp: v })} /></Group>

            <Group label={`Template${filters.templates.length ? ` (${filters.templates.length})` : ''}`} wide>
              <MultiCheck options={opts.templates} selected={filters.templates}
                onChange={v => onChange({ templates: v })} empty="No templates recorded" search />
            </Group>
            <Group label={`Email domain${filters.domains.length ? ` (${filters.domains.length})` : ''}`} wide>
              <MultiCheck options={opts.domains} selected={filters.domains}
                onChange={v => onChange({ domains: v })} empty="No domains" search />
            </Group>
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px',
        borderTop: '0.5px solid var(--border)', flexShrink: 0,
      }}>
        <button className="btn btn-sm" type="button" onClick={onReset} disabled={isDefault}>
          <i className="ti ti-filter-off" /> Reset filters
        </button>
        <button className="btn btn-sm btn-primary" type="button" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Show {matched} contact{matched !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
