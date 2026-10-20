import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshBar, Refreshing } from '../RefreshBar';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, decideNaukriJobsApi, bulkNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';
import JobFilters, { EMPTY, toQuery, activeCount, type Draft } from './JobFilters';
import HoverCard from '../HoverCard';
import { useToast } from '../../context/ToastContext';
import { usePlatform, PlatformTag, DupBadge, DupConfirm, PLATFORM_LABEL } from './platform';

// A copy on another platform that is already applied to or approved: approving
// this one too would send the employer a second application.
const blocksApprove = (j: NaukriJob) => !!j.dup && (j.dup.state === 'applied' || j.dup.state === 'approved');

// The inbox — new listings waiting for a yes or no.
//
// Best match first: every job carries a 0–100 fit score (lib/naukriScore.js)
// with its reasons on hover, so the top of the list is the part worth reading.
// Each row has its own Approve / Reject, and the keyboard does the same
// (j/k to move, a to approve, r to reject, x to tick) — a daily skim of forty
// jobs should not take forty checkbox-then-button round trips.
//
// Approving is still the authorisation: it moves the job to Waiting and queues
// an apply run. Jobs that auto-approve (Configuration → Apply) never come
// through here — they go straight to Waiting and out on the schedule.

const PAGE = 50;

const ageTone = (s: string) =>
  /hour|today|just now/i.test(s) ? 'var(--green)' : 'var(--text2)';

export function FitBadge({ job }: { job: Pick<NaukriJob, 'score' | 'scoreReasons'> }) {
  if (job.score == null) return null;
  const cls = job.score >= 75 ? 'badge-approved' : job.score >= 50 ? 'badge-queued' : 'badge-seen';
  return (
    <HoverCard align="left" width={300}
      trigger={<span className={`badge ${cls}`} style={{ fontWeight: 600, minWidth: 30, justifyContent: 'center' }}>{job.score}</span>}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Fit {job.score}/100</div>
      {(job.scoreReasons || []).length
        ? <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text2)' }}>{job.scoreReasons!.map((r, i) => <li key={i}>{r}</li>)}</ul>
        : <div style={{ color: 'var(--text2)' }}>Nothing stood out either way.</div>}
      <div style={{ marginTop: 6, color: 'var(--text3)' }}>From your searches, skills, experience and expected pay in Configuration.</div>
    </HoverCard>
  );
}

