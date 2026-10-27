import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import MoveToInterviewModal, { type InterviewSeed } from '../components/MoveToInterviewModal';
import { FitBadge } from '../components/naukri/ReviewQueue';
import SelectionBar from '../components/naukri/SelectionBar';
import { Empty, Muted } from '../components/naukri/ui';
import { DupBadge, PlatformTag } from '../components/naukri/platform';
import { useFindPeople } from '../components/naukri/useFindPeople';
import { SkeletonRows } from '../components/Skeleton';
import { RefreshBar, Refreshing } from '../components/RefreshBar';
import { useToast } from '../context/ToastContext';
import {
  bulkNaukriJobsApi, companyStatusApi, decideNaukriJobsApi, listNaukriJobsApi, updateNaukriJobApi,
  type CompanyOutreach, type NaukriApplyStatus, type NaukriJob, type NaukriJobQuery,
} from '../lib/api';

// Every role from every job platform in one pipeline, with where each company
// stands in your outreach. Job Platforms stays the place for workers and setup;
// this is where you decide on jobs and reach the people behind them.
//
// Reads /api/p/all/jobs (explicit platform, so it does not depend on the
// URL-scoped default the Job Platforms page uses).

type Stage = 'review' | 'queued' | 'applied' | 'interviewing' | 'skipped';

const STAGES: { key: Stage; label: string; icon: string; tip: string; query: NaukriJobQuery }[] = [
  { key: 'review', label: 'Review', icon: 'ti-inbox', tip: 'New jobs waiting for your yes or no',
    query: { approval: 'pending', sort: 'score' } },
  { key: 'queued', label: 'Queued', icon: 'ti-clock', tip: 'Approved, going out on the next apply run',
    query: { bucket: 'waiting', sort: 'queue' } },
  { key: 'applied', label: 'Applied', icon: 'ti-send', tip: 'Applications that went out, and how they are going',
    query: { applyStatus: 'sent', sort: 'newest' } },
  { key: 'interviewing', label: 'Interviewing', icon: 'ti-calendar-event', tip: 'Jobs you marked as interviewing',
    query: { applyStatus: 'interviewing', sort: 'newest' } },
  { key: 'skipped', label: 'Skipped', icon: 'ti-player-skip-forward', tip: 'Set aside or could not be applied to',
    query: { bucket: 'skipped', sort: 'newest' } },
];

const PAGE = 40;
const FUNNEL: NaukriApplyStatus[] = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];

const sameName = (s: string) => s.trim().toLowerCase();

function OutreachChip({ company, st, finding, onFind }: {
  company: string; st?: CompanyOutreach; finding: boolean; onFind: () => void;
}) {
  if (!company) return null;
  if (st && st.contacts > 0) {
    return (
      <Link to={`/companies?q=${encodeURIComponent(company)}`} className="badge badge-sent"
        title="Your contacts at this company" style={{ textDecoration: 'none' }}>
        <i className="ti ti-users" style={{ marginRight: 4 }} />
        {st.contacts} {st.contacts === 1 ? 'person' : 'people'} · {st.sent} emailed{st.replied ? ` · ${st.replied} replied` : ''}
      </Link>
    );
  }
  return (
    <button className="btn btn-xs" type="button" disabled={finding} onClick={onFind}
      title="Find recruiters and the hiring manager at this company">
      <i className="ti ti-user-search" /> {finding ? 'Finding…' : 'Find people'}
    </button>
  );
}

