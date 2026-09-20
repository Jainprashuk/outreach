import { useState } from 'react';
import { saveSettingsApi, type OnboardingStatus } from '../../lib/api';

// Settings ships these as schema defaults, so "not set" reads as this exact
// string rather than as an empty field. Kept in sync with lib/onboarding.js,
// which is what /api/onboarding/complete checks against.
const DEFAULT_NAME = 'Your Name';
const DEFAULT_COMPANY = 'Your Company';

/**
 * Who the emails are from.
 *
 * Required: {{sender}} is in every template, and an unset name renders the
 * literal words "Your Name" into a real stranger's inbox.
 */
export default function StepIdentity({ status, onDone }: {
  status: OnboardingStatus;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(status.senderName === DEFAULT_NAME ? '' : status.senderName || '');
  const [company, setCompany] = useState(status.senderCompany === DEFAULT_COMPANY ? '' : status.senderCompany || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmedName = name.trim();
  const canContinue = !!trimmedName && trimmedName !== DEFAULT_NAME;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canContinue) return;
    setError(''); setBusy(true);
    try {
      await saveSettingsApi({ senderName: trimmedName, senderCompany: company.trim() });
      await onDone();
    } catch (err: any) {
      setError(err.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p style={{ color: 'var(--text2)', fontSize: 14, marginTop: 0 }}>
        These fill the <code>{'{{sender}}'}</code> and <code>{'{{senderCompany}}'}</code>{' '}
        placeholders in your templates.
      </p>

      <label className="login-label" htmlFor="ob-name">Your name</label>
      <input
        id="ob-name" className="login-input" required autoFocus
        value={name} onChange={e => setName(e.target.value)}
        placeholder="Prashuk Jain" style={{ marginBottom: 14 }}
      />

      <label className="login-label" htmlFor="ob-company">Company or affiliation <span style={{ color: 'var(--text3)' }}>(optional)</span></label>
      <input
        id="ob-company" className="login-input"
        value={company} onChange={e => setCompany(e.target.value)}
        placeholder="Freelance, or your current company"
      />

      {/* Shows the exact thing a recipient will read, which is the fastest way
          to notice the default is still in place. */}
      <div className="info-box" style={{ marginTop: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Your sign-off will read:</div>
        <div style={{ whiteSpace: 'pre-line', fontSize: 14 }}>
          {`Thanks,\n${trimmedName || DEFAULT_NAME}${company.trim() ? `\n${company.trim()}` : ''}`}
        </div>
      </div>

      {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}

      <button className="btn btn-primary" type="submit" disabled={busy || !canContinue} style={{ marginTop: 18 }}>
        {busy ? <><i className="ti ti-loader" /> Saving…</> : 'Save and continue'}
      </button>
    </form>
  );
}
