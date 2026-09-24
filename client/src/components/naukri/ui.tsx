import { useState, type ReactNode } from 'react';

// Small shared primitives for the Naukri tab.
//
// They exist because the first pass of this UI invented class names — `.page`,
// `.card`, `.input`, `.page-info` — none of which are in this app's stylesheet,
// so the whole tab rendered as unstyled text on a bare background. The fix is
// not more inline styles scattered per file; it is a handful of pieces built
// from the tokens the rest of the app already uses (--bg, --border, --radius-lg,
// --text2), so the tab looks like the product rather than like a form.
//
// Anything with a real class in style.css uses that class instead of these:
// .btn/.btn-sm/.btn-xs/.btn-primary, .badge, .nav-tabs/.nav-tab, .form-label,
// .empty-state, .progress-bar/.progress-fill, .contact-count-badge, and every
// bare <input>/<select>/<textarea>, which the stylesheet already styles globally
// — they need no className at all.

export function Card({ title, icon, right, badge, children, style, collapsible, id, defaultOpen = true }: {
  title?: string; icon?: string; right?: ReactNode; children: ReactNode;
  /** Shown beside the title even when collapsed — for a count that means
      "there is something for you in here", which a hidden card must still say. */
  badge?: ReactNode;
  style?: React.CSSProperties;
  /** Give the header a disclosure control. Needs `id` to remember its state. */
  collapsible?: boolean;
  /** Stable key for remembering open/closed. Without it the card stays open. */
  id?: string;
  defaultOpen?: boolean;
}) {
  // Remembered per card, because the Configuration tab is eight of these and
  // scrolling past the seven you are not editing is most of the work. Kept in
  // localStorage rather than server state: it is a per-browser convenience, not
  // a setting, and it must not fail if storage is blocked.
  const key = id ? `naukri-card-${id}` : null;
  const [open, setOpen] = useState(() => {
    if (!collapsible || !key) return true;
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === '1';
    } catch { return defaultOpen; }
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (key) { try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* private window */ } }
  };

  return (
    <div style={{
      background: 'var(--bg)',
      border: '0.5px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      padding: '14px 16px',
      marginBottom: 14,
      ...style,
    }}>
      {(title || right) && (
        <div className="section-head" style={{ marginBottom: open ? 12 : 0 }}>
          <span
            className="section-title"
            onClick={collapsible ? toggle : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              cursor: collapsible ? 'pointer' : 'default', userSelect: 'none',
              flex: 1,
            }}
          >
            {collapsible && (
              <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 13 }} />
            )}
            {icon && <i className={`ti ${icon}`} style={{ fontSize: 14 }} />}
            {title}
            {badge}
          </span>
          {/* Header actions stay reachable while collapsed only if they make
              sense there; a card's own Save does not, so callers pass `right`
              for status, not for controls. */}
          {open && right}
        </div>
      )}
      {open && children}
    </div>
  );
}

// The band labels on the Activity view (NOW / NEXT / PAST). Same visual weight
// as .section-title, which is what they are.
export const Band = ({ children }: { children: ReactNode }) => (
  <span className="section-title">{children}</span>
);

// Secondary text. `.page-info` looks like the right class but is only defined
// scoped under .pagination-bar, so on its own it does nothing.
export function Muted({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <span style={{ color: 'var(--text2)', fontSize: 12, ...style }}>{children}</span>;
}

export function Hint({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <div style={{ color: 'var(--text3)', fontSize: 11, marginTop: 3, lineHeight: 1.5, ...style }}>{children}</div>;
}

// Rows of labelled controls that wrap sensibly on a phone.
export const Row = ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12, ...style }}>
    {children}
  </div>
);

export function Field({ label, hint, width, children }: {
  label: string; hint?: string; width?: number | string; children: ReactNode;
}) {
  return (
    <label style={{ display: 'block', width: width ?? 'auto', flex: width ? undefined : 1, minWidth: 140 }}>
      <span className="form-label">{label}{hint && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · {hint}</span>}</span>
      {children}
    </label>
  );
}

// A checkbox with its explanation underneath, which is most of this tab's
// settings — a bare label would leave the consequences unstated.
export function Check({ checked, onChange, label, help, tone }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; help?: ReactNode;
  tone?: 'warn';
}) {
  return (
    <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ width: 15, height: 15, marginTop: 2, flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: tone === 'warn' ? 'var(--red)' : 'var(--text)' }}>
        {label}
        {help && <Hint>{help}</Hint>}
      </span>
    </label>
  );
}

export function Notice({ tone = 'info', icon, children }: {
  tone?: 'info' | 'danger' | 'warn'; icon?: string; children: ReactNode;
}) {
  const style = tone === 'danger'
    ? { background: 'var(--red-bg)', color: 'var(--red)', border: '0.5px solid color-mix(in srgb, var(--red) 25%, transparent)' }
    : tone === 'warn'
      ? { background: 'var(--bg3)', color: 'var(--text)', border: '0.5px solid var(--border-md)' }
      : {};
  return (
    <div className="info-box" style={style}>
      {icon && <i className={`ti ${icon}`} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{children}</span>
    </div>
  );
}

export const Empty = ({ icon, children }: { icon?: string; children: ReactNode }) => (
  <div className="empty-state">
    {icon && <i className={`ti ${icon}`} />}
    {children}
  </div>
);
