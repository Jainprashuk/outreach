import { useCallback, useEffect, useState } from 'react';
import type { NaukriJob, NaukriApplyStatus } from '../../lib/api';
import { listNaukriJobsApi, updateNaukriJobApi } from '../../lib/api';
import { Card, Muted, Empty } from './ui';
import { fmtRunTime } from './format';

// Everything that left, and where it got to.
//
// The worker only ever writes 'applied', 'skipped' or 'failed'. The rest of the
// funnel is yours to move as recruiters reply, which is why the status is a
// dropdown here rather than a badge — this table is the one place the automation
// hands control back.

const STAGES: NaukriApplyStatus[] = ['applied', 'in-review', 'interviewing', 'offer', 'rejected', 'skipped', 'failed'];

const BADGE: Partial<Record<NaukriApplyStatus, string>> = {
  applied: 'badge-sent', 'in-review': 'badge-pending', interviewing: 'badge-pending',
  offer: 'badge-sent', rejected: 'badge-rejected', skipped: 'badge-closed', failed: 'badge-rejected',
};

export default function AppliedTable({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setJobs((await listNaukriJobsApi({ applyStatus: 'any', limit: 200 })).jobs); }
    catch (e: any) { setMsg(e?.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const move = async (id: string, applyStatus: NaukriApplyStatus) => {
    try {
      await updateNaukriJobApi(id, { applyStatus });
      setJobs(j => j.map(x => (x.id === id ? { ...x, applyStatus } : x)));
      onChanged();
    } catch (e: any) { setMsg(e?.message || 'Could not update'); }
  };

  if (loading) return <Empty icon="ti-loader">Loading…</Empty>;
  if (!jobs.length) return <Empty icon="ti-send">Nothing applied yet.</Empty>;

  return (
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
            <div><Muted>{job.company}{job.appliedAt ? ` · ${fmtRunTime(job.appliedAt)}` : ''}</Muted></div>
            {/* The question that stopped it, where one did — this is the row
                that tells you which answer rule is missing. */}
            {job.unknownQuestion && <Muted style={{ display: 'block' }}>asked: “{job.unknownQuestion}”</Muted>}
          </div>
          <select value={job.applyStatus} onChange={e => move(job.id, e.target.value as NaukriApplyStatus)}
                  style={{ width: 132 }}>
            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      ))}
    </Card>
  );
}
