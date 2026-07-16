import { useEffect, useRef, useState } from 'react';
import Layout from '../components/Layout';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { API_BASE } from '../lib/api';
import { BUILTIN_VARIABLES } from '../lib/format';
import SmtpChart from '../components/SmtpChart';

const VARIABLE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

interface VarRow { key: string; value: string; }

export default function Settings() {
  const app = useApp();
  const toast = useToast();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [varRows, setVarRows] = useState<VarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [sent24h, setSent24h] = useState<{ count: number | null; buckets: any[] }>({ count: null, buckets: [] });
  const [chartLoading, setChartLoading] = useState(false);
  const resumeInputRef = useRef<HTMLInputElement>(null);

  const loadSent24h = async () => {
    setChartLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/jobs/stats/sent-24h`);
      const data = await res.json();
      setSent24h({ count: data.count ?? null, buckets: Array.isArray(data.buckets) ? data.buckets : [] });
    } catch {
      setSent24h({ count: null, buckets: [] });
    } finally {
      setChartLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      loadSent24h();
      try {
        const sender = await app.loadSettings();
        setName(sender.name === 'Your Name' ? '' : sender.name);
        setCompany(sender.company === 'Your Company' ? '' : sender.company);
        setEmail(sender.email);
        setVarRows((sender.customVariables || []).map(v => ({ key: v.key, value: v.value })));
      } catch (err: any) {
        toast('Could not load settings: ' + err.message, 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    const reserved = BUILTIN_VARIABLES.map(v => v.key);
    const customVariables: VarRow[] = [];
    for (const row of varRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key) continue;
      if (!VARIABLE_KEY_RE.test(key)) {
        toast(`Invalid variable name "${key}". Use letters, numbers and underscores, starting with a letter.`, 'error');
        return;
      }
      if (reserved.includes(key)) {
        toast(`"${key}" is a built-in variable and can't be reused.`, 'error');
        return;
      }
      customVariables.push({ key, value });
    }

    setSaveState('saving');
    try {
      await app.saveSettings({
        senderName: name.trim() || 'Your Name',
        senderCompany: company.trim() || 'Your Company',
        gmailEmail: email.trim(),
        customVariables,
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (err: any) {
      toast('Could not save settings: ' + err.message, 'error');
      setSaveState('idle');
    }
  };

  const handleResumeUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      await app.uploadResume(file);
      toast('Resume uploaded.', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const removeResume = async () => {
    if (!confirm('Remove your uploaded resume?')) return;
    try {
      await app.deleteResume();
      toast('Resume removed.', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const resume = app.sender.resume;
  const dis = loading ? { disabled: true, style: { opacity: 0.5 } } : {};

  return (
    <Layout title="Settings" subtitle="Account, sender, and SMTP configuration">
      {/* SENDER INFO */}
      <div className="s-card" style={{ animationDelay: '.04s' }}>
        <div className="s-head">
          <div className="s-head-left">
            <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-user-circle" /></div>
            <div>
              <div className="s-title">Sender details</div>
              <div className="s-sub">How you appear in outgoing emails</div>
            </div>
          </div>
        </div>
        <div className="s-body">
          <div className="form-grid">
            <div className="form-group"><label className="form-label">Your name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your Name" {...dis} /></div>
            <div className="form-group"><label className="form-label">Your company</label>
              <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Your Company" {...dis} /></div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
            Replaces <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>{'{{sender}}'}</code> and{' '}
            <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>{'{{senderCompany}}'}</code> in templates.
          </p>
        </div>
      </div>

      {/* GMAIL */}
      <div className="s-card" style={{ animationDelay: '.08s' }}>
        <div className="s-head">
          <div className="s-head-left">
            <div className="s-icon" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}><i className="ti ti-brand-gmail" /></div>
            <div>
              <div className="s-title">Gmail / SMTP</div>
              <div className="s-sub">Default sender address for outreach</div>
            </div>
          </div>
        </div>
        <div className="s-body">
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">Gmail address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="yourname@gmail.com" {...dis} />
          </div>
          <div className="info-box" style={{ marginBottom: 0 }}>
            <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>
              Sending requires a <strong>16-character App Password</strong>.{' '}
              Generate one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>Google Account → Security → App Passwords</a>.{' '}
              It's entered at send time and never stored.
            </div>
          </div>
        </div>
      </div>

      {/* RESUME */}
      <div className="s-card" style={{ animationDelay: '.12s' }}>
        <div className="s-head">
          <div className="s-head-left">
            <div className="s-icon" style={{ background: 'var(--blue-bg)', color: 'var(--blue)' }}><i className="ti ti-file-cv" /></div>
            <div>
              <div className="s-title">Resume</div>
              <div className="s-sub">Optional attachment for outreach emails</div>
            </div>
          </div>
        </div>
        <div className="s-body">
          {!resume ? (
            <div className="upload-zone" role="button" tabIndex={0}
              onClick={() => resumeInputRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') resumeInputRef.current?.click(); }}>
              <i className="ti ti-cloud-upload" />
              <div className="uz-title">Click to upload your resume</div>
              <div className="uz-sub">PDF or Word document · max 5 MB</div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
              <i className="ti ti-file-text" style={{ fontSize: 22, color: 'var(--accent)' }} />
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resume.filename}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {formatBytes(resume.size)} · uploaded {new Date(resume.uploadedAt).toLocaleDateString()}
                </div>
              </div>
              <a className="btn btn-xs" href={`${API_BASE}/api/settings/resume`} target="_blank" rel="noreferrer" title="Download"><i className="ti ti-download" /></a>
              <button className="btn btn-xs" onClick={() => resumeInputRef.current?.click()} type="button" title="Replace"><i className="ti ti-replace" /></button>
              <button className="btn btn-xs" style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }} onClick={removeResume} type="button" title="Remove"><i className="ti ti-trash" /></button>
            </div>
          )}
          <input ref={resumeInputRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
            onChange={e => { handleResumeUpload(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      </div>

      {/* CUSTOM VARIABLES */}
      <div className="s-card" style={{ animationDelay: '.16s' }}>
        <div className="s-head">
          <div className="s-head-left">
            <div className="s-icon" style={{ background: 'var(--amber-bg)', color: 'var(--amber)' }}><i className="ti ti-variable" /></div>
            <div>
              <div className="s-title">Custom variables</div>
              <div className="s-sub">Define reusable merge tags for templates</div>
            </div>
          </div>
        </div>
        <div className="s-body">
          <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>
            Use in any template as <span className="var-pill">{'{{variableName}}'}</span>.
          </p>
          {varRows.map((row, i) => (
            <div className="batch-row" key={i}>
              <input type="text" placeholder="variableName" value={row.key} style={{ flex: 1, fontFamily: 'monospace' }}
                onChange={e => setVarRows(rows => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
              <input type="text" placeholder="Value" value={row.value} style={{ flex: 2 }}
                onChange={e => setVarRows(rows => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
              <button className="btn btn-xs" style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }} type="button"
                onClick={() => setVarRows(rows => rows.filter((_, j) => j !== i))}><i className="ti ti-trash" /></button>
            </div>
          ))}
          <button className="btn btn-sm" style={{ borderStyle: 'dashed', marginTop: 4 }} type="button"
            onClick={() => setVarRows(rows => [...rows, { key: '', value: '' }])}>
            <i className="ti ti-plus" /> Add variable
          </button>
        </div>
      </div>

      {/* SMTP ACTIVITY */}
      <div className="s-card" style={{ animationDelay: '.2s' }}>
        <div className="s-head">
          <div className="s-head-left">
            <div className="s-icon" style={{ background: 'var(--green-bg)', color: 'var(--green)' }}><i className="ti ti-chart-bar" /></div>
            <div>
              <div className="s-title">SMTP activity</div>
              <div className="s-sub">Hourly breakdown · past 24 hours</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: 'var(--green)' }}>{sent24h.count ?? '—'}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>sent / 24 hrs</div>
            </div>
            <button className="btn btn-sm" onClick={loadSent24h} disabled={chartLoading} type="button" style={{ flexShrink: 0 }}>
              <i className="ti ti-refresh" />
            </button>
          </div>
        </div>
        <div className="s-body" style={{ padding: '16px 20px 14px' }}>
          <SmtpChart buckets={sent24h.buckets} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 32 }}>
        <button className="btn btn-primary" onClick={save} disabled={saveState === 'saving' || loading} style={{ padding: '9px 22px' }} type="button">
          {saveState === 'saving' ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
            : saveState === 'saved' ? <><i className="ti ti-circle-check" /> Saved!</>
            : <><i className="ti ti-check" /> Save settings</>}
        </button>
      </div>
    </Layout>
  );
}
