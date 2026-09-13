import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout';
import { loadActivityLogsApi, type ActivityLog } from '../lib/api';

export default function Logs() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [feature, setFeature] = useState<'all' | 'campaign' | 'outreach' | 'leads' | 'interviews' | 'postings'>('all');
  const [eventType, setEventType] = useState<'all' | 'email' | 'changes' | 'failures'>('all');
  const load = () => loadActivityLogsApi().then(setLogs).catch(e => setError(e.message));
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, []);
  const filtered = useMemo(() => logs.filter(log => {
    const outreach = ['contacts', 'templates', 'settings', 'jobs', 'email'];
    if (feature === 'outreach' && !outreach.includes(log.category)) return false;
    if (feature !== 'all' && feature !== 'outreach' && log.category !== feature) return false;
    if (eventType === 'email' && log.category !== 'email') return false;
    if (eventType === 'failures' && log.action !== 'failed') return false;
    if (eventType === 'changes' && !['post', 'put', 'patch', 'delete', 'run_started', 'run_finished'].includes(log.action)) return false;
    return true;
  }), [logs, feature, eventType]);
  return <Layout title="Logs" subtitle="Live record of meaningful Outreach activity">
    {error && <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}><i className="ti ti-alert-triangle" />{error}</div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <button className={`btn btn-sm${filtersOpen ? ' btn-primary' : ''}`} type="button" onClick={() => setFiltersOpen(open => !open)}><i className="ti ti-filter" /> Filters</button>
      <span className="contact-count-badge">{filtered.length} entries</span>
    </div>
    {filtersOpen && <div className="info-box" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
      <label><div style={{ fontSize: 12, marginBottom: 4 }}>Feature</div><select value={feature} onChange={e => setFeature(e.target.value as typeof feature)}><option value="all">All features</option><option value="campaign">Campaigns</option><option value="outreach">Outreach</option><option value="leads">Leads</option><option value="interviews">Interviews</option><option value="postings">Job postings</option></select></label>
      <label><div style={{ fontSize: 12, marginBottom: 4 }}>Event</div><select value={eventType} onChange={e => setEventType(e.target.value as typeof eventType)}><option value="all">All events</option><option value="email">Mail sent / failed</option><option value="changes">Creates, edits, deletes</option><option value="failures">Failures only</option></select></label>
      <button className="btn btn-sm" type="button" onClick={() => { setFeature('all'); setEventType('all'); }}>Clear filters</button>
    </div>}
    <div className="info-box" style={{ marginBottom: 14 }}><i className="ti ti-refresh" />Updates automatically every 3 seconds. Reads, searches, and filters are not logged.</div>
    <div className="table-card"><table><thead><tr><th>Time</th><th>Area</th><th>Action</th><th>Details</th></tr></thead><tbody>
      {filtered.length === 0 ? <tr><td colSpan={4}><div className="empty-state"><i className="ti ti-notes" />No matching log entries</div></td></tr> : filtered.map(log => <tr key={log.id}><td style={{ whiteSpace: 'nowrap', color: 'var(--text2)' }}>{new Date(log.createdAt).toLocaleString()}</td><td><span className="badge badge-queued">{log.category}</span></td><td style={{ color: 'var(--text2)' }}>{log.action.replace(/_/g, ' ')}</td><td>{log.message}</td></tr>)}
    </tbody></table></div>
  </Layout>;
}