function Row({ job, selected, focused, busy, onToggle, onDecide, onFocus, onRestore }: {
  job: NaukriJob; selected: boolean; focused: boolean; busy: boolean;
  onToggle: () => void; onDecide: (d: 'approved' | 'rejected') => void; onFocus: () => void;
  /** Set when listing tidied jobs: the row offers Restore instead of a decision. */
  onRestore?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { id: scope } = usePlatform();
  const site = PLATFORM_LABEL[job.platform || 'naukri'];
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'nearest' }); }, [focused]);
  const exp = job.experienceMin != null
    ? `${job.experienceMin}${job.experienceMax != null ? `-${job.experienceMax}` : '+'} yrs`
    : '';

  return (
    <div ref={ref} onClick={onFocus} style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '9px 8px', margin: '0 -8px', borderBottom: '1px solid var(--border)',
      background: focused ? 'var(--bg2)' : 'transparent', borderRadius: focused ? 'var(--radius)' : 0,
    }}>
      <input type="checkbox" checked={selected} onChange={onToggle} style={{ marginTop: 4 }} aria-label={`Select ${job.title}`} />
      <div style={{ width: 34, flexShrink: 0, paddingTop: 1 }}><FitBadge job={job} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <a href={job.url} target="_blank" rel="noreferrer"
             style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
            {job.title}
          </a>
          <span style={{ color: 'var(--text2)', fontSize: 12 }}>{job.company}</span>
          {scope === 'all' && <PlatformTag id={job.platform} />}
          {job.origins?.includes('recruiter') && (
            <span className="badge badge-approved" title={`A recruiter on ${site} reached out about this one`} style={{ fontSize: 10.5 }}>
              <i className="ti ti-user-check" style={{ marginRight: 3 }} />Recruiter
            </span>
          )}
          {job.origins?.includes('recommended') && (
            <span className="badge badge-seen" title={job.origins.includes('search')
              ? `Found by your searches and recommended by ${site}`
              : `From ${site}’s recommended jobs for your profile`} style={{ fontSize: 10.5 }}>
              <i className="ti ti-star" style={{ marginRight: 3 }} />Recommended
            </span>
          )}
        </div>
        {job.dup && <div><DupBadge dup={job.dup} /></div>}
        <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {exp && <span>{exp}</span>}
          {job.location && <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.location}</span>}
          {job.salaryText && <span>{job.salaryText}</span>}
          <span style={{ color: ageTone(job.postedText) }}>{job.postedText}</span>
        </div>
        {job.likelyExternal && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
            <i className="ti ti-external-link" style={{ marginRight: 4 }} />
            likely applies on the company site — the worker will skip this
          </div>
        )}
        {job.tags.length > 0 && (
          <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 3 }}>
            {job.tags.slice(0, 6).join(' · ')}
          </div>
        )}
      </div>
      {onRestore ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {job.tidyReason && <span style={{ color: 'var(--text2)', fontSize: 11 }}>tidied: {job.tidyReason}</span>}
          <button className="btn btn-xs" type="button" disabled={busy} onClick={e => { e.stopPropagation(); onRestore(); }}>
            <i className="ti ti-arrow-back-up" /> Restore
          </button>
        </div>
      ) : (
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button className="btn btn-xs" type="button" disabled={busy} title="Reject (r)"
          onClick={e => { e.stopPropagation(); onDecide('rejected'); }}>
          <i className="ti ti-x" />
        </button>
        <button className="btn btn-xs btn-primary" type="button" disabled={busy} title="Approve (a)"
          onClick={e => { e.stopPropagation(); onDecide('approved'); }}>
          <i className="ti ti-check" /> Approve
        </button>
      </div>
      )}
    </div>
  );
}

