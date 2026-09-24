import { useCallback, useEffect, useState } from 'react';
import type { NaukriJob } from '../../lib/api';
import { listNaukriJobsApi, decideNaukriJobsApi } from '../../lib/api';
import { Card, Muted, Hint, Empty } from './ui';
import JobFilters, { EMPTY, toQuery, activeCount, type Draft } from './JobFilters';
import { useToast } from '../../context/ToastContext';

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
  const [truncated, setTruncated] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const toast = useToast();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: Draft) => {
    setLoading(true);
    try {
      const r = await listNaukriJobsApi({ approval: 'pending', limit: 100, ...toQuery(d) });
      setJobs(r.jobs); setTotal(r.total); setTruncated(!!r.truncated);
      // Selection is cleared whenever the visible set changes. Keeping it would
      // mean approving rows you can no longer see, which is the one mistake this
      // screen must not make possible.
      setSel(new Set());
    } catch (e: any) { setMsg(e?.message || 'Could not load the queue'); }
    finally { setLoading(false); }
  }, []);

  // Debounced, because the search box refetches on every keystroke otherwise.
  // The other controls are in the same effect so one change never fires two
  // requests.
  useEffect(() => {
    const t = setTimeout(() => load(draft), draft.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [draft, load]);

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
      // Approving is the single most consequential click on this screen, and the
      // rows simply vanish from the list afterwards — so say what happened, and
      // say it loudly when the run could NOT be queued, since the approvals are
      // saved either way and silence would read as "nothing sent".
      const text = decision === 'approved'
        ? runErr
          ? `Approved ${r.updated}, but the apply run did not start: ${runErr}`
          : `Approved ${r.updated} — apply run queued.`
        : `Rejected ${r.updated}.`;
      toast(text, decision === 'approved' && runErr ? 'error' : 'success');
      setMsg(text);
      await load(draft);
      onChanged();
    } catch (e: any) {
      const m = e?.message || 'Could not save your decision';
      toast(m, 'error'); setMsg(m);
    } finally { setBusy(false); }
  };

  const allSelected = jobs.length > 0 && sel.size === jobs.length;
  const filtered = activeCount(draft) > 0;

  return (
    <Card>
      <JobFilters
        draft={draft} onChange={setDraft}
        total={total} showing={jobs.length} truncated={truncated}
      />

      {loading && <Muted style={{ display: 'block', marginBottom: 8 }}>Loading…</Muted>}

      {!loading && !jobs.length && (
        filtered
          ? <Empty icon="ti-search-off">No jobs match these filters. Clear them to see the rest of the queue.</Empty>
          : <Empty icon="ti-checklist">Nothing waiting. Run a harvest to collect new listings.</Empty>
      )}

      {jobs.length > 0 && (<>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox" checked={allSelected}
            onChange={() => setSel(allSelected ? new Set() : new Set(jobs.map(j => j.id)))}
          />
          Select all{filtered ? ' shown' : ''}
        </label>
        {/* Counts live in the filter bar; this says only what is SELECTED, so
            the two never disagree about what "all" means under a filter. */}
        {sel.size > 0 && <Muted>{sel.size} selected</Muted>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" type="button" onClick={() => decide('rejected')} disabled={!sel.size || busy}>
            Reject
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => decide('approved')} disabled={!sel.size || busy}>
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
      </>)}
    </Card>
  );
}
