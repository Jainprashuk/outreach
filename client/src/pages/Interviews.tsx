import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import InterviewDetailModal from '../components/InterviewDetailModal';
import MoveToInterviewModal from '../components/MoveToInterviewModal';
import { SkeletonRows } from '../components/Skeleton';
import { useInterviews } from '../context/InterviewContext';
import { interviewFileUrl, type Interview, type InterviewStatus } from '../lib/api';
import {
  daysSinceActivity, INTERVIEW_BADGE_CLASS, INTERVIEW_STATUS_LABELS, INTERVIEW_STATUS_ORDER,
  isInterviewSoon, isStale, isTerminal, MODE_ICON, MODE_LABELS, STALE_DAYS, whenLabel,
} from '../lib/interviews';

type Tab = 'all' | 'active' | 'follow-up' | 'upcoming' | 'closed';

const TAB_LABELS: Record<Tab, string> = {
  all: 'All',
  active: 'In play',
  'follow-up': 'Needs follow-up',
  upcoming: 'Upcoming',
  closed: 'Selected / Rejected',
};

const TABS: Tab[] = ['all', 'active', 'follow-up', 'upcoming', 'closed'];

const matchesTab = (iv: Interview, tab: Tab) => {
  if (tab === 'all') return true;
  if (tab === 'active') return !isTerminal(iv);
  if (tab === 'follow-up') return isStale(iv);
  if (tab === 'upcoming') return isInterviewSoon(iv) || (!!iv.interviewAt && !isTerminal(iv) && new Date(iv.interviewAt).getTime() >= Date.now());
  return isTerminal(iv);
};

