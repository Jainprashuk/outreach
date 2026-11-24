import { useEffect, useState } from 'react';
import { adminServerLogsApi } from '../lib/api';

// The VM's live container logs (Dozzle), embedded. The page sits behind its own
// Cloudflare Access login, and that login screen refuses to be framed, so the
// first visit has to happen in a real tab; after that the session cookie
// (same site, jainprashuk.in) is sent inside the frame too.
export default function AdminServerLogs() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => {
    adminServerLogsApi().then(r => setUrl(r.url)).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>;
  if (url === null) return <div className="skeleton" style={{ height: 120 }} />;
  if (!url) return <div className="info-box"><i className="ti ti-info-circle" />No logs page is set up. On the VM run <code>sudo cw logs-ui on</code>.</div>;

  return <>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      <a className="btn btn-sm" href={url} target="_blank" rel="noopener noreferrer"><i className="ti ti-external-link" /> Open in new tab</a>
      <button className="btn btn-sm" type="button" onClick={() => setFrameKey(k => k + 1)}><i className="ti ti-refresh" /> Reload</button>
      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
        Blank? Open it in a new tab once and sign in with the emailed code, then Reload. The sign-in lasts 30 days.
      </span>
    </div>
    <div className="table-card" style={{ padding: 0, overflow: 'hidden' }}>
      <iframe key={frameKey} src={url} title="Server logs" referrerPolicy="no-referrer"
        style={{ display: 'block', width: '100%', height: 'calc(100vh - 230px)', minHeight: 480, border: 0 }} />
    </div>
  </>;
}
