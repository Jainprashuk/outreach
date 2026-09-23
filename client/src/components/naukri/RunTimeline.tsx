import { useState } from 'react';
import type { NaukriRun } from '../../lib/api';
import { fmtRunTime, elapsed } from './format';

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
        <span className="page-info" style={{ minWidth: 120 }}>{fmtRunTime(run.createdAt)}</span>
        <span className="page-info" style={{ flex: 1, minWidth: 160 }}>{summary(run)}</span>
        {run.trigger === 'scheduled' && <span className="page-info">scheduled</span>}
        {hasDetail && <i className={`ti ti-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: 14, color: 'var(--text2)' }} />}
      </div>

      {open && (
        <div style={{ padding: '2px 0 12px 12px', borderLeft: '2px solid var(--border)', marginLeft: 4 }}>
          {run.error && (
            <div style={{ fontSize: 12, color: 'var(--danger, #dc2626)', whiteSpace: 'pre-wrap', marginBottom: 8 }}>
              {run.error}
            </div>
          )}
          {run.results.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 60, color: r.outcome === 'applied' ? 'var(--ok, #16a34a)' : 'var(--text2)' }}>
                {r.outcome}
              </span>
              <span style={{ minWidth: 200 }}>{r.title}{r.company ? ` · ${r.company}` : ''}</span>
              <span className="page-info" style={{ flex: 1 }}>{r.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RunTimeline({ runs }: { runs: NaukriRun[] }) {
  if (!runs.length) {
    return <div className="page-info" style={{ padding: '10px 0' }}>Nothing has run yet.</div>;
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
        <span className="page-info">running {elapsed(run.claimedAt)}</span>
        {run.dryRun && <span className="badge badge-queued">dry run</span>}
        {onCancel && run.status === 'queued' && (
          <button className="btn btn-sm" onClick={onCancel} style={{ marginLeft: 'auto' }}>Cancel</button>
        )}
      </div>

      {pct !== null && (
        <div style={{ height: 6, background: 'var(--bg2)', borderRadius: 3, margin: '10px 0 6px', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
        </div>
      )}

      <div className="page-info" style={{ fontSize: 12 }}>
        {p.label && <span>{p.phase ? `${p.phase}: ` : ''}{p.label}</span>}
        {p.pagesTotal > 0 && <span> · {p.page} / {p.pagesTotal}</span>}
      </div>

      <div className="page-info" style={{ fontSize: 12, marginTop: 2 }}>
        {run.kind === 'harvest' && <span>{p.found} found · {p.new} new</span>}
        {run.kind === 'apply' && <span>{p.applied} applied · {p.skipped} skipped · {p.failed} failed</span>}
      </div>
    </div>
  );
}
