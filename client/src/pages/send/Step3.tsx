import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import Avatar from '../../components/Avatar';
import Stepper from './Stepper';
import ModePicker, { type SendMode } from './ModePicker';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { API_BASE, type Contact, type SendJob } from '../../lib/api';
import { renderTemplate } from '../../lib/format';

export default function Step3() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const urlMode = params.get('mode') as SendMode | null;
  const filterIds = params.get('ids') ? new Set(params.get('ids')!.split(',').filter(Boolean)) : null;
  const urlRate = parseInt(params.get('rate') || '') || null;

  const [mode, setMode] = useState<SendMode | null>(urlMode);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<SendMode>('bulk');
  const [error, setError] = useState('');
  const [gmailEmail, setGmailEmail] = useState('');
  const [gmailPass, setGmailPass] = useState('');
  const [chunkSize, setChunkSize] = useState(20);
  const [dripRate, setDripRate] = useState(urlRate || 5);
  const [attachResume, setAttachResume] = useState(false);
  const [serverPreconfigured, setServerPreconfigured] = useState(false);
  const [sending, setSending] = useState(false);
  const [job, setJob] = useState<SendJob | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await app.init();
      } catch (err: any) {
        setError(err.message);
        return;
      }
      try {
        const status = await fetch(`${API_BASE}/api/status`).then(r => r.json());
        if (status.configured) setServerPreconfigured(true);
      } catch { /* not preconfigured */ }
      if (!urlMode) { setPickerOpen(true); setPickerMode('bulk'); }
    })();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Prefill saved Gmail address once settings load
  useEffect(() => {
    if (!serverPreconfigured && app.sender.email && !gmailEmail) setGmailEmail(app.sender.email);
  }, [app.sender.email, serverPreconfigured]);

  const approved = useMemo(() => app.contacts.filter(c =>
    c.status === 'queued' && c.approvalStatus === 'approved' && (!filterIds || filterIds.has(c.id)),
  ), [app.contacts]);
  const pendingCount = useMemo(() => app.contacts.filter(c =>
    c.approvalStatus === 'pending' && (!filterIds || filterIds.has(c.id)),
  ).length, [app.contacts]);

  const emailFor = (a: Contact) => {
    const { subject, body } = renderTemplate(app.templates, app.sender, a.template, a);
    return { subject: a.editedSubject || subject, body: a.editedBody || body };
  };

  const dripEstimate = () => {
    const count = approved.length;
    if (count === 0) return '';
    const totalMins = Math.round((count / dripRate) * 60);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return `At ${dripRate}/hr — ${count} contacts will be sent over ~${hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`}`;
  };

  const startSend = async () => {
    if (sending) return;

    let email = '', pass = '';
    if (serverPreconfigured) {
      email = app.sender.email;
    } else {
      email = gmailEmail.trim();
      pass = gmailPass.trim();
      if (!email || !pass) { toast('Please enter your Gmail address and app password.', 'error'); return; }
    }
    if (approved.length === 0) { toast('No approved contacts to send to. Go back and approve at least one.', 'error'); return; }

    setSending(true);

    if (!serverPreconfigured) {
      let configRes: Response;
      try {
        configRes = await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, appPassword: pass, name: app.sender.name }),
        });
      } catch {
        setSending(false);
        toast("Could not reach the backend server. Make sure it's running.", 'error');
        return;
      }
      const configData = await configRes.json();
      if (!configRes.ok) {
        setSending(false);
        toast(configData.error || 'Could not connect to Gmail. Check your email and app password.', 'error');
        return;
      }
      try { await app.saveSettings({ gmailEmail: email }); } catch { /* non-fatal */ }
    }

    const items = approved.map(a => {
      const { subject, body } = emailFor(a);
      return { contactId: a.id, to: a.email, name: a.name, subject, body };
    });

    let newJob: SendJob;
    try {
      const res = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          attachResume,
          senderEmail: email,
          senderName: app.sender.name || '',
          senderAppPassword: pass,
          sendMode: mode,
          chunkSize: mode === 'bulk' ? chunkSize : undefined,
          ratePerHour: mode === 'drip' ? dripRate : undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create job');
      newJob = await res.json();
    } catch (err: any) {
      setSending(false);
      toast(err.message, 'error');
      return;
    }

    jobIdRef.current = newJob.id;

    if (mode === 'drip') {
      toast(`Drip started — ${approved.length} emails scheduled at ${dripRate}/hr. Track progress on the dashboard.`, 'success');
      setTimeout(() => navigate('/'), 1500);
      return;
    }

    setJob(newJob);
    pollRef.current = setInterval(async () => {
      const id = jobIdRef.current;
      if (!id) return;
      try {
        const res = await fetch(`${API_BASE}/api/jobs/${id}`);
        if (!res.ok) return;
        const j: SendJob = await res.json();
        setJob(j);
        if (j.status === 'done' || j.status === 'cancelled') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setTimeout(() => navigate(`/send/done?jobId=${id}`), 1200);
        }
      } catch { /* transient */ }
    }, 2000);
  };

  const confirmPicker = () => {
    setMode(pickerMode);
    setPickerOpen(false);
  };

  const total = job?.items.length || 0;
  const done = job ? job.items.filter(i => i.status !== 'pending').length : 0;
  const sent = job ? job.items.filter(i => i.status === 'sent').length : 0;
  const failed = job ? job.items.filter(i => i.status === 'failed').length : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const progressLabel = !job ? (sending ? 'Connecting to Gmail…' : '')
    : job.status === 'done' ? (failed === 0 ? `All ${sent} emails sent!` : `${sent} sent, ${failed} failed.`)
    : job.status === 'paused' ? `Paused — ${done}/${total} processed`
    : job.status === 'cancelled' ? `Cancelled — ${done}/${total} processed`
    : done >= total ? 'Finishing up…'
    : `Sending ${done + 1} of ${total}…`;

  const modeLabel = mode === 'bulk' ? <span className="mode-indicator"><i className="ti ti-bolt" /> Bulk mode</span>
    : mode === 'drip' ? <span className="mode-indicator"><i className="ti ti-clock" /> Drip — {dripRate}/hr (~{approved.length > 0 ? (approved.length / dripRate).toFixed(1) : '—'}h)</span>
    : <span className="mode-indicator"><i className="ti ti-send" /> Sequential mode</span>;

  const backParams = new URLSearchParams();
  if (mode) backParams.set('mode', mode);
  if (filterIds) backParams.set('ids', [...filterIds].join(','));
  if (urlRate) backParams.set('rate', String(urlRate));
  const backHref = `/send/step2${backParams.toString() ? '?' + backParams.toString() : ''}`;

  return (
    <Layout title="New entry" subtitle="Step 3 of 3 — Send" actions={
      <Link to="/" className="btn btn-sm"><i className="ti ti-x" /> Cancel</Link>
    } wide>
      <Stepper current={3} />

      <div className="form-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="send-summary">
          {error ? (
            <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
          ) : app.loaded && approved.length === 0 ? (
            <div className="empty-state"><i className="ti ti-inbox" />No approved contacts to send. <Link to="/send/step2">Approve contacts first</Link>.</div>
          ) : (
            <>
              <div className="send-row"><span className="label">Approved and ready</span><span style={{ color: 'var(--green)', fontWeight: 500 }}>{approved.length} contacts</span></div>
              {pendingCount > 0 && <div className="send-row"><span className="label">Still pending approval</span><span style={{ color: 'var(--amber)' }}>{pendingCount}</span></div>}
              <div className="send-row"><span>Emails to send</span><span style={{ color: 'var(--green)', fontWeight: 600 }}>{approved.length}</span></div>
              <div className="send-row"><span className="label">Send mode</span><span>{modeLabel}</span></div>
              {mode === 'drip' && <div className="send-row" style={{ color: 'var(--text2)', fontSize: 12 }}><span /><span>Sends in the background. Track progress on the dashboard.</span></div>}
            </>
          )}
        </div>

        {!job && !serverPreconfigured && (
          <div className="gmail-card">
            <div className="gc-head">
              <i className="ti ti-brand-gmail gc-icon" />
              <div>
                <div className="gc-title">Gmail credentials</div>
                <div className="gc-sub">Used to send emails on your behalf</div>
              </div>
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Gmail address</label>
                <input type="email" placeholder="yourname@gmail.com" value={gmailEmail} onChange={e => setGmailEmail(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">App password</label>
                <input type="password" placeholder="xxxx xxxx xxxx xxxx" value={gmailPass} onChange={e => setGmailPass(e.target.value)} />
              </div>
            </div>
            <div className="gmail-hint"><i className="ti ti-lock" style={{ fontSize: 13 }} /> Credentials are used only for this session and never stored</div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--blue)' }}>
              <i className="ti ti-external-link" style={{ fontSize: 12 }} />{' '}
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>Generate a Gmail App Password →</a>
            </div>
          </div>
        )}

        {!job && mode === 'bulk' && (
          <div className="gmail-card">
            <div className="gc-head">
              <i className="ti ti-layers-subtract gc-icon" />
              <div>
                <div className="gc-title">Chunk size</div>
                <div className="gc-sub">Emails per SMTP connection — lower is safer, higher is faster</div>
              </div>
            </div>
            <div className="form-group" style={{ maxWidth: 160, marginTop: 10 }}>
              <label className="form-label">Emails per chunk</label>
              <input type="number" min={5} max={100} value={chunkSize} onChange={e => setChunkSize(parseInt(e.target.value) || 20)} />
            </div>
          </div>
        )}

        {!job && mode === 'drip' && (
          <div className="gmail-card">
            <div className="gc-head">
              <i className="ti ti-clock gc-icon" />
              <div>
                <div className="gc-title">Drip rate</div>
                <div className="gc-sub">How many emails to send per hour</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ margin: 0, minWidth: 140 }}>
                <label className="form-label">Emails per hour</label>
                <input type="number" min={1} max={60} value={dripRate} onChange={e => setDripRate(parseInt(e.target.value) || 5)} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text2)', paddingTop: 18 }}>{dripEstimate()}</div>
            </div>
          </div>
        )}

        {!job && app.sender.resume && (
          <div className="gmail-card">
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={attachResume} onChange={e => setAttachResume(e.target.checked)} style={{ width: 16, height: 16 }} />
              <span><i className="ti ti-paperclip" style={{ fontSize: 14, color: 'var(--text2)' }} /> Attach my resume ({app.sender.resume.filename}) to these emails</span>
            </label>
          </div>
        )}

        {(job || sending) && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <div className="progress-label">{progressLabel}</div>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            </div>
            {job && (
              <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                {job.items.map((item, i) => (
                  <div key={item.contactId} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                    borderTop: i === 0 ? 'none' : '0.5px solid var(--border)', fontSize: 13, background: 'var(--bg)',
                  }}>
                    <Avatar name={item.name} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>{item.to}</div>
                    </div>
                    {item.status === 'sent' ? (
                      <span style={{ color: 'var(--green)' }}><i className="ti ti-circle-check" /> Sent</span>
                    ) : item.status === 'failed' ? (
                      <span style={{ color: 'var(--red)' }} title={(item.error || '').slice(0, 60)}><i className="ti ti-circle-x" /> Failed</span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--amber)' }}><i className="ti ti-loader" style={{ animation: 'spin 1s linear infinite' }} /> Sending</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {job && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => navigate('/')} type="button">
                  <i className="ti ti-arrow-minimize" /> Run in background
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="step-footer">
        <Link to={backHref} className="btn" style={sending ? { pointerEvents: 'none', opacity: 0.4 } : undefined}>
          <i className="ti ti-arrow-left" /> Back
        </Link>
        <button className="btn btn-primary" onClick={startSend} disabled={sending} type="button">
          {sending
            ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> {job ? 'Sending…' : 'Starting…'}</>
            : <><i className="ti ti-send" /> {mode === 'drip'
                ? `Schedule ${approved.length} email${approved.length !== 1 ? 's' : ''}`
                : `Send ${approved.length} email${approved.length !== 1 ? 's' : ''} now`}</>}
        </button>
      </div>

      <ModePicker open={pickerOpen} mode={pickerMode} onPick={setPickerMode} onConfirm={confirmPicker} />
    </Layout>
  );
}
