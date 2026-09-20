import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import StepGmail from '../components/onboarding/StepGmail';
import StepIdentity from '../components/onboarding/StepIdentity';
import StepStarter from '../components/onboarding/StepStarter';
import { useSession } from '../context/SessionContext';
import {
  onboardingStatusApi, onboardingStepApi, onboardingSkipApi, onboardingCompleteApi,
  type OnboardingStatus,
} from '../lib/api';

const TITLES = [
  { key: 'gmail', label: 'Connect Gmail', required: true },
  { key: 'identity', label: 'Your details', required: true },
  { key: 'starter', label: 'Templates', required: false },
];

/**
 * First-run setup.
 *
 * Every step saves as you leave it, so Back is pure navigation and closing the
 * tab loses nothing — the server remembers which step you reached.
 */
export default function Onboarding() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const s = await onboardingStatusApi();
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    load()
      .then(s => setStep(Math.min(s.step ?? 0, TITLES.length - 1)))
      .catch(e => setError(e.message));
  }, [load]);

  const goTo = async (next: number) => {
    setStep(next);
    // Best-effort: losing the bookmark is a worse first step than a toast, but
    // it is not worth blocking navigation over.
    onboardingStepApi(next).catch(() => {});
  };

  const finish = async () => {
    setError('');
    try {
      await onboardingCompleteApi();
      // The session carries `onboarded`, and OnboardingGate reads it — without
      // this refresh the gate would bounce us straight back here.
      await refresh();
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/onboarding' ? from : '/', { replace: true });
    } catch (e: any) {
      setError(e.message || 'Could not finish setup');
      // The server names the step it is unhappy about, so send them to it
      // rather than leaving them staring at an error on the wrong screen.
      const idx = TITLES.findIndex(t => t.key === e.step);
      if (idx >= 0) setStep(idx);
      await load();
    }
  };

  // Advancing from a step re-reads status, so each step renders from the
  // server's view of what is actually configured rather than from local hope.
  const advance = async (): Promise<void> => {
    await load();
    const next = step + 1;
    if (next >= TITLES.length) { await finish(); return; }
    setStep(next);
    onboardingStepApi(next).catch(() => {});
  };

  const skipStarter = async () => {
    try { await onboardingSkipApi('starter'); } catch { /* not worth blocking on */ }
    await finish();
  };

  if (!status) {
    return (
      <Layout minimal title="Set up your account" wide>
        <div className="section">
          {error ? <div className="login-error">{error}</div> : <div className="skeleton" style={{ height: 180 }} />}
        </div>
      </Layout>
    );
  }

  const current = TITLES[step];

  return (
    <Layout minimal title="Set up your account" subtitle="A few things before your first email" wide>
      <div className="section" style={{ maxWidth: 620, margin: '0 auto', width: '100%' }}>
        {/* Progress. Steps already satisfied show a tick even if you arrived
            mid-way, so returning does not look like starting over. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {TITLES.map((t, i) => {
            const done = t.key === 'gmail' ? status.checks.gmail
              : t.key === 'identity' ? status.checks.identity
              : status.checks.templates || status.checks.resume;
            const active = i === step;
            return (
              <div key={t.key} style={{ flex: 1 }}>
                <div style={{
                  height: 3, borderRadius: 2, marginBottom: 6,
                  background: active ? 'var(--accent)' : done ? 'var(--green)' : 'var(--border-md)',
                }} />
                <div style={{ fontSize: 11.5, color: active ? 'var(--text)' : 'var(--text3)', fontWeight: active ? 600 : 400 }}>
                  {done && !active && <i className="ti ti-check" style={{ color: 'var(--green)', marginRight: 4 }} />}
                  {t.label}
                  {!t.required && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · optional</span>}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="login-error" style={{ textAlign: 'left', marginBottom: 14 }}>{error}</div>}

        {current.key === 'gmail' && <StepGmail status={status} onDone={advance} />}
        {current.key === 'identity' && <StepIdentity status={status} onDone={advance} />}
        {current.key === 'starter' && <StepStarter status={status} onDone={finish} onSkip={skipStarter} />}

        {step > 0 && (
          <button
            className="login-link" type="button" onClick={() => goTo(step - 1)}
            style={{ marginTop: 20 }}
          >
            &larr; Back
          </button>
        )}
      </div>
    </Layout>
  );
}
