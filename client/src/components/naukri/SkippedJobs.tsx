import { useCallback, useEffect, useState } from 'react';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, decideNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';
import { useToast } from '../../context/ToastContext';

// Jobs the worker reached and backed out of.
//
// Their own tab because they are neither waiting nor applied, and putting them
// in either place made that number mean two things at once. They also split
// cleanly in two, and the split is the whole point — one half needs something
// from you, the other half never will:
//
//   NEEDS AN ANSWER   a screening question matched no rule. Add the rule and the
//                     next run applies to it. This is the actionable half.
//   CANNOT SUCCEED    applies on the company site, or Naukri says you already
//                     applied. No run will ever change this; open it yourself.

export default function SkippedJobs({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try { setJobs((await listNaukriJobsApi({ applyStatus: 'skipped', limit: 200 })).jobs); }
    catch (e: any) { toast(e?.message || 'Could not load', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const dismiss = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await decideNaukriJobsApi(ids, 'rejected', 'dismissed from skipped');
      toast(`Dismissed ${ids.length}.`, 'info');
      await load(); onChanged();
    } catch (e: any) { toast(e?.message || 'Could not dismiss', 'error'); }
    finally { setBusy(false); }
  };

  if (loading) return <Empty icon="ti-loader">Loading…</Empty>;
  if (!jobs.length) return <Empty icon="ti-player-skip-forward">Nothing has been skipped.</Empty>;

  const needsAnswer = jobs.filter(j => j.retryable !== false);
  const cannot = jobs.filter(j => j.retryable === false);

  const Row = ({ job, showQuestion }: { job: NaukriJob; showQuestion?: boolean }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 190 }}>
        <a href={job.url} target="_blank" rel="noreferrer"
           style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{job.title}</a>
        <div><Muted>{job.company}{job.location ? ` · ${job.location}` : ''}</Muted></div>
        {showQuestion && job.unknownQuestion && (
          <Muted style={{ display: 'block' }}>asked: “{job.unknownQuestion}”</Muted>
        )}
      </div>
      <button className="btn btn-xs" type="button" disabled={busy} onClick={() => dismiss([job.id])}>
        Dismiss
      </button>
    </div>
  );

  return (
    <>
      {needsAnswer.length > 0 && (
        <Card title={`${needsAnswer.length} waiting on an answer`} icon="ti-help-circle">
          <Hint style={{ marginTop: 0, marginBottom: 10 }}>
            A screening question matched no rule, so the worker backed out rather than guessing.
            Add a rule in Configuration → Answers — the questions below are offered there as one-click
            additions — and the next apply run will go through.
          </Hint>
          {needsAnswer.map(j => <Row key={j.id} job={j} showQuestion />)}
        </Card>
      )}

      {cannot.length > 0 && (
        <Card
          title={`${cannot.length} the worker can't apply to`}
          icon="ti-circle-off"
          right={
            <button className="btn btn-xs" type="button" disabled={busy}
                    onClick={() => dismiss(cannot.map(j => j.id))}>
              Dismiss all
            </button>
          }
        >
          <Hint style={{ marginTop: 0, marginBottom: 10 }}>
            These apply on the company&apos;s own site, or Naukri says you already applied. No run will
            change that, so they are never retried — open them yourself if you still want them.
            Employers seen doing this are now flagged in Review before you approve them.
          </Hint>
          {cannot.map(j => <Row key={j.id} job={j} />)}
        </Card>
      )}
    </>
  );
}
