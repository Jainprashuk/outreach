import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { useSession } from '../context/SessionContext';
import {
  addSharedJobsApi, bulkNaukriJobsApi, companyStatusApi, sharedJobsApi, type SharedJob, decideNaukriJobsApi, listNaukriJobsApi, lookupCompanyApi, recruitersToDiscoverApi, updateNaukriJobApi,
  type CompanyOutreach, type NaukriApplyStatus, type NaukriJob, type NaukriJobQuery,
} from '../lib/api';
import { autoPick } from '../lib/prospects';

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

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|rediffmail|icloud|proton|protonmail|aol)\./i;
const isPersonalMail = (e: string) => FREE_MAIL.test(e);
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

// "Everyone": the jobs every sharing account's platforms found. Read-only; the only
// action is adding a job to your own list (pending, scored on your profile).
function EveryoneJobs({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<SharedJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => { const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    setError('');
    try {
      const r = await sharedJobsApi({ q: query || undefined, platform: platform || undefined, page, limit: 40 });
      setRows(r.jobs); setTotal(r.total); setPages(r.pages);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, [query, platform, page]);
  useEffect(() => { setLoading(true); setSel(new Set()); load(); }, [load]);

  const add = async (keys: string[]) => {
    setAdding(new Set(keys));
    try {
      const r = await addSharedJobsApi(keys);
      toast(r.added ? `Added ${r.added} to your jobs (Review)` : 'Already in your jobs', 'success');
      await load(); onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not add', 'error'); } finally { setAdding(new Set()); }
  };
  const addable = rows.filter(r => !r.mine).map(r => r.key);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input type="text" placeholder="Search title, company, skill…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={platform} onChange={e => { setPlatform(e.target.value); setPage(1); }} style={{ width: 'auto' }} aria-label="Platform">
          <option value="">All platforms</option>
          <option value="naukri">Naukri</option><option value="instahyre">Instahyre</option><option value="hirist">Hirist</option>
        </select>
        <Muted>{total} job{total === 1 ? '' : 's'} seen in the last 30 days · you can add them to your own list, nothing is applied for you</Muted>
      </div>
      {error && <div className="badge badge-failed" style={{ marginBottom: 10 }}>{error}</div>}
      {loading && rows.length === 0 ? <SkeletonRows rows={6} cols={4} /> : rows.length === 0 ? (
        <Empty icon="ti-world-search">{query ? 'Nothing matches that search.' : 'No jobs from other accounts yet.'}</Empty>
      ) : (
        <>
          <SelectionBar ids={addable} selected={sel} onChange={setSel}
            note={addable.length ? undefined : 'Everything shown is already in your list'}>
            <button className="btn btn-sm btn-primary" type="button" disabled={adding.size > 0}
              onClick={() => add([...sel])}>Add {sel.size} to my jobs</button>
          </SelectionBar>
          <Refreshing active={loading}>
            {rows.map(j => (
              <div key={j.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', padding: '9px 0', borderBottom: '0.5px solid var(--border)' }}>
                <input type="checkbox" disabled={!!j.mine} checked={sel.has(j.key)} style={{ marginTop: 4 }} aria-label={`Select ${j.title}`}
                  onChange={() => setSel(prev => { const n = new Set(prev); n.has(j.key) ? n.delete(j.key) : n.add(j.key); return n; })} />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <a href={j.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{j.title}</a>
                    <PlatformTag id={j.platform} />
                    {j.seenBy > 1 && <span className="badge badge-seen" title="How many accounts' harvests found it">{j.seenBy} accounts</span>}
                  </div>
                  <Muted>{[j.company, j.location,
                    j.experienceMin != null ? `${j.experienceMin}${j.experienceMax != null ? `-${j.experienceMax}` : '+'} yrs` : '',
                    j.salaryText, j.postedText].filter(Boolean).join(' · ')}</Muted>
                </div>
                {j.mine
                  ? <span className="badge badge-sent" title="It is in your jobs">In your jobs · {j.mine.applyStatus !== 'none' ? j.mine.applyStatus : j.mine.approval}</span>
                  : <button className="btn btn-xs" type="button" disabled={adding.has(j.key)} onClick={() => add([j.key])}>
                      <i className="ti ti-plus" /> Add to my jobs
                    </button>}
              </div>
            ))}
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
    </>
  );
}

export default function Jobs() {
  const toast = useToast();
  const { canSeeLibrary } = useSession();
  const [scope, setScope] = useState<'mine' | 'everyone'>('mine');
  const { findPeople, finding } = useFindPeople();
  const navigate = useNavigate();
  const [addingRec, setAddingRec] = useState<string | null>(null);

  // The recruiters the platform showed for a job → Discover people. The company's
  // domain comes from a recruiter's work address when there is one, else from the
  // same company lookup Find people uses; if neither is certain, Discover opens
  // with the name filled in so you pick the company.
  const addRecruiters = async (j: NaukriJob) => {
    setAddingRec(j.id);
    try {
      const workMail = (j.recruiters || []).map(r => r.email).find(e => e && !isPersonalMail(e));
      let domain = workMail ? workMail.split('@')[1] : '';
      let name = j.company;
      if (!domain) {
        const sure = autoPick((await lookupCompanyApi(j.company)).candidates);
        if (!sure) { navigate(`/discover?find=${encodeURIComponent(j.company)}&job=${j.id}`); return; }
        domain = sure.domain; name = sure.name || j.company;
      }
      const r = await recruitersToDiscoverApi({ jobId: j.id, domain, companyName: name });
      toast(r.added.length ? `Added ${r.added.length} recruiter${r.added.length === 1 ? '' : 's'} to Discover` : 'Already in Discover', 'success');
      navigate(`/discover?domain=${encodeURIComponent(domain)}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the recruiters', 'error');
    } finally { setAddingRec(null); }
  };

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
      {(j.recruiters || []).length > 0 && (
        <div style={{ flexBasis: '100%', paddingLeft: 44, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <i className="ti ti-user-star" style={{ color: 'var(--text2)' }} />
          <Muted>
            {j.recruiters!.slice(0, 3).map(r => [r.name, r.title, r.email].filter(Boolean).join(' · ')).join('  |  ')}
          </Muted>
          <button className="btn btn-xs" type="button" disabled={addingRec === j.id} onClick={() => addRecruiters(j)}
            title="Add them to Discover as people to review. Nothing is emailed until you move them to outreach.">
            <i className="ti ti-user-plus" /> {addingRec === j.id ? 'Adding…' : 'Add to Discover'}
          </button>
        </div>
      )}
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
      {canSeeLibrary && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }} role="group" aria-label="Whose jobs">
          <button type="button" className={`btn btn-sm${scope === 'mine' ? ' btn-primary' : ''}`} onClick={() => setScope('mine')}>
            <i className="ti ti-user" /> Mine
          </button>
          <button type="button" className={`btn btn-sm${scope === 'everyone' ? ' btn-primary' : ''}`} onClick={() => setScope('everyone')}
            title="Jobs found by every account on the platforms. You can only act on your own; add one to yours to work on it.">
            <i className="ti ti-world" /> Everyone
          </button>
        </div>
      )}
      {scope === 'everyone' && canSeeLibrary ? <EveryoneJobs onChanged={loadCounts} /> : (
        <>
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
