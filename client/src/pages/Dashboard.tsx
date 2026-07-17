import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import ReplyModal from '../components/ReplyModal';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { retryFailedApi, type Contact } from '../lib/api';
import { Skeleton, SkeletonRows } from '../components/Skeleton';

const PAGE_SIZE = 25;

const TABS = [
  ['all', 'All'], ['sent', 'Sent'], ['replied', 'Replied'],
  ['followup-due', 'Follow-up Due'], ['follow-up-sent', 'Follow-up Sent'],
  ['follow-up-replied', 'Replied after Follow-up'],
  ['closed', 'Closed'], ['no-openings', 'No Openings'], ['in-review', 'In Review'],
] as const;

type SortCol = 'name' | 'company' | 'template' | 'status' | 'approval' | 'lastSentAt' | 'repliedAt' | 'createdAt';

export default function Dashboard() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sortCol, setSortCol] = useState<SortCol>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedFu, setSelectedFu] = useState<Set<string>>(new Set());
  const [replyContactId, setReplyContactId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const silentChecking = useRef(false);

  const [loading, setLoading] = useState(!app.loaded);

  useEffect(() => {
    app.init().catch(err => setError(err.message)).finally(() => setLoading(false));
  }, []);

  const busy = loading && app.contacts.length === 0;

  // Auto mailbox check: on load if stale, every 15 min, and on tab re-focus (same as classic)
  useEffect(() => {
    if (!app.loaded || !app.sender.email) return;
    const STALE_MS = 10 * 60 * 1000;

    const silentCheck = async () => {
      if (silentChecking.current) return;
      silentChecking.current = true;
      try {
        const result = await app.checkMailbox();
        app.setSenderMailboxCheckedAt(result.lastCheckedAt ? new Date(result.lastCheckedAt) : new Date());
        const parts: string[] = [];
        if (result.bounced?.length) parts.push(`${result.bounced.length} bounce${result.bounced.length !== 1 ? 's' : ''}`);
        if (result.replied?.length) parts.push(`${result.replied.length} repl${result.replied.length !== 1 ? 'ies' : 'y'}`);
        if (parts.length) toast(`Found ${parts.join(' and ')}`, result.bounced?.length ? 'error' : 'success');
      } catch { /* silent */ }
      finally { silentChecking.current = false; }
    };

    const last = app.sender.lastMailboxCheckAt;
    let t: ReturnType<typeof setTimeout> | null = null;
    if (!last || Date.now() - last.getTime() > STALE_MS) t = setTimeout(silentCheck, 2000);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') silentCheck();
    }, 15 * 60 * 1000);

    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const l = app.sender.lastMailboxCheckAt;
      if (!l || Date.now() - l.getTime() > STALE_MS) silentCheck();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { if (t) clearTimeout(t); clearInterval(interval); document.removeEventListener('visibilitychange', onVis); };
  }, [app.loaded]);

  const stats = useMemo(() => app.getStats(), [app.contacts]);

  const sortContacts = (arr: Contact[]) => [...arr].sort((a, b) => {
    let va: any, vb: any;
    switch (sortCol) {
      case 'name': va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
      case 'company': va = (a.company || '').toLowerCase(); vb = (b.company || '').toLowerCase(); break;
      case 'template': va = (a.template || '').toLowerCase(); vb = (b.template || '').toLowerCase(); break;
      case 'status': va = (a.status || '').toLowerCase(); vb = (b.status || '').toLowerCase(); break;
      case 'approval': va = a.approvalStatus || ''; vb = b.approvalStatus || ''; break;
      case 'lastSentAt': va = new Date(a.lastSentAt || 0); vb = new Date(b.lastSentAt || 0); break;
      case 'repliedAt': va = new Date(a.repliedAt || 0); vb = new Date(b.repliedAt || 0); break;
      default: va = new Date(a.createdAt || 0); vb = new Date(b.createdAt || 0);
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const filtered = useMemo(() => {
    let list = app.filterContacts(tab);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
    if (statusFilter) list = list.filter(c => c.status === statusFilter);
    if (approvalFilter) list = list.filter(c => c.approvalStatus === approvalFilter);
    if (templateFilter) list = list.filter(c => c.template === templateFilter);
    return sortContacts(list);
  }, [app.contacts, tab, search, statusFilter, approvalFilter, templateFilter, sortCol, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const resumable = app.contacts.filter(c => c.status === 'queued' && c.approvalStatus === 'approved');
  const failedCount = app.contacts.filter(c => c.status === 'failed').length;
  const unreadCount = app.contacts.filter(c => c.status === 'replied' && !c.replyRead).length;

  const setSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortCol(col);
      setSortDir(col === 'createdAt' || col === 'repliedAt' || col === 'lastSentAt' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  const sortIcon = (col: SortCol) =>
    sortCol !== col
      ? <i className="ti ti-arrows-sort" style={{ fontSize: 10, opacity: 0.35, marginLeft: 3 }} />
      : <i className={`ti ${sortDir === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down'}`} style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 3 }} />;

  const Th = ({ label, col }: { label: string; col: SortCol }) => (
    <th onClick={() => setSort(col)} style={{ cursor: 'pointer', userSelect: 'none' }}>{label}{sortIcon(col)}</th>
  );

  const checkMailbox = async () => {
    setChecking(true);
    try {
      const result = await app.checkMailbox();
      app.setSenderMailboxCheckedAt(result.lastCheckedAt ? new Date(result.lastCheckedAt) : new Date());
      const parts: string[] = [];
      if (result.bounced?.length) parts.push(`${result.bounced.length} bounce${result.bounced.length !== 1 ? 's' : ''}: ${result.bounced.map((b: any) => b.name).join(', ')}`);
      if (result.replied?.length) parts.push(`${result.replied.length} repl${result.replied.length !== 1 ? 'ies' : 'y'}: ${result.replied.map((r: any) => r.name).join(', ')}`);
      if (parts.length === 0) toast(`Scanned ${result.scanned} message${result.scanned !== 1 ? 's' : ''} — nothing new.`, 'info');
      else toast(`Found ${parts.join(' and ')}`, result.bounced?.length ? 'error' : 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const retryFailed = async () => {
    setRetrying(true);
    try {
      const data = await retryFailedApi();
      if (data.retried === 0) { toast('No failed emails to retry.', 'info'); return; }
      toast(`${data.retried} contact${data.retried !== 1 ? 's' : ''} reset to queued.`, 'success');
      await app.loadContacts();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setRetrying(false);
    }
  };

  const lastChecked = app.sender.lastMailboxCheckAt;
  const lastCheckedLabel = !app.loaded ? 'Loading...'
    : !lastChecked ? 'Mailbox not checked yet'
    : (() => {
      const mins = Math.round((Date.now() - lastChecked.getTime()) / 60000);
      return mins < 1 ? 'Last checked: just now' : mins < 60 ? `Last checked: ${mins}m ago` : `Last checked: ${Math.round(mins / 60)}h ago`;
    })();

  const showDetail = (c: Contact) => {
    if (c.status === 'replied' || c.status === 'follow-up-replied') { setReplyContactId(c.id); return; }
    let msg = `Contact: ${c.name}\nEmail: ${c.email}\nCompany: ${c.company}\nStatus: ${c.status}`;
    if (c.status === 'bounced' && c.bounceReason) msg += `\nBounce reason: ${c.bounceReason}`;
    alert(msg);
  };

  const toggleFuRow = (id: string, checked: boolean) => {
    setSelectedFu(prev => { const n = new Set(prev); if (checked) n.add(id); else n.delete(id); return n; });
  };

  const selectLastN = (n: number) => {
    const all = sortContacts(app.filterContacts('followup-due'));
    setSelectedFu(new Set((isFinite(n) ? all.slice(0, n) : all).map(c => c.id)));
  };

  const replyContact = replyContactId ? app.contacts.find(c => c.id === replyContactId) || null : null;
  const isFuTab = tab === 'followup-due';
  const fuAllChecked = isFuTab && paged.length > 0 && paged.every(c => selectedFu.has(c.id));

  const kpis = [
    { label: 'Total contacts', value: stats.total, cls: '' },
    { label: 'Sent', value: stats.sent, cls: 'green' },
    { label: 'Bounced', value: stats.bounced, cls: 'red' },
    { label: 'Follow-up Due', value: stats.followUpDue, cls: 'amber', link: true },
    { label: 'In Review', value: stats.inReview, cls: '', style: { color: '#2563eb' } },
  ];

  return (
    <Layout title="Dashboard" subtitle={lastCheckedLabel} actions={
      <>
        {resumable.length > 0 && (
          <button className="btn btn-primary" onClick={() => navigate('/send/step3')} type="button">
            <i className="ti ti-player-play" /> Resume sending ({resumable.length})
          </button>
        )}
        {failedCount > 0 && (
          <button className="btn" onClick={retryFailed} disabled={retrying} type="button">
            <i className="ti ti-refresh" /> {retrying ? 'Resetting…' : `Retry failed (${failedCount})`}
          </button>
        )}
        <button className="btn" onClick={checkMailbox} disabled={checking} type="button">
          <i className="ti ti-mail-search" /> {checking ? 'Checking...' : 'Check for bounces & replies'}
        </button>
        <Link to="/send/step1" className="btn btn-primary"><i className="ti ti-plus" /> New entry</Link>
      </>
    } wide>
      <div className="stat-grid">
        {kpis.map(k => k.link ? (
          <a key={k.label} href="#" className="stat-card" style={{ textDecoration: 'none' }}
            onClick={e => { e.preventDefault(); setTab('followup-due'); setPage(1); }}>
            <div className="stat-label">{k.label}</div>
            {busy ? <Skeleton w="42%" h={28} style={{ marginTop: 2 }} /> : <div className={`stat-value ${k.cls}`}>{k.value}</div>}
          </a>
        ) : (
          <div key={k.label} className="stat-card">
            <div className="stat-label">{k.label}</div>
            {busy ? <Skeleton w="42%" h={28} style={{ marginTop: 2 }} /> : <div className={`stat-value ${k.cls}`} style={k.style}>{k.value}</div>}
          </div>
        ))}
      </div>

      <div className="section" style={{ flex: 1 }}>
        <div className="section-head">
          <div className="nav-tabs">
            {TABS.map(([key, label]) => (
              <div key={key} className={`nav-tab${tab === key ? ' active' : ''}`}
                onClick={() => { setTab(key); setPage(1); setSortCol('createdAt'); setSortDir('desc'); setSelectedFu(new Set()); }}>
                {key === 'replied' && unreadCount > 0 ? <>Replied <span className="tab-badge">{unreadCount}</span></> : label}
              </div>
            ))}
          </div>
          <span className="contact-count-badge">{filtered.length} contacts</span>
        </div>

        {isFuTab && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 500 }}>Quick select:</span>
            {[10, 25, 50, 100].map(n => (
              <button key={n} className="btn btn-xs" onClick={() => selectLastN(n)} type="button">Last {n}</button>
            ))}
            <button className="btn btn-xs" onClick={() => selectLastN(Infinity)} type="button">All</button>
            <button className="btn btn-xs" style={{ color: 'var(--text3)' }} onClick={() => setSelectedFu(new Set())} type="button">Clear</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <input type="text" placeholder="Search name, email or company..." value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            style={{ flex: 1, minWidth: 200, maxWidth: 320 }} />
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} style={{ width: 'auto', minWidth: 140 }}>
            <option value="">All statuses</option>
            <option value="queued">Queued</option><option value="sent">Sent</option>
            <option value="failed">Failed</option><option value="bounced">Bounced</option>
            <option value="replied">Replied</option>
          </select>
          <select value={approvalFilter} onChange={e => { setApprovalFilter(e.target.value); setPage(1); }} style={{ width: 'auto', minWidth: 140 }}>
            <option value="">All approvals</option>
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <select value={templateFilter} onChange={e => { setTemplateFilter(e.target.value); setPage(1); }} style={{ width: 'auto', minWidth: 140 }}>
            <option value="">All templates</option>
            {Object.keys(app.templates).map(key => (
              <option key={key} value={key}>{app.templates[key].name || key}</option>
            ))}
          </select>
          <button className="btn btn-sm" type="button" onClick={() => {
            setSearch(''); setStatusFilter(''); setApprovalFilter(''); setTemplateFilter(''); setPage(1);
          }}>Clear filters</button>
        </div>

        <div className="table-card">
          {tab === 'replied' ? (
            <table>
              <thead>
                <tr>
                  <Th label="Contact" col="name" /><Th label="Company" col="company" />
                  <th>Reply preview</th><Th label="Replied" col="repliedAt" /><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {busy ? <SkeletonRows rows={8} cols={6} chipCol={0} />
                : error ? <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
                : paged.length === 0 ? <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-message-off" />No replies yet</div></td></tr>
                : paged.map(c => {
                  const isNew = !c.replyRead;
                  const fmtDate = c.repliedAt
                    ? new Date(c.repliedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : '—';
                  const raw = c.replySnippet || '';
                  const snippet = raw.length > 75 ? raw.slice(0, 75) + '…' : raw;
                  return (
                    <tr key={c.id} className={isNew ? 'reply-unread-row' : ''}>
                      <td>
                        <div className="contact-chip">
                          {isNew ? <span className="reply-unread-dot" /> : <span style={{ width: 10, display: 'inline-block', flexShrink: 0 }} />}
                          <Avatar name={c.name} />
                          <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text2)' }}>{c.company || '—'}</td>
                      <td className="reply-snippet-cell">{snippet || <span style={{ color: 'var(--text3)' }}>No preview</span>}</td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text2)' }}>{fmtDate}</td>
                      <td style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={c.status} contact={c} />
                        {isNew ? <span className="badge badge-new">New</span> : null}
                      </td>
                      <td style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button className="btn btn-sm" onClick={() => setReplyContactId(c.id)} type="button"><i className="ti ti-message" /> View</button>
                        <button className="btn btn-sm" onClick={async () => {
                          if (!confirm(`Delete ${c.name} (${c.email})?\nThis will hide the contact from all views.`)) return;
                          try { await app.deleteContact(c.id); toast(`${c.name} deleted.`, 'success'); }
                          catch (err: any) { toast(err.message, 'error'); }
                        }} title="Delete contact" type="button"><i className="ti ti-trash" /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : isFuTab ? (
            <table>
              <thead>
                <tr>
                  <th className="cb-col">
                    <input type="checkbox" className="row-cb" checked={fuAllChecked}
                      ref={el => { if (el) el.indeterminate = !fuAllChecked && paged.some(c => selectedFu.has(c.id)); }}
                      onChange={e => {
                        setSelectedFu(prev => {
                          const n = new Set(prev);
                          paged.forEach(c => { if (e.target.checked) n.add(c.id); else n.delete(c.id); });
                          return n;
                        });
                      }} title="Select all" />
                  </th>
                  <Th label="Contact" col="name" /><Th label="Company" col="company" />
                  <Th label="Last Sent" col="lastSentAt" /><Th label="Status" col="status" /><th></th>
                </tr>
              </thead>
              <tbody>
                {busy ? <SkeletonRows rows={8} cols={6} chipCol={1} />
                : paged.length === 0 ? <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-check" />No follow-ups due</div></td></tr>
                : paged.map(c => {
                  const daysAgo = c.lastSentAt ? Math.floor((Date.now() - new Date(c.lastSentAt).getTime()) / 86400000) : null;
                  return (
                    <tr key={c.id}>
                      <td className="cb-col">
                        <input type="checkbox" className="row-cb" checked={selectedFu.has(c.id)}
                          onChange={e => toggleFuRow(c.id, e.target.checked)} />
                      </td>
                      <td>
                        <div className="contact-chip">
                          <Avatar name={c.name} />
                          <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text2)' }}>{c.company}</td>
                      <td style={{ color: 'var(--text2)' }}>{daysAgo === null ? '—' : `${daysAgo}d ago`}</td>
                      <td><StatusBadge status={c.status} contact={c} /></td>
                      <td style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {c.status === 'replied'
                          ? <button className="btn btn-sm" onClick={() => setReplyContactId(c.id)} type="button"><i className="ti ti-message" /> View reply</button>
                          : <button className="btn btn-sm" onClick={() => showDetail(c)} type="button">View</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <Th label="Contact" col="name" /><Th label="Company" col="company" />
                  <Th label="Template" col="template" /><Th label="Status" col="status" />
                  <Th label="Approval" col="approval" /><th></th>
                </tr>
              </thead>
              <tbody>
                {busy ? <SkeletonRows rows={8} cols={6} chipCol={0} />
                : error ? <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
                : paged.length === 0 ? <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-users" />No contacts found</div></td></tr>
                : paged.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="contact-chip">
                        <Avatar name={c.name} />
                        <div><div className="name">{c.name}</div><div className="email">{c.email}</div></div>
                      </div>
                    </td>
                    <td style={{ color: 'var(--text2)' }}>{c.company}</td>
                    <td style={{ color: 'var(--text2)' }}>{app.templates[c.template]?.name || c.template}</td>
                    <td><StatusBadge status={c.status} contact={c} /></td>
                    <td><StatusBadge status={c.approvalStatus} /></td>
                    <td style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {c.status === 'failed'
                        ? <button className="btn btn-sm btn-primary" onClick={async () => {
                            // Match classic retriggerContact: re-queue as approved (keep edits) → step3
                            try {
                              await app.updateContact(c.id, { status: 'queued', approvalStatus: 'approved' });
                              navigate('/send/step3');
                            } catch (err: any) { toast('Could not reset contact: ' + err.message, 'error'); }
                          }} type="button"><i className="ti ti-send" /> Re-send</button>
                        : c.approvalStatus === 'pending'
                          ? <Link to="/send/step2" className="btn btn-sm">Review</Link>
                          : <button className="btn btn-sm" onClick={() => showDetail(c)} type="button">View</button>}
                      <button className="btn btn-sm" onClick={async () => {
                        if (!confirm(`Delete ${c.name} (${c.email})?\nThis will hide the contact from all views.`)) return;
                        try { await app.deleteContact(c.id); toast(`${c.name} deleted.`, 'success'); }
                        catch (err: any) { toast(err.message, 'error'); }
                      }} title="Delete contact" type="button"><i className="ti ti-trash" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && (
          <div className="pagination-bar">
            <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} type="button">
              <i className="ti ti-chevron-left" /> Prev
            </button>
            <span className="page-info">Page {safePage} of {totalPages}</span>
            <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} type="button">
              Next <i className="ti ti-chevron-right" />
            </button>
          </div>
        )}
      </div>

      <div className={`bulk-bar${selectedFu.size > 0 ? ' visible' : ''}`}>
        <span className="bb-count">{selectedFu.size} selected</span>
        <button className="btn btn-send" type="button"
          onClick={() => { if (selectedFu.size) navigate(`/send/step1?followup=1&ids=${[...selectedFu].join(',')}`); }}>
          <i className="ti ti-send" /> Send Follow-ups
        </button>
      </div>

      <ReplyModal contact={replyContact} onClose={() => setReplyContactId(null)} />
    </Layout>
  );
}
