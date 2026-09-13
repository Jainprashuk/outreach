import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { loadActivityLogsApi, type ActivityLog } from '../lib/api';

export default function Logs() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState('');
  const load = () => loadActivityLogsApi().then(setLogs).catch(e => setError(e.message));
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, []);
  return <Layout title="Logs" subtitle="Live record of meaningful Outreach activity">
    {error && <div className="info-box" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}><i className="ti ti-alert-triangle" />{error}</div>}
    <div className="info-box" style={{ marginBottom: 14 }}><i className="ti ti-refresh" />Updates automatically every 3 seconds. Reads, searches, and filters are not logged.</div>
    <div className="table-card"><table><thead><tr><th>Time</th><th>Area</th><th>Action</th><th>Details</th></tr></thead><tbody>
      {logs.length === 0 ? <tr><td colSpan={4}><div className="empty-state"><i className="ti ti-notes" />No meaningful actions logged yet</div></td></tr> : logs.map(log => <tr key={log.id}><td style={{ whiteSpace: 'nowrap', color: 'var(--text2)' }}>{new Date(log.createdAt).toLocaleString()}</td><td><span className="badge badge-queued">{log.category}</span></td><td style={{ color: 'var(--text2)' }}>{log.action.replace(/_/g, ' ')}</td><td>{log.message}</td></tr>)}
    </tbody></table></div>
  </Layout>;
}
