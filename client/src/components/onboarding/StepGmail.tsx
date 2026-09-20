import { useState } from 'react';
import { connectGmailApi, type OnboardingStatus } from '../../lib/api';

/**
 * Connect the mailbox everything will be sent from.
 *
 * Required: with no credential, nothing can go out at all. Posts to /api/config,
 * which opens a real SMTP connection and verifies the App Password BEFORE
 * storing it — so a failure here means the password genuinely does not work,
 * not that saving failed.
 */
export default function StepGmail({ status, onDone }: {
  status: OnboardingStatus;
  onDone: () => Promise<void>;
}) {
  const [email, setEmail] = useState(status.gmailEmail || '');
  const [appPassword, setAppPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');

  // Without a CREDENTIAL_KEY on the server there is nowhere safe to put the
  // password, so onboarding genuinely cannot be finished. Said plainly rather
  // than as a toast, because the user can do nothing about it themselves.
  if (!status.credentialKeyConfigured) {
    return (
      <div className="info-box danger">
        <strong>This deployment cannot store credentials yet.</strong>
        <p style={{ margin: '8px 0 0', color: 'var(--text2)' }}>
          The server has no <code>CREDENTIAL_KEY</code> set, so a Gmail App Password
          cannot be encrypted. Nothing you enter here would be saved. Ask whoever
          runs the deployment to set one, then reload this page.
        </p>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setDetail(''); setBusy(true);
    try {
      await connectGmailApi(email.trim(), appPassword.trim());
      setAppPassword('');
      await onDone();
    } catch (err: any) {
      setError(err.message || 'Could not connect');
      // /api/config returns the SMTP error separately; it is usually the
      // actionable half ("Invalid credentials", "Application-specific password
      // required").
      setDetail(err.detail || '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p style={{ color: 'var(--text2)', fontSize: 14, marginTop: 0 }}>
        Outreach sends from your own Gmail account, so replies land in your inbox
        and your address is the one people see.
      </p>

      {status.checks.gmail && (
        <div className="info-box" style={{ borderColor: 'var(--green)', marginBottom: 16 }}>
          <i className="ti ti-circle-check" style={{ color: 'var(--green)' }} />{' '}
          Connected as <strong>{status.gmailEmail}</strong>. Enter a new App Password below to replace it.
        </div>
      )}

      <label className="login-label" htmlFor="ob-gmail">Gmail address</label>
      <input
        id="ob-gmail" className="login-input" type="email" required
        value={email} onChange={e => setEmail(e.target.value)}
        placeholder="you@gmail.com" autoComplete="username"
        style={{ marginBottom: 14 }}
      />

      <label className="login-label" htmlFor="ob-pw">App Password</label>
      <input
        id="ob-pw" className="login-input" type="password" required={!status.checks.gmail}
        value={appPassword} onChange={e => setAppPassword(e.target.value)}
        placeholder="16 characters, no spaces" autoComplete="off"
      />
      <p style={{ fontSize: 12, color: 'var(--text3)', margin: '8px 0 0' }}>
        Not your Google password — a 16-character App Password from{' '}
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
          Google Account → App passwords
        </a>. It is stored encrypted (AES-256-GCM), never shown back to the
        browser, and you can remove it any time from Settings.
      </p>

      {error && (
        <div className="login-error" style={{ textAlign: 'left' }}>
          {error}
          {detail && <div style={{ marginTop: 6, fontSize: 12, opacity: .85 }}>{detail}</div>}
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 18 }}>
        {busy ? <><i className="ti ti-loader" /> Verifying…</> : <>Connect and continue</>}
      </button>
      <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10 }}>
        We open a real connection to Gmail to check this works before saving it.
      </p>
    </form>
  );
}
