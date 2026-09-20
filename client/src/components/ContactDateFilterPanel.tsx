import { useEffect, useRef } from 'react';
import { Group } from './FilterControls';

export type ContactDateFilters = {
  createdFrom: string; createdTo: string;
  sentFrom: string; sentTo: string;
  repliedFrom: string; repliedTo: string;
};

export const DEFAULT_DATE_FILTERS: ContactDateFilters = {
  createdFrom: '', createdTo: '',
  sentFrom: '', sentTo: '',
  repliedFrom: '', repliedTo: '',
};

export const countActiveDateFilters = (f: ContactDateFilters) =>
  Object.values(f).filter(Boolean).length;

function DateRange({ fromValue, toValue, onFrom, onTo }: {
  fromValue: string; toValue: string;
  onFrom: (v: string) => void; onTo: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="date" value={fromValue} onChange={e => onFrom(e.target.value)} style={{ flex: 1 }} />
      <span style={{ color: 'var(--text3)', fontSize: 12 }}>to</span>
      <input type="date" value={toValue} onChange={e => onTo(e.target.value)} style={{ flex: 1 }} />
    </div>
  );
}

// Popover date-range filter, matching the LeadFilterPanel convention (same .filter-panel
// positioning/close behavior and Group/form-grid primitives) rather than a new UI pattern.
export default function ContactDateFilterPanel({ filters, onChange, onReset, matched, total, onClose }: {
  filters: ContactDateFilters;
  onChange: (patch: Partial<ContactDateFilters>) => void;
  onReset: () => void;
  matched: number;
  total: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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

  const isDefault = countActiveDateFilters(filters) === 0;

  return (
    <div ref={ref} className="filter-panel" style={{
      // Anchored from the right, not the left — this trigger sits near the right edge of the
      // filter row, so a left-anchored panel spills past the viewport edge (the "to" date
      // inputs were getting clipped).
      position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 220,
      width: 'min(420px, calc(100vw - 32px))',
      background: 'var(--bg)', border: '0.5px solid var(--border-md)',
      borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
      display: 'flex', flexDirection: 'column', maxHeight: '70vh',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: '0.5px solid var(--border)', flexShrink: 0,
      }}>
        <strong style={{ fontSize: 13 }}>Date filters</strong>
        <span className="contact-count-badge" style={{ marginLeft: 'auto' }}>{matched} of {total}</span>
        <button aria-label="Close" className="btn btn-xs" type="button" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <div style={{ padding: '14px', overflowY: 'auto', flex: 1 }}>
        <div className="form-grid">
          <Group label="Added" wide>
            <DateRange
              fromValue={filters.createdFrom} toValue={filters.createdTo}
              onFrom={v => onChange({ createdFrom: v })} onTo={v => onChange({ createdTo: v })}
            />
          </Group>
          <Group label="Last sent" wide>
            <DateRange
              fromValue={filters.sentFrom} toValue={filters.sentTo}
              onFrom={v => onChange({ sentFrom: v })} onTo={v => onChange({ sentTo: v })}
            />
          </Group>
          <Group label="Replied" wide>
            <DateRange
              fromValue={filters.repliedFrom} toValue={filters.repliedTo}
              onFrom={v => onChange({ repliedFrom: v })} onTo={v => onChange({ repliedTo: v })}
            />
          </Group>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px',
        borderTop: '0.5px solid var(--border)', flexShrink: 0,
      }}>
        <button className="btn btn-sm" type="button" onClick={onReset} disabled={isDefault}>
          <i className="ti ti-filter-off" /> Reset dates
        </button>
        <button className="btn btn-sm btn-primary" type="button" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Show {matched} contact{matched !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