export default function Interviews() {
  const store = useInterviews();
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | InterviewStatus>('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Deep link from the reminder popup: /interviews?open=<id>
  useEffect(() => {
    const open = params.get('open');
    if (!open) return;
    setDetailId(open);
    params.delete('open');
    setParams(params, { replace: true });
  }, [params, setParams]);

  const counts = useMemo(() => {
    const out = {} as Record<Tab, number>;
    TABS.forEach(t => { out[t] = store.interviews.filter(iv => matchesTab(iv, t)).length; });
    return out;
  }, [store.interviews]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.interviews.filter(iv => {
      if (!matchesTab(iv, tab)) return false;
      if (statusFilter && iv.status !== statusFilter) return false;
      if (!q) return true;
      return (iv.name + iv.email + iv.company + iv.role + iv.phone).toLowerCase().includes(q);
    });
  }, [store.interviews, tab, statusFilter, search]);

  const detail = detailId ? store.interviews.find(iv => iv.id === detailId) || null : null;
  // A stale deep link (deleted record) shouldn't leave an invisible open modal.
  useEffect(() => { if (detailId && store.loaded && !detail) setDetailId(null); }, [detailId, detail, store.loaded]);

  const busy = !store.loaded && store.interviews.length === 0;

  const docChip = (iv: Interview, kind: 'cv' | 'jd', icon: string) => {
    const file = iv[kind];
    return file ? (
      <a href={interviewFileUrl(iv.id, kind)} onClick={e => e.stopPropagation()}
        title={`${kind.toUpperCase()}: ${file.filename}`}
        style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--bg2)', color: 'var(--text2)', textDecoration: 'none' }}>
        <i className={`ti ${icon}`} /> {kind.toUpperCase()}
      </a>
    ) : null;
  };

  return (
    <Layout
      title="Interviews"
      subtitle="People who actually got back to you — tracked separately, with the original contact or lead left untouched."
      actions={
        <button className="btn btn-sm btn-primary" type="button" onClick={() => setAdding(true)}>
          <i className="ti ti-plus" /> Add manually
        </button>
      }
    >
      {store.error && (
        <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent' }}>
          <i className="ti ti-alert-triangle" /><span>{store.error}</span>
        </div>
      )}

      {counts['follow-up'] > 0 && (
        <div className="info-box" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', borderColor: 'transparent' }}>
          <i className="ti ti-clock-exclamation" />
          <span>
            <strong>{counts['follow-up']}</strong> interview{counts['follow-up'] !== 1 ? 's have' : ' has'} had no
            update in {STALE_DAYS}+ days.{' '}
            <a href="#" onClick={e => { e.preventDefault(); setTab('follow-up'); }}>Show them</a>.
          </span>
        </div>
      )}

      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(t => (
            <div key={t} className={`nav-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{counts[t]}</span>
            </div>
          ))}
        </div>
        <span className="contact-count-badge">{filtered.length} tracked</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input type="text" placeholder="Search name, email, phone, company…" value={search}
          onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180, maxWidth: 300 }} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as '' | InterviewStatus)}>
          <option value="">All statuses</option>
          {INTERVIEW_STATUS_ORDER.map(s => (
            <option key={s} value={s}>{INTERVIEW_STATUS_LABELS[s]}</option>
          ))}
        </select>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Person</th><th>Company / Role</th><th>Status</th>
              <th>Interview</th><th>Docs</th><th>Last update</th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <SkeletonRows rows={6} cols={6} chipCol={0} />
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6}><div className="empty-state">
                <i className="ti ti-user-check" />
                {store.interviews.length === 0
                  ? 'Nobody here yet — flag a contact or lead from their page when they call you back.'
                  : 'No interviews match this view'}
              </div></td></tr>
            ) : filtered.map(iv => {
              const stale = isStale(iv);
              return (
                <tr key={iv.id} onClick={() => setDetailId(iv.id)} style={{ cursor: 'pointer' }}
                  title="Click to open the full record">
                  <td>
                    <div className="contact-chip">
                      <Avatar name={iv.name} />
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{iv.name}</div>
                        <div className="email">
                          {iv.email || <span style={{ color: 'var(--text3)' }}>no email</span>}
                          {iv.phone ? <span style={{ color: 'var(--text2)' }}> · {iv.phone}</span> : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ color: 'var(--text2)' }}>
                    {iv.company || '—'}
                    {iv.role ? <div style={{ fontSize: 11, color: 'var(--text3)' }}>{iv.role}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${INTERVIEW_BADGE_CLASS[iv.status]}`}>
                      {INTERVIEW_STATUS_LABELS[iv.status]}
                    </span>
                    {iv.status === 'rejected' && iv.rejectionReason ? (
                      <div style={{ fontSize: 11, color: 'var(--text3)', maxWidth: 200, whiteSpace: 'normal' }}
                        title={iv.rejectionReason}>{iv.rejectionReason}</div>
                    ) : null}
                  </td>
                  <td style={{ color: isInterviewSoon(iv) ? 'var(--amber)' : 'var(--text2)', fontWeight: isInterviewSoon(iv) ? 600 : 400 }}>
                    {iv.interviewAt ? (
                      <>
                        <i className={`ti ${MODE_ICON[iv.mode]}`} style={{ marginRight: 4 }}
                          title={MODE_LABELS[iv.mode]} />
                        {whenLabel(iv.interviewAt)}
                        {iv.round ? <div style={{ fontSize: 11, color: 'var(--text3)' }}>{iv.round}</div> : null}
                      </>
                    ) : <span style={{ color: 'var(--text3)' }}>Not scheduled</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {docChip(iv, 'cv', 'ti-file-cv')}
                      {docChip(iv, 'jd', 'ti-file-description')}
                      {!iv.cv && !iv.jd ? <span style={{ color: 'var(--text3)' }}>—</span> : null}
                    </div>
                  </td>
                  <td style={{ color: stale ? 'var(--amber)' : 'var(--text2)', whiteSpace: 'nowrap' }}>
                    {stale && <i className="ti ti-clock-exclamation" style={{ marginRight: 4 }} />}
                    {daysSinceActivity(iv)}d ago
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detail && <InterviewDetailModal interview={detail} onClose={() => setDetailId(null)} />}
      {adding && (
        <MoveToInterviewModal
          seed={{ sourceType: 'manual', name: '' }}
          onClose={() => setAdding(false)}
          onCreated={(iv) => { setAdding(false); setDetailId(iv.id); }}
        />
      )}
    </Layout>
  );
}
