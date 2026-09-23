import { useCallback, useEffect, useState } from 'react';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, decideNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';

// The approval queue — the only place in this system that authorises an
// application.
//
// Built for skimming, not for reading: one row per job, the four facts you
// actually decide on (title, company, experience band, how old), and two
// buttons. Anything that needs real reading has a link out to the listing.
// Approving is deliberately the heavier-weight action of the two.

const ageTone = (s: string) =>
  /hour|today|just now/i.test(s) ? 'var(--green)' : 'var(--text2)';

function Row({ job, selected, onToggle }: {
  job: NaukriJob; selected: boolean; onToggle: () => void;
}) {
  const exp = job.experienceMin != null
    ? `${job.experienceMin}${job.experienceMax != null ? `-${job.experienceMax}` : '+'} yrs`
    : '';

  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '9px 0', borderBottom: '1px solid var(--border)',
    }}>
      <input type="checkbox" checked={selected} onChange={onToggle} style={{ marginTop: 4 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <a href={job.url} target="_blank" rel="noreferrer"
             style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
            {job.title}
          </a>
          <span style={{ color: 'var(--text2)', fontSize: 12 }}>{job.company}</span>
        </div>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {exp && <span>{exp}</span>}
          {job.location && <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.location}</span>}
          {job.salaryText && <span>{job.salaryText}</span>}
          <span style={{ color: ageTone(job.postedText) }}>{job.postedText}</span>
        </div>
        {job.tags.length > 0 && (
          <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 3 }}>
            {job.tags.slice(0, 6).join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReviewQueue({ onChanged }: { onChanged: () => void }) {
  const [jobs, setJobs] = useState<NaukriJob[]>([]);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listNaukriJobsApi({ approval: 'pending', limit: 100 });
      setJobs(r.jobs); setTotal(r.total); setSel(new Set());
    } catch (e: any) { setMsg(e?.message || 'Could not load the queue'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSel(s => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!sel.size) return;
    setBusy(true); setMsg('');
    try {
      const r = await decideNaukriJobsApi([...sel], decision);
      // Approving queues the apply run server-side, and that can be refused
      // (paused, blocked, one already active). Say so — the approvals are saved
      // either way, and silently doing nothing would look like a bug.
      const runErr = r.run && 'error' in r.run ? r.run.error : null;
      setMsg(decision === 'approved'
        ? runErr
          ? `Approved ${r.updated}. Could not start the apply run: ${runErr}`
          : `Approved ${r.updated} — an apply run is queued.`
        : `Rejected ${r.updated}.`);
      await load();
      onChanged();
    } catch (e: any) { setMsg(e?.message || 'Could not save your decision'); }
    finally { setBusy(false); }
  };

  if (loading) return <Empty icon="ti-loader">Loading…</Empty>;

  if (!jobs.length) {
    return (
      <Empty icon="ti-checklist">Nothing waiting. Run a harvest to collect new listings.</Empty>
    );
  }

  const allSelected = sel.size === jobs.length;

  return (
    <Card>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox" checked={allSelected}
            onChange={() => setSel(allSelected ? new Set() : new Set(jobs.map(j => j.id)))}
          />
          Select all
        </label>
        <Muted>
          {sel.size ? `${sel.size} selected` : `${total} awaiting review`}
          {total > jobs.length && ` (showing ${jobs.length})`}
        </Muted>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => decide('rejected')} disabled={!sel.size || busy}>
            Reject
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => decide('approved')} disabled={!sel.size || busy}>
            Approve &amp; apply
          </button>
        </div>
      </div>

      <Hint style={{ marginBottom: 10 }}>
        Approving is the only thing that authorises an application. Nothing is sent until you click it.
      </Hint>

      {msg && <div style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}

      {jobs.map(j => (
        <Row key={j.id} job={j} selected={sel.has(j.id)} onToggle={() => toggle(j.id)} />
      ))}
    </Card>
  );
}
