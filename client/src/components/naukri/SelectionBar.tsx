import type { ReactNode } from 'react';
import { Muted } from './ui';

// The select-all / N-selected / actions strip.
//
// Shared by Waiting and Skipped so the two behave identically — same checkbox
// position, same "select all shown" wording, same place the buttons sit. The
// ACTIONS differ per tab, because the useful next step does, so they are passed
// in rather than baked here.
//
// "Select all shown" and not "select all": under a filter, or on a list capped
// at 200, the two are different and quietly acting on more than you can see is
// exactly the mistake this screen must not make possible.

export default function SelectionBar({ ids, selected, onChange, children, note }: {
  /** Every id currently rendered — what "select all shown" means. */
  ids: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** The tab's own buttons. Rendered only when something is selected. */
  children: ReactNode;
  note?: ReactNode;
}) {
  const all = ids.length > 0 && ids.every(id => selected.has(id));

  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      paddingBottom: 8, marginBottom: 4,
      borderBottom: '0.5px solid var(--border)',
    }}>
      <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox" checked={all}
          onChange={() => onChange(all ? new Set() : new Set(ids))}
          style={{ width: 15, height: 15 }}
        />
        Select all shown
      </label>

      {selected.size > 0
        ? <Muted>{selected.size} selected</Muted>
        : note ? <Muted>{note}</Muted> : null}

      {selected.size > 0 && (
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// The per-row checkbox, so every list uses the same hit area and alignment.
export function RowCheck({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <input
      type="checkbox" checked={checked} onChange={onToggle}
      style={{ width: 15, height: 15, flexShrink: 0, cursor: 'pointer' }}
    />
  );
}
