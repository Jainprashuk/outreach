import type { SyncRunReport } from '../lib/api';
import { BOARD_STATUS_LABELS, SOURCE_LABELS } from '../lib/postings';

/**
 * What the last sync actually did, per board.
 *
 * A board that 404s or times out MUST be visible here rather than showing as a
 * quiet zero — a silently broken board is the failure mode this whole feature
 * would die of.
 */
export default function SyncReportBanner({ report, onDismiss }: {
  report: SyncRunReport;
  onDismiss: () => void;
}) {
  if (report.ok === false && report.reason === 'locked') {
    return (
      <div className="info-box" style={{ marginBottom: 12 }}>
        <i className="ti ti-lock" />
        <span>
          A sync is already running{report.since ? ` (started ${new Date(report.since).toLocaleTimeString()})` : ''}.
          Nothing was done twice — try again in a moment.
        </span>
        <button className="btn btn-xs" type="button" style={{ marginLeft: 'auto' }} onClick={onDismiss}>
          <i className="ti ti-x" />
        </button>
      </div>
    );
  }

  if (report.reason === 'no-boards') {
    return (
      <div className="info-box" style={{ marginBottom: 12 }}>
        <i className="ti ti-info-circle" />
        <span>No enabled boards to sync yet — add one below.</span>
        <button className="btn btn-xs" type="button" style={{ marginLeft: 'auto' }} onClick={onDismiss}>
          <i className="ti ti-x" />
        </button>
      </div>
    );
  }

  const t = report.totals;
  const failures = report.boards.filter(b => b.status === 'not-found' || b.status === 'error');
  const massClosed = report.boards.filter(b => b.massClosed);
  const firstSyncs = report.boards.filter(b => b.firstSync && b.inserted > 0);

  const parts = [
    `${t.inserted} new`,
    `${t.closed} closed`,
    t.reopened > 0 ? `${t.reopened} reopened` : null,
    `${t.fetched} listed across ${t.boards} source${t.boards === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <div className="info-box" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
      <i className="ti ti-refresh" style={{ marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <strong>Synced in {(report.ms / 1000).toFixed(1)}s</strong> — {parts.join(' · ')}.
        </div>

        {t.filteredOut > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text2)' }}>
            {t.filteredOut} role{t.filteredOut === 1 ? '' : 's'} listed but not stored — your criteria
            excluded them. They're still open at the company; they were not closed.
          </div>
        )}

        {firstSyncs.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text2)' }}>
            {firstSyncs.map(b => `${b.label || b.token} added — ${b.inserted} postings imported`).join('; ')}.
            {' '}These are new to you, not newly posted, so they stay out of the New tab.
          </div>
        )}

        {massClosed.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>
            <i className="ti ti-alert-triangle" style={{ marginRight: 4 }} />
            {massClosed.map(b => (
              <span key={b.boardId}>
                <strong>{b.label || b.token}</strong> listed nothing and closed {b.closed} postings — check the token.
                {' '}
              </span>
            ))}
            Nothing was lost: your tracking is untouched and the next good sync reopens them.
          </div>
        )}

        {failures.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {failures.map(b => (
              <div key={b.boardId} style={{ color: 'var(--red)' }}>
                <i className="ti ti-x" style={{ marginRight: 4 }} />
                {SOURCE_LABELS[b.source]} · {b.token} — {b.error || BOARD_STATUS_LABELS[b.status]}
                {' '}<span style={{ color: 'var(--text3)' }}>(its postings were left alone)</span>
              </div>
            ))}
          </div>
        )}

        {t.skipped > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text3)' }}>
            {t.skipped} board{t.skipped === 1 ? '' : 's'} skipped — the run ran out of time. Sync again to finish;
            re-running is safe and changes nothing that already succeeded.
          </div>
        )}
      </div>
      <button className="btn btn-xs" type="button" onClick={onDismiss}><i className="ti ti-x" /></button>
    </div>
  );
}
