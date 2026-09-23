import { useState } from 'react';
import type { NaukriRun } from '../../lib/api';
import { fmtRunTime, elapsed } from './format';
import { Muted, Empty } from './ui';

// The PAST band: what already happened, newest first, each row expandable.
//
// A run history that only shows a status badge is a history you stop reading.
// The row carries the one number that matters for its kind, and expanding it
// gives the per-job outcomes or the error — the two things you actually open a
// run to find out.

const BADGE: Record<NaukriRun['status'], string> = {
  done: 'badge-sent', failed: 'badge-rejected', blocked: 'badge-rejected',
  cancelled: 'badge-closed', queued: 'badge-queued', running: 'badge-pending',
};

const KIND_ICON: Record<string, string> = {
  refresh: 'ti-refresh', harvest: 'ti-download', apply: 'ti-send', probe: 'ti-activity',
};

// One line naming what the run achieved, in its own terms. A refresh has no
// counts worth printing; an apply's counts are the whole story.
function summary(run: NaukriRun): string {
  const s = run.stats;
  if (run.status === 'failed' || run.status === 'blocked') return run.error ? '' : 'no detail recorded';
  switch (run.kind) {
    case 'refresh': return 'profile updated';
    case 'harvest': return `${s.found} found · ${s.new} new${s.updated ? ` · ${s.updated} updated` : ''}`;
    case 'apply': {
      // A rehearsal reports what it walked, never a count that reads as work
      // done. "0 applied" on a dry run looks like a failure; it isn't one.
      if (run.dryRun) return `${s.rehearsed || 0} rehearsed — nothing submitted`;
      const parts = [`${s.applied} applied`];
      if (s.skipped) parts.push(`${s.skipped} skipped`);
      if (s.failed) parts.push(`${s.failed} failed`);
      return parts.join(' · ');
    }
    default: return '';
  }
}

function Row({ run }: { run: NaukriRun }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!run.error || run.results.length > 0;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={() => hasDetail && setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
          padding: '9px 0', cursor: hasDetail ? 'pointer' : 'default',
        }}
      >
        <span className={`badge ${BADGE[run.status]}`}>{run.status}</span>
        <i className={`ti ${KIND_ICON[run.kind] || 'ti-point'}`} style={{ fontSize: 14, color: 'var(--text2)' }} />
        <span style={{ minWidth: 70, fontSize: 13 }}>{run.kind}</span>
        <Muted style={{ minWidth: 118 }}>{fmtRunTime(run.createdAt)}</Muted>
        <Muted style={{ flex: 1, minWidth: 150 }}>{summary(run)}</Muted>
        {run.trigger === 'scheduled' && <Muted>scheduled</Muted>}
        {hasDetail && <i className={`ti ti-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: 14, color: 'var(--text2)' }} />}
      </div>

      {open && (
        <div style={{ padding: '2px 0 12px 12px', borderLeft: '2px solid var(--border)', marginLeft: 4 }}>
          {run.error && (
            <div style={{ fontSize: 12, color: 'var(--red)', whiteSpace: 'pre-wrap', marginBottom: 8, lineHeight: 1.6 }}>
              {run.error}
            </div>
          )}
          {run.results.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 62, color: r.outcome === 'applied' ? 'var(--green)' : 'var(--text2)' }}>
                {r.outcome}
              </span>
              <span style={{ minWidth: 200 }}>{r.title}{r.company ? ` · ${r.company}` : ''}</span>
              <Muted style={{ flex: 1 }}>{r.reason}</Muted>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RunTimeline({ runs }: { runs: NaukriRun[] }) {
  if (!runs.length) {
    return <Empty icon="ti-history">Nothing has run yet.</Empty>;
  }
  return <div>{runs.map(r => <Row key={r.id} run={r} />)}</div>;
}

// The NOW band. Separate from the history rows because a live run needs
// different furniture — a bar, the current label, a cancel — and sharing one
// component would make both worse.
export function ActiveRun({ run, onCancel }: { run: NaukriRun; onCancel?: () => void }) {
  const p = run.progress;
  const pct = p.pagesTotal > 0 ? Math.min(100, Math.round((p.page / p.pagesTotal) * 100)) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span className="badge badge-pending">{run.status}</span>
        <strong style={{ fontSize: 13 }}>{run.kind}</strong>
        <Muted>running {elapsed(run.claimedAt)}</Muted>
        {run.dryRun && <span className="badge badge-queued">dry run</span>}
        {onCancel && run.status === 'queued' && (
          <button className="btn btn-xs" type="button" onClick={onCancel} style={{ marginLeft: 'auto' }}>Cancel</button>
        )}
      </div>

      <div className="progress-bar" style={{ margin: '10px 0 7px' }}>
        {pct === null
          ? <div className="progress-fill progress-indeterminate" />
          : <div className="progress-fill" style={{ width: `${pct}%` }} />}
      </div>

      <Muted>
        {p.label && <>{p.phase ? `${p.phase}: ` : ''}{p.label}</>}
        {p.pagesTotal > 0 && <> · {p.page} / {p.pagesTotal}</>}
      </Muted>

      <div style={{ marginTop: 3 }}>
        {run.kind === 'harvest' && <Muted>{p.found} found · {p.new} new</Muted>}
        {run.kind === 'apply' && <Muted>{p.applied} applied · {p.skipped} skipped · {p.failed} failed</Muted>}
      </div>
    </div>
  );
}
