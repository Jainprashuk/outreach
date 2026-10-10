import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshBar, Refreshing } from '../RefreshBar';
import type { NaukriJob, NaukriApplyStatus, NaukriJobOutreach } from '../../lib/api';
import { listNaukriJobsApi, updateNaukriJobApi, lookupCompanyApi, startProspectSearchApi, naukriJobsOutreachApi } from '../../lib/api';
import { autoPick } from '../../lib/prospects';
import { Card, Muted, Empty } from './ui';
import { fmtRunTime } from './format';
import { useToast } from '../../context/ToastContext';

// Everything that left, and where it got to.
//
// The worker only ever writes 'applied', 'skipped' or 'failed'. The rest of the
// funnel is yours to move as recruiters reply, which is why the status is a
// dropdown here rather than a badge — this table is the one place the automation
// hands control back.

// Only the funnel. 'skipped' and 'failed' are not stages you move a real
// application into — a job that was never sent cannot be "in review" — and
// offering them here would let you fabricate an outcome.
const STAGES: NaukriApplyStatus[] = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];

const BADGE: Partial<Record<NaukriApplyStatus, string>> = {
  applied: 'badge-sent', 'in-review': 'badge-pending', interviewing: 'badge-pending',
  offer: 'badge-sent', rejected: 'badge-rejected',
};

export default function AppliedTable({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [loading, setLoading] = useState(true);
  // After the first load, reloads keep the list on screen (dimmed) instead of blanking it.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [msg, setMsg] = useState('');
  const toast = useToast();
  const navigate = useNavigate();
  // Per job: whether people at the company were found from it, and how that went.
  const [outreach, setOutreach] = useState<Record<string, NaukriJobOutreach>>({});
  const [finding, setFinding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // 'sent', not 'any': a board called Applied must not list jobs the worker
    // skipped or failed on. Those have their own tab.
    try {
      const list = (await listNaukriJobsApi({ applyStatus: 'sent', limit: 200 })).jobs;
      setJobs(list);
      if (list.length) naukriJobsOutreachApi(list.map(j => j.id)).then(r => setOutreach(r.jobs)).catch(() => { /* badges stay hidden */ });
    }
    catch (e: any) { setMsg(e?.message || 'Could not load'); }
    finally { setLoading(false); setLoadedOnce(true); }
  }, []);

  // Find the recruiters and hiring manager at the company you applied to. Starts the
  // Discover search straight away when the company's website is certain; otherwise
  // Discover opens with the name filled in so you pick which company it is.
  const findPeople = async (job: NaukriJob) => {
    setFinding(job.id);
    try {
      const r = await lookupCompanyApi(job.company);
      const sure = autoPick(r.candidates);
      if (!sure) {
        navigate(`/discover?find=${encodeURIComponent(job.company)}&job=${job.id}`);
        return;
      }
      const s = await startProspectSearchApi({ domain: sure.domain, companyName: sure.name || job.company, naukriJobId: job.id });
      toast(s.reused ? 'Searched recently — opening those people' : `Finding people at ${sure.name || job.company}…`, 'info');
      navigate(`/discover?domain=${encodeURIComponent(s.search.domain)}`);
    } catch (e: any) {
      toast(e?.message || 'Could not start the search', 'error');
    } finally { setFinding(null); }
  };

  useEffect(() => { load(); }, [load]);

  const move = async (id: string, applyStatus: NaukriApplyStatus) => {
    try {
      await updateNaukriJobApi(id, { applyStatus });
      setJobs(j => j.map(x => (x.id === id ? { ...x, applyStatus } : x)));
      toast(`Moved to ${applyStatus}.`, 'success');
      onChanged();
    } catch (e: any) { const m = e?.message || 'Could not update'; toast(m, 'error'); setMsg(m); }
  };

  if (loading && !loadedOnce) return <Empty icon="ti-loader">Loading…</Empty>;
  if (!jobs.length) {
    return (
      <Empty icon="ti-send">
        Nothing applied yet. Jobs the worker skipped or failed on are in Waiting, not here.
      </Empty>
    );
  }

  return (
    <>
      <RefreshBar active={loading} />
      <Refreshing active={loading}>
    <Card title={`${jobs.length} application${jobs.length === 1 ? '' : 's'}`} icon="ti-send">
      {msg && <Muted style={{ display: 'block', marginBottom: 8 }}>{msg}</Muted>}
      {jobs.map(job => (
        <div key={job.id} style={{
          display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          padding: '9px 0', borderBottom: '0.5px solid var(--border)',
        }}>
          <span className={`badge ${BADGE[job.applyStatus] || 'badge-queued'}`}>{job.applyStatus}</span>
          <div style={{ flex: 1, minWidth: 190 }}>
            <a href={job.url} target="_blank" rel="noreferrer"
               style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{job.title}</a>
            <div><Muted><Link to={`/companies?q=${encodeURIComponent(job.company)}`} style={{ color: 'inherit' }}>{job.company}</Link>{job.appliedAt ? ` · ${fmtRunTime(job.appliedAt)}` : ''}</Muted></div>
            {/* How it went out — "Applied after 2 question(s)" is worth knowing
                when you are wondering whether a screening form was involved.
                The skip/retry notes that used to live here belong to Waiting;
                nothing on this board was skipped. */}
            {job.applyNote && <Muted style={{ display: 'block' }}>{job.applyNote}</Muted>}
          </div>
          {(() => {
            const o = outreach[job.id];
            if (o && o.searched) {
              return (
                <Link to={`/discover?domain=${encodeURIComponent(o.domain || '')}`} className="badge badge-sent"
                  title="People found at this company from this application">
                  <i className="ti ti-users" /> {o.people} found{o.contacts ? ` · ${o.contacts} emailed` : ''}{o.replied ? ` · ${o.replied} replied` : ''}
                </Link>
              );
            }
            return (
              <button type="button" className="btn btn-xs" disabled={finding !== null} onClick={() => findPeople(job)}
                title="Find the recruiters and hiring manager there, and email them about this application">
                {finding === job.id ? <><i className="ti ti-loader-2 tc-spin" /> Finding…</> : <><i className="ti ti-user-search" /> Find people</>}
              </button>
            );
          })()}
          <select value={job.applyStatus} onChange={e => move(job.id, e.target.value as NaukriApplyStatus)}
                  style={{ width: 132 }}>
            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      ))}
    </Card>
      </Refreshing>
    </>
  );
}
