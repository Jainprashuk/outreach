import { useCallback, useEffect, useState } from 'react';
import type { NaukriJob, NaukriOverview } from '../../lib/api';
import { listNaukriJobsApi, decideNaukriJobsApi, queueNaukriRunApi, bulkNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty, Notice } from './ui';
import { useToast } from '../../context/ToastContext';
import SelectionBar, { RowCheck } from './SelectionBar';
import { fmtTime, fmtRunTime } from './format';

// Approved, and still waiting to be applied to.
//
// This view exists because that state was invisible. A job you approved leaves
// the review queue immediately, but only ever reaches the Applied board once a
// run picks it up — so between the two there was a set of jobs you had said yes
// to, that nothing in the UI would show you. Eighty of them, in the case that
// prompted this.
//
// The second half of the problem was "when will these run", which has a real
// answer that depends on three settings at once. Rather than make you infer it
// from the Configuration tab, this states it outright.

// What will actually cause these to be applied to, in plain terms. Ordered
// most-certain first, because the point is to end the question, not list
// possibilities.
function trigger(o: NaukriOverview): { tone: 'ok' | 'warn'; text: string } {
  if (o.paused) {
    return { tone: 'warn', text: 'Nothing will run: Naukri is paused in Configuration → Apply behaviour & safety.' };
  }
  if (o.blockedUntil) {
    return { tone: 'warn', text: `Nothing will run until ${fmtTime(o.blockedUntil)} — Naukri challenged the account.` };
  }
  if (o.schedule.enabled && o.schedule.runApply && o.nextOccurrence) {
    return { tone: 'ok', text: `These run automatically at ${fmtTime(o.nextOccurrence)}, then on your schedule.` };
  }
  if (o.schedule.enabled && !o.schedule.runApply) {
    return {
      tone: 'warn',
      text: 'These will NOT run on your schedule — "Apply" is turned off under Configuration → Schedule. '
          + 'They run when you press Apply above, or when you approve more jobs.',
    };
  }
  return {
    tone: 'warn',
    text: 'No schedule is set, so these will not run on their own. They run when you press Apply above, '
        + 'or when you approve more jobs — approving queues a run.',
  };
}

