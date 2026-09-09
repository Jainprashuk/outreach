import { useEffect, useRef, useState } from 'react';
import type { BoardSource, JobBoard, Posting, TrackStatus } from '../lib/api';
import {
  countAdvanced, DEFAULT_FILTERS, filterOptions, SORT_LABELS,
  type PostingFilters, type PostingSortKey,
} from '../lib/postingFilters';
import { SOURCE_LABELS, TRACK_STATUS_LABELS, TRACK_STATUS_ORDER } from '../lib/postings';
import { Group, MultiCheck, Tri } from './FilterControls';

const WITHIN_OPTIONS: Array<[PostingFilters['postedWithin'], string]> = [
  ['any', 'Any time'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'],
];

export default function PostingFilterPanel({ postings, boards, filters, onChange, onReset, matched, onClose }: {
  postings: Posting[];
  boards: JobBoard[];
  filters: PostingFilters;
  onChange: (patch: Partial<PostingFilters>) => void;
  onReset: () => void;
  matched: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const ref = useRef<HTMLDivElement>(null);
  const opts = filterOptions(postings, boards);
  const advCount = countAdvanced(filters);

  // mousedown rather than click, so a drag starting inside doesn't read as an
  // outside click. Same behaviour as LeadFilterPanel.
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
          <div className={`nav-tab${tab === 'basic' ? ' active' : ''}`} onClick={() => setTab('basic')}>Basic</div>
          <div className={`nav-tab${tab === 'advanced' ? ' active' : ''}`} onClick={() => setTab('advanced')}>
            Advanced{advCount > 0 ? ` (${advCount})` : ''}
          </div>
        </div>
        <span className="contact-count-badge" style={{ marginLeft: 'auto' }}>{matched} of {postings.length}</span>
        <button className="btn btn-xs" type="button" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <div style={{ padding: '14px', overflowY: 'auto', flex: 1 }}>
        {tab === 'basic' ? (
          <div className="form-grid">
            <Group label="Sort by">
              <select value={filters.sort}
                onChange={e => onChange({ sort: e.target.value as PostingSortKey })}>
                {(Object.keys(SORT_LABELS) as PostingSortKey[]).map(k => (
                  <option key={k} value={k}>{SORT_LABELS[k]}</option>
                ))}
              </select>
            </Group>

            <Group label="Your tracking status">
              <select value={filters.trackStatus}
                onChange={e => onChange({ trackStatus: e.target.value as PostingFilters['trackStatus'] })}>
                <option value="any">Any</option>
                <option value="tracked">Anything tracked</option>
                {TRACK_STATUS_ORDER.map(s => (
                  <option key={s} value={s}>{TRACK_STATUS_LABELS[s as TrackStatus]}</option>
                ))}
              </select>
            </Group>

            <Group label="Remote">
              <Tri value={filters.remote} onChange={v => onChange({ remote: v })} yes="Remote" no="Not remote" />
            </Group>

            <Group label="Has an apply link">
              <Tri value={filters.hasApplyUrl} onChange={v => onChange({ hasApplyUrl: v })} />
            </Group>

            <Group label="Posted">
              <select value={filters.postedWithin}
                onChange={e => onChange({ postedWithin: e.target.value as PostingFilters['postedWithin'] })}>
                {WITHIN_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Group>

            <Group label={`Source${filters.sources.length ? ` (${filters.sources.length})` : ''}`}>
              <MultiCheck options={opts.sources} selected={filters.sources}
                onChange={v => onChange({ sources: v as BoardSource[] })} empty="No postings yet" />
            </Group>

            <Group label={`Board${filters.boards.length ? ` (${filters.boards.length})` : ''}`} wide>
              <MultiCheck options={opts.boards} selected={filters.boards} search
                onChange={v => onChange({ boards: v })} empty="No boards tracked yet" />
            </Group>
          </div>
        ) : (
          <div className="form-grid">
            <Group label="First seen">
              <select value={filters.firstSeenWithin}
                onChange={e => onChange({ firstSeenWithin: e.target.value as PostingFilters['firstSeenWithin'] })}>
                {WITHIN_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Group>

            <Group label="Closed">
              <select value={filters.closedWithin}
                onChange={e => onChange({ closedWithin: e.target.value as PostingFilters['closedWithin'] })}>
                {WITHIN_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Group>

            <Group label="Seen at least N times">
              <input type="number" min={1} placeholder="any" value={filters.seenMin}
                onChange={e => onChange({ seenMin: e.target.value })} />
            </Group>

            <Group label={`Workplace${filters.workplaceTypes.length ? ` (${filters.workplaceTypes.length})` : ''}`}>
              <MultiCheck options={opts.workplaceTypes} selected={filters.workplaceTypes}
                onChange={v => onChange({ workplaceTypes: v })} empty="Not reported by any board" />
            </Group>

            <Group label={`Employment type${filters.employmentTypes.length ? ` (${filters.employmentTypes.length})` : ''}`}>
              <MultiCheck options={opts.employmentTypes} selected={filters.employmentTypes}
                onChange={v => onChange({ employmentTypes: v })} empty="Not reported by any board" />
            </Group>

            <Group label={`Country${filters.countries.length ? ` (${filters.countries.length})` : ''}`}>
              <MultiCheck options={opts.countries} selected={filters.countries} search
                onChange={v => onChange({ countries: v })} empty="No country data" />
            </Group>

            <Group label={`Department${filters.departments.length ? ` (${filters.departments.length})` : ''}`} wide>
              <MultiCheck options={opts.departments} selected={filters.departments} search
                onChange={v => onChange({ departments: v })} empty="No department data" />
            </Group>

            <Group label={`Location${filters.locations.length ? ` (${filters.locations.length})` : ''}`} wide>
              <MultiCheck options={opts.locations} selected={filters.locations} search
                onChange={v => onChange({ locations: v })} empty="No location data" />
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
          Show {matched} posting{matched !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
