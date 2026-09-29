import type { ReactNode } from 'react';

/** An ⓘ that explains itself on hover, and on tap/focus for touch and keyboard. */
export default function InfoTip({ children, label = 'More info' }: { children: ReactNode; label?: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="button" aria-label={label} onClick={e => e.stopPropagation()}>
      <i className="ti ti-info-circle" />
      <span className="info-tip-body" role="tooltip">{children}</span>
    </span>
  );
}
