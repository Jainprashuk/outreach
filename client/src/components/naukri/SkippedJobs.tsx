import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshBar, Refreshing } from '../RefreshBar';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, bulkNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';
import { useToast } from '../../context/ToastContext';
import SelectionBar, { RowCheck } from './SelectionBar';
import { usePlatform, PlatformTag } from './platform';
import { useFindPeople } from './useFindPeople';

// What happened, in a word, and the one thing worth doing about it.
type Why = 'company-site' | 'walk-in' | 'closed' | 'already' | 'set-aside' | 'other' | 'duplicate';
function whyOf(j: NaukriJob): Why {
  const n = (j.applyNote || '').toLowerCase();
  if (/company site/.test(n)) return 'company-site';
  if (/walk-in/.test(n)) return 'walk-in';
  if (/closed or removed|no longer takes/.test(n)) return 'closed';
  // The same role was applied to on another platform (lib/jobDupes.js).
  if (/already applied via /.test(n)) return 'duplicate';
  if (/already applied/.test(n)) return 'already';
  if (/set aside/.test(n)) return 'set-aside';
  return 'other';
}
const WHY_TEXT: Record<Why, string> = {
  'company-site': 'Applies on the company’s own site — the worker only does native applies on the job site.',
  'walk-in': 'Walk-in drive — Naukri only offers “I am interested”, which is not an application.',
  closed: 'Listing closed or removed — the site no longer takes applications for it.',
  already: 'You had already applied to this one on the site.',
  duplicate: '',
  'set-aside': 'You set this aside.',
  other: '',
};

// Jobs the worker reached and backed out of, for a reason an answer cannot fix.
// (Skips on a screening question live in their own view, Needs answer, because
// they are the ones you CAN fix — one answer unblocks all of them.)
//
//   COMPANY SITE   applies on the employer's own site. No run will change it;
//                  open it and apply there yourself if you want it.
//   OTHER          anything else — "already applied", set aside by you, or a
//                  reason we did not anticipate. Shown rather than hidden, so a
//                  new failure mode is visible.

type Tab = 'external' | 'other';

const isExternal = (j: NaukriJob) => /applies on the company site/i.test(j.applyNote || '');
const isQuestion = (j: NaukriJob) => !!j.unknownQuestion;

export default function SkippedJobs({ onChanged }: { onChanged: () => void }) {
  const { id: scope } = usePlatform();
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [tab, setTab] = useState<Tab>('external');
  const [loading, setLoading] = useState(true);
  // After the first load, reloads keep the list on screen (dimmed) instead of blanking it.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJobs((await listNaukriJobsApi({ bucket: 'skipped', limit: 200 })).jobs.filter(j => !isQuestion(j)));
      setSel(new Set());
    }
    catch (e: any) { toast(e?.message || 'Could not load', 'error'); }
    finally { setLoading(false); setLoadedOnce(true); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => ({
    // Classified by reason, not by `retryable`: the two agree once the server
    // has seen a job, but a row written by an older worker can still be marked
    // retryable while plainly saying "applies on the company site". Reading the
    // reason puts it in the right place regardless.
    external: jobs.filter(isExternal),
    other: jobs.filter(j => !isExternal(j)),
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
        : `Dismissed ${r.updated} — they leave this list for good.`,
        action === 'requeue' ? 'success' : 'info');
      await load(); onChanged();
    } catch (e: any) { toast(e?.message || 'Could not update', 'error'); }
    finally { setBusy(false); }
  };

  const { findPeople, finding } = useFindPeople();

  const toggle = (id: string) => setSel(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (loading && !loadedOnce) return <Empty icon="ti-loader">Loading…</Empty>;
  if (!jobs.length) return <Empty icon="ti-player-skip-forward">Nothing skipped here.</Empty>;

  const TABS: Array<[Tab, string, string, number]> = [
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
        <div><Muted>{job.company}{job.location ? ` · ${job.location}` : ''}</Muted>{scope === 'all' && <> <PlatformTag id={job.platform} /></>}</div>
        {whyOf(job) === 'duplicate'
          ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <span className="badge" style={{ background: 'var(--amber-bg)', color: 'var(--amber)' }}><i className="ti ti-copy" /> Duplicate</span>
              <Muted>{job.applyNote}</Muted>
            </span>
          : <Muted style={{ display: 'block' }}>{WHY_TEXT[whyOf(job)] || job.applyNote}</Muted>}
      </div>
      {/* The next step for this kind of skip — so every row says what to do. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(whyOf(job) === 'company-site' || whyOf(job) === 'walk-in') && (
          <a className="btn btn-xs" href={job.url} target="_blank" rel="noreferrer">
            <i className="ti ti-external-link" /> {whyOf(job) === 'walk-in' ? 'See the drive' : 'Apply on their site'}
          </a>
        )}
        {whyOf(job) === 'company-site' && (
          <button className="btn btn-xs btn-primary" type="button" disabled={finding !== null} onClick={() => findPeople(job)}
            title="Find the recruiter or hiring manager at this company and email them">
            {finding === job.id ? <><i className="ti ti-loader-2 tc-spin" /> Finding…</> : <><i className="ti ti-user-search" /> Find a recruiter</>}
          </button>
        )}
        {(whyOf(job) === 'set-aside' || whyOf(job) === 'other') && (
          <button className="btn btn-xs" type="button" disabled={busy} onClick={() => bulk('requeue', [job.id])}>
            <i className="ti ti-rotate" /> {whyOf(job) === 'other' ? 'Try again' : 'Move to waiting'}
          </button>
        )}
        {(whyOf(job) === 'closed' || whyOf(job) === 'already') && (
          <button className="btn btn-xs" type="button" disabled={busy} onClick={() => bulk('dismiss', [job.id])}>
            <i className="ti ti-trash" /> Dismiss
          </button>
        )}
      </div>
    </div>
  );

  const BLURB: Record<Tab, string> = {
    external: "These apply on the employer's own site. No run will change that, so they are never retried — "
            + 'open the listing and apply there if you want one. Other jobs from these employers are flagged '
            + 'in the Inbox and are not handed to the worker unless you pick them.',
    other: 'Already applied, set aside by you, or skipped for a reason we did not expect. Worth a read — an '
         + 'unexpected reason is usually a selector that needs fixing.',
  };

  return (
    <>
      <RefreshBar active={loading} />
      <Refreshing active={loading}>
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
        title={`${rows.length} ${tab === 'external' ? "the worker can't apply to" : 'other'}`}
        icon={tab === 'external' ? 'ti-external-link' : 'ti-dots'}
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
      </Refreshing>
    </>
  );
}