export default function Jobs() {
  const toast = useToast();
  const { findPeople, finding } = useFindPeople();

  const [stage, setStage] = useState<Stage>('review');
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<Stage, number>>>({});
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [grouped, setGrouped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outreach, setOutreach] = useState<Record<string, CompanyOutreach>>({});
  const [interviewSeed, setInterviewSeed] = useState<{ seed: InterviewSeed; job: NaukriJob } | null>(null);

  // Debounce the search box.
  useEffect(() => { const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const def = STAGES.find(s => s.key === stage)!;

  const loadCounts = useCallback(async () => {
    try {
      const rows = await Promise.all(STAGES.map(s =>
        listNaukriJobsApi({ ...s.query, limit: 1 }, 'all').then(r => [s.key, r.total] as const)));
      setCounts(Object.fromEntries(rows));
    } catch { /* counts are decoration; the list reports real errors */ }
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await listNaukriJobsApi({ ...def.query, q: query || undefined, page, limit: PAGE }, 'all');
      setJobs(r.jobs);
      setTotal(r.total);
      const names = [...new Set(r.jobs.map(j => j.company).filter(Boolean))];
      if (names.length) companyStatusApi(names).then(o => setOutreach(o.companies)).catch(() => setOutreach({}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [def, query, page]);

  useEffect(() => { setLoading(true); setSelected(new Set()); load(); }, [load]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { setPage(1); }, [stage]);

  const refresh = async () => { await Promise.all([load(), loadCounts()]); };

  const act = async (fn: () => Promise<{ updated?: number; run?: unknown } | unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'success');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', 'error');
    } finally { setBusy(false); }
  };

  const ids = jobs.map(j => j.id);
  const sel = [...selected];
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const find = (j: NaukriJob) => findPeople({ id: j.id, company: j.company });
  const status = (c: string) => outreach[c];

  const groups = useMemo(() => {
    const m = new Map<string, NaukriJob[]>();
    for (const j of jobs) {
      const k = sameName(j.company) || '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(j);
    }
    return [...m.values()];
  }, [jobs]);

  const stageActions = (j: NaukriJob) => {
    if (stage === 'review') return (
      <>
        <button className="btn btn-xs btn-primary" type="button" disabled={busy}
          onClick={() => act(() => decideNaukriJobsApi([j.id], 'approved'), 'Approved — queued to apply')}>Approve</button>
        <button className="btn btn-xs" type="button" disabled={busy}
          onClick={() => act(() => decideNaukriJobsApi([j.id], 'rejected'), 'Rejected')}>Reject</button>
      </>
    );
    if (stage === 'queued') return (
      <>
        <button className="btn btn-xs" type="button" disabled={busy}
          onClick={() => act(() => bulkNaukriJobsApi([j.id], 'apply-next'), 'Will go out first on the next run')}>Apply next</button>
        <button className="btn btn-xs" type="button" disabled={busy}
          onClick={() => act(() => bulkNaukriJobsApi([j.id], 'skip'), 'Skipped')}>Skip</button>
      </>
    );
    if (stage === 'skipped') return (
      <button className="btn btn-xs" type="button" disabled={busy}
        onClick={() => act(() => bulkNaukriJobsApi([j.id], 'requeue'), 'Put back in the queue')}>Requeue</button>
    );
    // applied / interviewing: move through the funnel, or hand over to Interviews
    return (
      <>
        <select value={j.applyStatus} disabled={busy} style={{ width: 'auto', fontSize: 12 }} aria-label="Application status"
          onChange={e => act(() => updateNaukriJobApi(j.id, { applyStatus: e.target.value as NaukriApplyStatus }), 'Status updated')}>
          {FUNNEL.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn btn-xs" type="button"
          onClick={() => setInterviewSeed({ seed: { sourceType: 'manual', name: '', company: j.company, role: j.title }, job: j })}>
          <i className="ti ti-calendar-event" /> Move to interview
        </button>
      </>
    );
  };

  const row = (j: NaukriJob, showCompany: boolean) => (
    <div key={j.id} style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
      padding: '9px 0', borderBottom: '0.5px solid var(--border)',
    }}>
      <input type="checkbox" checked={selected.has(j.id)} style={{ marginTop: 4 }} aria-label={`Select ${j.title}`}
        onChange={() => setSelected(prev => { const n = new Set(prev); n.has(j.id) ? n.delete(j.id) : n.add(j.id); return n; })} />
      <div style={{ width: 34, flexShrink: 0, paddingTop: 1 }}><FitBadge job={j} /></div>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <a href={j.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{j.title}</a>
          <PlatformTag id={j.platform} />
          <DupBadge dup={j.dup} />
        </div>
        <Muted>
          {showCompany && j.company ? <>{j.company} · </> : null}
          {[j.location, j.experienceMin != null ? `${j.experienceMin}${j.experienceMax != null ? `-${j.experienceMax}` : '+'} yrs` : '', j.salaryText, j.postedText]
            .filter(Boolean).join(' · ')}
        </Muted>
      </div>
      {showCompany && <OutreachChip company={j.company} st={status(j.company)} finding={finding === j.id} onFind={() => find(j)} />}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{stageActions(j)}</div>
    </div>
  );

  const bulk = (
    <>
      {stage === 'review' && <>
        <button className="btn btn-sm btn-primary" type="button" disabled={busy}
          onClick={() => act(() => decideNaukriJobsApi(sel, 'approved'), `Approved ${sel.length}`)}>Approve</button>
        <button className="btn btn-sm" type="button" disabled={busy}
          onClick={() => act(() => decideNaukriJobsApi(sel, 'rejected'), `Rejected ${sel.length}`)}>Reject</button>
      </>}
      {stage === 'queued' && <button className="btn btn-sm" type="button" disabled={busy}
        onClick={() => act(() => bulkNaukriJobsApi(sel, 'skip'), `Skipped ${sel.length}`)}>Skip</button>}
      {stage === 'skipped' && <button className="btn btn-sm" type="button" disabled={busy}
        onClick={() => act(() => bulkNaukriJobsApi(sel, 'requeue'), `Requeued ${sel.length}`)}>Requeue</button>}
    </>
  );

  const needsYou = counts.review ?? 0;

  return (
    <Layout
      title="Jobs"
      subtitle={`${needsYou} to review · ${counts.queued ?? 0} queued · ${counts.applied ?? 0} applied. Workers and setup are in Job Platforms.`}
      actions={<Link className="btn btn-sm" to="/job-platforms"><i className="ti ti-briefcase-2" /> Job Platforms</Link>}
    >
      <div className="nav-tabs" style={{ marginBottom: 12 }}>
        {STAGES.map(s => (
          <button key={s.key} type="button" className={`nav-tab${stage === s.key ? ' active' : ''}`}
            title={s.tip} onClick={() => setStage(s.key)}>
            <i className={`ti ${s.icon}`} style={{ marginRight: 5 }} />{s.label}
            <span className="contact-count-badge" style={{ marginLeft: 6 }}>{counts[s.key] ?? '…'}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input type="text" placeholder="Search title, company, skill…" value={q}
          onChange={e => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} />
          Group by company
        </label>
        <Muted>{total} job{total === 1 ? '' : 's'}</Muted>
      </div>

      {error && <div className="badge badge-failed" style={{ marginBottom: 10 }}>{error}</div>}

      {loading && jobs.length === 0 ? <SkeletonRows rows={6} cols={4} /> : jobs.length === 0 ? (
        <Empty icon={def.icon}>
          {query ? 'Nothing matches that search.' : stage === 'review'
            ? 'Nothing to review. New jobs appear here after a harvest on Job Platforms.'
            : `No jobs in ${def.label.toLowerCase()} right now.`}
        </Empty>
      ) : (
        <>
          <RefreshBar active={loading} />
          <SelectionBar ids={ids} selected={selected} onChange={setSelected}>{bulk}</SelectionBar>
          <Refreshing active={loading}>
            {grouped ? groups.map(g => (
              <div key={g[0].company || g[0].id} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <strong style={{ fontSize: 14 }}>{g[0].company || 'Unknown company'}</strong>
                  <Muted>{g.length} role{g.length === 1 ? '' : 's'}</Muted>
                  <OutreachChip company={g[0].company} st={status(g[0].company)} finding={finding === g[0].id} onFind={() => find(g[0])} />
                </div>
                {g.map(j => row(j, false))}
              </div>
            )) : jobs.map(j => row(j, true))}
          </Refreshing>
          {pages > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
              <button className="btn btn-sm" type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
              <Muted>Page {page} of {pages}</Muted>
              <button className="btn btn-sm" type="button" disabled={page === pages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {interviewSeed && (
        <MoveToInterviewModal
          seed={interviewSeed.seed}
          onClose={() => setInterviewSeed(null)}
          onCreated={() => {
            const j = interviewSeed.job;
            setInterviewSeed(null);
            if (j.applyStatus !== 'interviewing') {
              act(() => updateNaukriJobApi(j.id, { applyStatus: 'interviewing' }), 'Marked interviewing');
            }
          }}
        />
      )}
    </Layout>
  );
}