export default function QueuedJobs({ overview, onChanged }: {
  overview: NaukriOverview; onChanged: () => void;
}) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [parked, setParked] = useState<NaukriJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listNaukriJobsApi({ approval: 'approved', limit: 200 });
      // Split by whether a run can still act on them. Showing the two together
      // is what made "80 approved" look like 80 that would be applied to.
      // Skips are excluded here — they have their own tab, and mixing them made
      // this number mean two unrelated things at once.
      setJobs(r.jobs.filter(j => (j.applyStatus === 'none' || j.applyStatus === 'failed') && j.retryable !== false));
      setParked([]);
      // Cleared whenever the list reloads: acting on rows you can no longer see
      // is the one mistake this screen must not allow.
      setSel(new Set());
    } catch (e: any) { setMsg(e?.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyNow = async () => {
    setBusy(true); setMsg('');
    try {
      await queueNaukriRunApi('apply');
      // A toast, not just inline text: the button is at the top of a long list,
      // and queueing a run produces no other visible change until the worker
      // picks it up — which can be twenty seconds away. Without this the click
      // looks like it did nothing.
      const n = Math.min(jobs.length, 20);
      toast(`Apply run queued — ${n} job${n === 1 ? '' : 's'} will go out on the next worker poll.`, 'success');
      onChanged();
    } catch (e: any) {
      const m = e?.message || 'Could not start the run';
      toast(m, 'error');
      setMsg(m);
    } finally { setBusy(false); }
  };

  const bulk = async (action: 'apply-next' | 'skip', ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await bulkNaukriJobsApi(ids, action);
      if (action === 'apply-next') {
        const runErr = r.run && 'error' in r.run ? r.run.error : null;
        toast(runErr
          ? `Queued ${r.updated} to go first, but the run did not start: ${runErr}`
          : `${r.updated} will be applied to on the next run, ahead of the rest.`,
          runErr ? 'error' : 'success');
      } else {
        toast(`${r.updated} moved to Skipped — they will not be applied to.`, 'info');
      }
      await load(); onChanged();
    } catch (e: any) { toast(e?.message || 'Could not update', 'error'); }
    finally { setBusy(false); }
  };

  const toggle = (id: string) => setSel(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const unapprove = async (id: string) => {
    setBusy(true);
    try {
      await decideNaukriJobsApi([id], 'pending');
      toast('Moved back to Review.', 'info');
      await load(); onChanged();
    } catch (e: any) {
      const m = e?.message || 'Could not un-approve';
      toast(m, 'error'); setMsg(m);
    } finally { setBusy(false); }
  };

  if (loading) return <Empty icon="ti-loader">Loading…</Empty>;

  const t = trigger(overview);
  const perRun = overview.appliedToday >= 0 ? 20 : 20;
  const batches = Math.ceil(jobs.length / perRun);

  return (
    <>
      <Notice tone={t.tone === 'ok' ? 'info' : 'warn'} icon={t.tone === 'ok' ? 'ti-clock' : 'ti-alert-triangle'}>
        {t.text}
      </Notice>

      {jobs.length === 0 ? (
        <Empty icon="ti-inbox">
          Nothing approved and waiting. Approve jobs in Review to queue them.
        </Empty>
      ) : (
        <Card
          title={`${jobs.length} waiting`}
          icon="ti-hourglass"
          right={
            <button className="btn btn-xs btn-primary" type="button" onClick={applyNow} disabled={busy}>
              <i className="ti ti-send" /> Apply now
            </button>
          }
        >
          <Hint style={{ marginTop: 0, marginBottom: 10 }}>
            A run applies to at most {perRun}, so this takes {batches} run{batches === 1 ? '' : 's'} to clear.
            Roughly 6 in 14 Naukri listings apply on the company site and will be skipped — those are
            dropped from this list once seen, not retried.
          </Hint>

          {msg && <Muted style={{ display: 'block', marginBottom: 8 }}>{msg}</Muted>}

          <SelectionBar
            ids={jobs.map(j => j.id)} selected={sel} onChange={setSel}
            note="tick rows to apply to just those, or set them aside"
          >
            <button className="btn btn-xs btn-primary" type="button" disabled={busy}
                    onClick={() => bulk('apply-next', [...sel])}>
              <i className="ti ti-send" /> Apply to these
            </button>
            <button className="btn btn-xs" type="button" disabled={busy}
                    onClick={() => bulk('skip', [...sel])}>
              <i className="ti ti-player-skip-forward" /> Move to skipped
            </button>
          </SelectionBar>

          {jobs.map((job, i) => (
            <div key={job.id} style={{
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              padding: '8px 0', borderBottom: '0.5px solid var(--border)',
            }}>
              <RowCheck checked={sel.has(job.id)} onToggle={() => toggle(job.id)} />
              {/* Position matters here: it tells you which run yours lands in. */}
              <Muted style={{ width: 26, textAlign: 'right' }}>{i + 1}</Muted>
              <div style={{ flex: 1, minWidth: 190 }}>
                <a href={job.url} target="_blank" rel="noreferrer"
                   style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{job.title}</a>
                <div>
                  <Muted>
                    {job.company}
                    {job.approvedAt ? ` · approved ${fmtRunTime(job.approvedAt)}` : ''}
                    {i >= perRun ? ` · run ${Math.floor(i / perRun) + 1}` : ' · next run'}
                  </Muted>
                </div>
                {job.likelyExternal && (
                  <Muted style={{ display: 'block', color: 'var(--red)' }}>
                    likely applies on the company site — this employer has before, so it will probably be skipped
                  </Muted>
                )}
              </div>
              <button className="btn btn-xs" type="button" onClick={() => unapprove(job.id)} disabled={busy}>
                Un-approve
              </button>
            </div>
          ))}
        </Card>
      )}

    </>
  );
}
