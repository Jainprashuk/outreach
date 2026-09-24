import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, bulkNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';
import { useToast } from '../../context/ToastContext';
import SelectionBar, { RowCheck } from './SelectionBar';

// Jobs the worker reached and backed out of.
//
// Split into sub-tabs rather than sections because the two halves are different
// problems with different owners, and one is usually an order of magnitude
// bigger than the other — 51 against 3, at the time of writing. Stacked, the
// small actionable pile is below a long scroll of things you can do nothing
// about, which is how it gets ignored.
//
//   NEEDS AN ANSWER   a screening question matched no rule, so the worker backed
//                     out rather than guessing. Add the rule and the next run
//                     applies. Yours to unblock.
//   COMPANY SITE      applies on the employer's own site, or Naukri says you
//                     already applied. No run will ever change it.
//
// Anything that lands in neither — a reason we did not anticipate — falls into
// Other rather than being hidden, so a new failure mode is visible rather than
// silently dropped.

type Tab = 'answer' | 'external' | 'other';

const isExternal = (j: NaukriJob) => /applies on the company site|already applied/i.test(j.applyNote || '');
const isQuestion = (j: NaukriJob) => /screening question/i.test(j.applyNote || '') || !!j.unknownQuestion;

export default function SkippedJobs({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [tab, setTab] = useState<Tab>('answer');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJobs((await listNaukriJobsApi({ applyStatus: 'skipped', limit: 200 })).jobs);
      setSel(new Set());
    }
    catch (e: any) { toast(e?.message || 'Could not load', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => ({
    // Classified by reason, not by `retryable`: the two agree once the server
    // has seen a job, but a row written by an older worker can still be marked
    // retryable while plainly saying "applies on the company site". Reading the
    // reason puts it in the right place regardless.
    answer: jobs.filter(j => isQuestion(j) && !isExternal(j)),
    external: jobs.filter(isExternal),
    other: jobs.filter(j => !isExternal(j) && !isQuestion(j)),
  }), [jobs]);

  const bulk = async (action: 'requeue' | 'dismiss', ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await bulkNaukriJobsApi(ids, action, action === 'dismiss' ? 'dismissed from skipped' : undefined);
      toast(action === 'requeue'
        // Honest about what requeuing a company-site job will do: the worker
        // will try, find the same button, and skip it again.
        ? `${r.updated} moved back to Waiting. Any that apply on the company site will be skipped again.`
        : `Dismissed ${r.updated}.`,
        action === 'requeue' ? 'success' : 'info');
      await load(); onChanged();
    } catch (e: any) { toast(e?.message || 'Could not update', 'error'); }
    finally { setBusy(false); }
  };

  const toggle = (id: string) => setSel(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (loading) return <Empty icon="ti-loader">Loading…</Empty>;
  if (!jobs.length) return <Empty icon="ti-player-skip-forward">Nothing has been skipped.</Empty>;

  const TABS: Array<[Tab, string, string, number]> = [
    ['answer', 'Needs an answer', 'ti-help-circle', groups.answer.length],
    ['external', 'Company site', 'ti-external-link', groups.external.length],
    ['other', 'Other', 'ti-dots', groups.other.length],
  ];

  const rows = groups[tab];

  const Row = ({ job }: { job: NaukriJob }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
      <RowCheck checked={sel.has(job.id)} onToggle={() => toggle(job.id)} />
      <div style={{ flex: 1, minWidth: 190 }}>
        <a href={job.url} target="_blank" rel="noreferrer"
           style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{job.title}</a>
        <div><Muted>{job.company}{job.location ? ` · ${job.location}` : ''}</Muted></div>
        {tab === 'answer' && (
          <Muted style={{ display: 'block' }}>
            {job.unknownQuestion
              ? <>asked: “{job.unknownQuestion}”</>
              // Older runs recorded that a question stopped them without keeping
              // the text. Say so rather than showing a blank where the question
              // should be — the next run on this job will capture it.
              : 'the question was not recorded — re-run this job to capture it'}
          </Muted>
        )}
        {tab === 'other' && job.applyNote && <Muted style={{ display: 'block' }}>{job.applyNote}</Muted>}
      </div>
    </div>
  );

  const BLURB: Record<Tab, string> = {
    answer: 'A screening question matched no rule, so the worker backed out rather than guessing. '
          + 'Add a rule in Configuration → Answers — the questions below are offered there as one-click '
          + 'additions — and the next apply run will go through.',
    external: "These apply on the employer's own site, or Naukri says you already applied. No run will "
            + 'change that, so they are never retried. Employers seen doing this are now flagged in Review '
            + 'before you approve them, and can be hidden there.',
    other: 'Skipped for a reason that is neither of the above. Worth reading — an unexpected reason is '
         + 'usually a selector that needs fixing.',
  };

  return (
    <>
      <div className="section-head">
        <div className="nav-tabs">
          {/* Clearing the selection on a tab change is not tidiness: the action
              buttons act on `sel`, and a selection made under one tab would
              otherwise still be acted on from another, where those rows are not
              even visible. */}
          {TABS.map(([key, label, icon, n]) => (
            <button key={key} type="button" onClick={() => { setTab(key); setSel(new Set()); }}
              className={`nav-tab${tab === key ? ' active' : ''}`}>
              <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
              {n > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{n}</span>}
            </button>
          ))}
        </div>
      </div>

      <Card
        title={`${rows.length} ${tab === 'answer' ? 'waiting on an answer' : tab === 'external' ? "the worker can't apply to" : 'other'}`}
        icon={tab === 'answer' ? 'ti-help-circle' : tab === 'external' ? 'ti-external-link' : 'ti-dots'}
      >
        <Hint style={{ marginTop: 0, marginBottom: 10 }}>{BLURB[tab]}</Hint>
        {rows.length === 0 ? <Muted>Nothing here.</Muted> : (
          <>
            <SelectionBar
              ids={rows.map(j => j.id)} selected={sel} onChange={setSel}
              note="tick rows to put them back in the queue, or drop them"
            >
              <button className="btn btn-xs btn-primary" type="button" disabled={busy}
                      onClick={() => bulk('requeue', [...sel])}>
                <i className="ti ti-rotate" /> Move to waiting
              </button>
              <button className="btn btn-xs" type="button" disabled={busy}
                      onClick={() => bulk('dismiss', [...sel])}>
                <i className="ti ti-trash" /> Dismiss
              </button>
            </SelectionBar>
            {rows.map(j => <Row key={j.id} job={j} />)}
          </>
        )}
      </Card>
    </>
  );
}