export default function ReviewQueue({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const [typeCounts, setTypeCounts] = useState<{ all: number; external: number; native: number } | undefined>();
  const [originCounts, setOriginCounts] = useState<{ all: number; search: number; recommended: number } | undefined>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const toast = useToast();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [minScore, setMinScore] = useState(75);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  // "Show tidied": the jobs the inbox tidy cleared away, each with Restore.
  const [tidiedView, setTidiedView] = useState(false);
  // A single approve of a duplicate waits on "Approve anyway".
  const [confirmDup, setConfirmDup] = useState<NaukriJob | null>(null);
  const { label: here } = usePlatform();

  const load = useCallback(async (d: Draft, p: number) => {
    setLoading(true);
    try {
      const r = await listNaukriJobsApi(tidiedView
        ? { tidied: '1', limit: PAGE, page: p, ...toQuery(d) }
        : { approval: 'pending', limit: PAGE, page: p, ...toQuery(d) });
      // Past the last page (everything after it was decided): go back to page 1.
      if (!r.jobs.length && p > 1) { setPage(1); return; }
      setJobs(r.jobs); setTotal(r.total); setPages(Math.max(1, r.pages)); setTruncated(!!r.truncated); setTypeCounts(r.typeCounts); setOriginCounts(r.originCounts);
      // Selection is cleared whenever the visible set changes. Keeping it would
      // mean approving rows you can no longer see, which is the one mistake this
      // screen must not make possible.
      setSel(new Set());
      setFocus(0);
    } catch (e: any) { setMsg(e?.message || 'Could not load the inbox'); }
    finally { setLoading(false); }
  }, [tidiedView]);

  // Debounced, because the search box refetches on every keystroke otherwise.
  useEffect(() => {
    const t = setTimeout(() => load(draft, page), draft.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [draft, page, load]);

  const changeDraft = (d: Draft) => { setPage(1); setDraft(d); };

  const toggle = (id: string) => setSel(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const decide = useCallback(async (idsIn: string[], decision: 'approved' | 'rejected', { anyway = false } = {}) => {
    let ids = idsIn;
    let kept = 0;
    if (decision === 'approved' && !anyway) {
      const byId = new Map(jobs.map(j => [j.id, j]));
      const dupes = ids.filter(id => { const j = byId.get(id); return j && blocksApprove(j); });
      // One job: ask. Several: approve the rest, keep the duplicates for you.
      if (ids.length === 1 && dupes.length === 1) { setConfirmDup(byId.get(ids[0]) || null); return; }
      if (dupes.length) { kept = dupes.length; ids = ids.filter(id => !dupes.includes(id)); }
      if (!ids.length) { toast(`Kept ${kept} in the inbox: already applied or approved on another platform.`, 'info'); return; }
    }
    if (!ids.length) return;
    setBusy(true); setMsg('');
    try {
      // "Approve anyway": the apply-time duplicate skip must leave it alone too.
      if (anyway) await bulkNaukriJobsApi(ids, 'allow-duplicate');
      const r = await decideNaukriJobsApi(ids, decision);
      // Approving queues the apply run server-side, and that can be refused
      // (paused, blocked, one already active). Say so — the approvals are saved
      // either way, and silence would read as "nothing sent".
      const runErr = r.run && 'error' in r.run ? r.run.error : null;
      const text = decision === 'approved'
        ? runErr
          ? `Approved ${r.updated}, but the apply run did not start: ${runErr}`
          : `Approved ${r.updated} — apply run queued.`
        : `Rejected ${r.updated}.`;
      const full = kept ? `${text} Kept ${kept} in the inbox: already applied or approved on another platform.` : text;
      if (ids.length > 1 || runErr || kept) toast(full, decision === 'approved' && runErr ? 'error' : 'success');
      setMsg(full);
      // Out of the list at once, so the keyboard flow never waits on a reload.
      const gone = new Set(ids);
      const left = jobs.filter(j => !gone.has(j.id));
      setJobs(left);
      setTotal(t => Math.max(0, t - r.updated));
      setSel(s => new Set([...s].filter(id => !gone.has(id))));
      // The page emptied: fetch what comes next.
      if (!left.length) load(draft, page);
      onChanged();
    } catch (e: any) {
      const m = e?.message || 'Could not save your decision';
      toast(m, 'error'); setMsg(m);
    } finally { setBusy(false); }
  }, [onChanged, toast, jobs, load, draft, page]);

  // Keep the focus on a real row after rows leave the list.
  useEffect(() => { if (focus >= jobs.length && jobs.length) setFocus(jobs.length - 1); }, [jobs.length, focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (busy || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
      const job = jobs[focus];
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocus(f => Math.min(jobs.length - 1, f + 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocus(f => Math.max(0, f - 1)); }
      else if (e.key === 'a' && job && !tidiedView) decide([job.id], 'approved');
      else if (e.key === 'r' && job && !tidiedView) decide([job.id], 'rejected');
      else if (e.key === 'x' && job) toggle(job.id);
      else if (e.key === 'o' && job) window.open(job.url, '_blank', 'noopener');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jobs, focus, busy, decide, tidiedView]);

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await bulkNaukriJobsApi([id], 'restore');
      setJobs(js => js.filter(j => j.id !== id)); setTotal(t => Math.max(0, t - 1));
      toast('Back in the inbox — the tidy rules will leave it alone now.', 'success');
      onChanged();
    } catch (e: any) { toast(e?.message || 'Could not restore', 'error'); }
    finally { setBusy(false); }
  };

  const allSelected = jobs.length > 0 && sel.size === jobs.length;
  const filtered = activeCount(draft) > 0;
  const atOrAbove = jobs.filter(j => (j.score ?? -1) >= minScore && !j.likelyExternal && !blocksApprove(j));

  return (
    <Card>
      <JobFilters
        draft={draft} onChange={changeDraft}
        total={total} showing={jobs.length} truncated={truncated} typeCounts={typeCounts} originCounts={originCounts}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button className={`btn btn-xs${tidiedView ? ' btn-primary' : ''}`} type="button"
          onClick={() => { setPage(1); setTidiedView(v => !v); }}>
          <i className="ti ti-clear-all" /> {tidiedView ? 'Back to the inbox' : 'Show tidied'}
        </button>
        {tidiedView && <Muted>Jobs the inbox tidy cleared away (Configuration → Filters). Restore puts one back for good.</Muted>}
      </div>

      {loading && !jobs.length ? <Empty icon="ti-loader">Loading…</Empty> : <RefreshBar active={loading} />}

      {!loading && !jobs.length && (
        filtered
          ? <Empty icon="ti-search-off">No jobs match these filters. Clear them to see the rest of the inbox.</Empty>
          : <Empty icon="ti-checklist">Inbox empty. New listings land here after each harvest.</Empty>
      )}

      <Refreshing active={loading}>
      {jobs.length > 0 && (<>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox" checked={allSelected}
            onChange={() => setSel(allSelected ? new Set() : new Set(jobs.map(j => j.id)))}
          />
          Select all{filtered ? ' shown' : ''}
        </label>
        {sel.size > 0 && (<>
          <Muted>{sel.size} selected</Muted>
          <button className="btn btn-sm" type="button" onClick={() => decide([...sel], 'rejected')} disabled={busy}>Reject</button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => decide([...sel], 'approved')} disabled={busy}>Approve</button>
        </>)}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Muted>Approve all scoring ≥</Muted>
          <select value={minScore} onChange={e => setMinScore(Number(e.target.value))} style={{ width: 70 }}>
            {[90, 85, 80, 75, 70, 60, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <button className="btn btn-sm btn-primary" type="button" disabled={busy || !atOrAbove.length}
            onClick={() => decide(atOrAbove.map(j => j.id), 'approved')}
            title="Only the jobs on this page, and never predicted company-site ones or duplicates already applied to elsewhere">
            Approve {atOrAbove.length}
          </button>
        </div>
      </div>

      <Hint style={{ marginBottom: 10 }}>
        Approving sends the job to Waiting and starts an apply run. Keys: <b>j</b>/<b>k</b> move · <b>a</b> approve ·
        <b> r</b> reject · <b>x</b> tick · <b>o</b> open listing.
      </Hint>

      {msg && <div style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}

      {jobs.map((j, i) => (
        <Row key={j.id} job={j} selected={sel.has(j.id)} focused={i === focus} busy={busy}
          onToggle={() => toggle(j.id)} onDecide={d => decide([j.id], d)} onFocus={() => setFocus(i)}
          onRestore={tidiedView ? () => restore(j.id) : undefined} />
      ))}

      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 12 }}>
          <button className="btn btn-sm" type="button" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>
            <i className="ti ti-chevron-left" /> Prev
          </button>
          <Muted>Page {page} of {pages}</Muted>
          <button className="btn btn-sm" type="button" disabled={page >= pages || loading} onClick={() => setPage(p => p + 1)}>
            Next <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}
      </>)}
      </Refreshing>
      {confirmDup && (
        <DupConfirm job={confirmDup} here={confirmDup.platform ? PLATFORM_LABEL[confirmDup.platform] : here}
          onCancel={() => setConfirmDup(null)}
          onConfirm={() => { const j = confirmDup; setConfirmDup(null); decide([j.id], 'approved', { anyway: true }); }} />
      )}
    </Card>
  );
}
