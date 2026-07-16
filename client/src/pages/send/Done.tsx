import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import { useToast } from '../../context/ToastContext';
import { API_BASE, retryFailedApi } from '../../lib/api';

export default function Done() {
  const toast = useToast();
  const [params] = useSearchParams();
  const jobId = params.get('jobId');

  const [batchSent, setBatchSent] = useState(0);
  const [batchFailed, setBatchFailed] = useState(0);
  const [totalEverSent, setTotalEverSent] = useState(0);
  const [pendingApproval, setPendingApproval] = useState(0);
  const [retryHidden, setRetryHidden] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    (async () => {
      const jobUrl = jobId ? `${API_BASE}/api/jobs/${jobId}` : `${API_BASE}/api/jobs/latest`;
      try {
        const [jobRes, statsRes] = await Promise.all([
          fetch(jobUrl),
          fetch(`${API_BASE}/api/contacts/stats`),
        ]);
        if (jobRes.ok) {
          const job = await jobRes.json();
          setBatchSent(job.items.filter((i: any) => i.status === 'sent').length);
          setBatchFailed(job.items.filter((i: any) => i.status === 'failed').length);
        }
        if (statsRes.ok) {
          const s = await statsRes.json();
          setTotalEverSent(s.sent || 0);
          setPendingApproval(s.pending || 0);
        }
      } catch { /* show zeros */ }
    })();
  }, [jobId]);

  const retryFailed = async () => {
    setRetrying(true);
    try {
      const data = await retryFailedApi();
      if (data.retried === 0) { toast('No failed emails to retry.', 'info'); return; }
      toast(`${data.retried} contact${data.retried !== 1 ? 's' : ''} reset to queued.`, 'success');
      setRetryHidden(true);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setRetrying(false);
    }
  };

  const subParts = [`${batchSent} email${batchSent !== 1 ? 's' : ''} delivered.`];
  if (batchFailed > 0) subParts.push(`${batchFailed} failed to send.`);
  if (pendingApproval > 0) subParts.push(`${pendingApproval} contact${pendingApproval > 1 ? 's are' : ' is'} still pending approval.`);

  return (
    <Layout title="All done!" actions={
      <Link to="/" className="btn btn-sm"><i className="ti ti-layout-dashboard" /> Dashboard</Link>
    } wide>
      <div className="success-screen">
        <div className="success-icon"><i className="ti ti-circle-check" /></div>
        <div className="success-title">
          {batchFailed > 0 ? `${batchSent} sent, ${batchFailed} failed` : `${batchSent} email${batchSent !== 1 ? 's' : ''} sent!`}
        </div>
        <div className="success-sub">{subParts.join(' ')}</div>

        <div className="stat-grid" style={{ maxWidth: 480, margin: '0 auto 28px' }}>
          <div className="stat-card"><div className="stat-label">Sent this batch</div><div className="stat-value green">{batchSent}</div></div>
          {batchFailed > 0 && <div className="stat-card"><div className="stat-label">Failed</div><div className="stat-value" style={{ color: 'var(--red)' }}>{batchFailed}</div></div>}
          {pendingApproval > 0 && <div className="stat-card"><div className="stat-label">Pending approval</div><div className="stat-value amber">{pendingApproval}</div></div>}
          <div className="stat-card"><div className="stat-label">Total ever sent</div><div className="stat-value">{totalEverSent}</div></div>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {batchFailed > 0 && !retryHidden && (
            <button className="btn btn-primary" onClick={retryFailed} disabled={retrying} type="button">
              <i className="ti ti-refresh" /> {retrying ? 'Resetting…' : `Retry ${batchFailed} failed email${batchFailed !== 1 ? 's' : ''}`}
            </button>
          )}
          <Link to="/send/step1" className="btn"><i className="ti ti-plus" /> Add more contacts</Link>
          {pendingApproval > 0 && <Link to="/send/step2" className="btn"><i className="ti ti-clock" /> Review pending</Link>}
          <Link to="/" className="btn"><i className="ti ti-layout-dashboard" /> Back to dashboard</Link>
        </div>
      </div>
    </Layout>
  );
}
