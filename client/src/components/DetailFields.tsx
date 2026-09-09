// Shared detail-modal primitives, extracted from LeadDetailModal so
// PostingDetailModal reuses the same label/value grammar instead of forking it.

/** Label + value row. `mono` for ids and keys. */
export function Field({ label, children, mono }: {
  label: string; children: React.ReactNode; mono?: boolean;
}) {
  return (
    <div className="lead-field">
      <div className="lead-field-label">{label}</div>
      <div
        className="lead-field-value"
        style={mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export const Ext = ({ href, children }: { href: string; children?: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{children || href}</a>
);

export const muted = (t: string) => <span style={{ color: 'var(--text3)' }}>{t}</span>;

/** The long date format both detail modals use. */
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';
