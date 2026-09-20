import { useEffect, useRef, useState } from 'react';
import {
  onboardingSeedTemplatesApi, onboardingStarterTemplatesApi,
  uploadResumeApi, type OnboardingStatus,
} from '../../lib/api';

interface Starter { key: string; name: string; subject: string; body: string }

/**
 * The optional last step: a few templates to edit rather than a blank page, and
 * the resume most outreach attaches.
 *
 * Skippable by design — neither is needed to send, and a required step someone
 * cannot satisfy is worse than no step at all.
 */
export default function StepStarter({ status, onDone, onSkip }: {
  status: OnboardingStatus;
  onDone: () => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [starters, setStarters] = useState<Starter[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onboardingStarterTemplatesApi().then(setStarters).catch(() => setStarters([]));
  }, []);

  const addTemplates = async () => {
    setError(''); setSeeding(true);
    try {
      await onboardingSeedTemplatesApi();
      await onDone();
    } catch (err: any) {
      setError(err.message || 'Could not add templates');
    } finally {
      setSeeding(false);
    }
  };

  const upload = async (file: File) => {
    setError(''); setUploading(true);
    try {
      await uploadResumeApi(file);
      await onDone();
    } catch (err: any) {
      setError(err.message || 'Could not upload');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <p style={{ color: 'var(--text2)', fontSize: 14, marginTop: 0 }}>
        Optional, and both can wait. You can skip straight to the app.
      </p>

      <div style={{ fontWeight: 600, fontSize: 14, margin: '18px 0 8px' }}>Starter templates</div>
      {status.checks.templates ? (
        <div className="info-box" style={{ borderColor: 'var(--green)' }}>
          <i className="ti ti-circle-check" style={{ color: 'var(--green)' }} />{' '}
          You already have {status.templateCount} template{status.templateCount === 1 ? '' : 's'}.
        </div>
      ) : (
        <>
          <div className="table-card" style={{ marginBottom: 10 }}>
            {starters.map(t => (
              <div key={t.key} style={{ borderBottom: '1px solid var(--border)' }}>
                <button
                  type="button" onClick={() => setOpen(open === t.key ? null : t.key)}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                           gap: 10, padding: '10px 12px', background: 'none', border: 'none',
                           font: 'inherit', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span>
                    <strong style={{ fontSize: 13 }}>{t.name}</strong>
                    <span style={{ color: 'var(--text3)', fontSize: 12, marginLeft: 8 }}>{t.subject}</span>
                  </span>
                  <i className={`ti ti-chevron-${open === t.key ? 'up' : 'down'}`} style={{ fontSize: 13 }} />
                </button>
                {open === t.key && (
                  <pre style={{ margin: 0, padding: '0 12px 12px', whiteSpace: 'pre-wrap', fontSize: 12.5,
                                color: 'var(--text2)', fontFamily: 'inherit' }}>{t.body}</pre>
                )}
              </div>
            ))}
          </div>
          <button className="btn" type="button" onClick={addTemplates} disabled={seeding}>
            {seeding ? <><i className="ti ti-loader" /> Adding…</> : <><i className="ti ti-plus" /> Add these three</>}
          </button>
        </>
      )}

      <div style={{ fontWeight: 600, fontSize: 14, margin: '22px 0 8px' }}>Resume</div>
      {status.checks.resume ? (
        <div className="info-box" style={{ borderColor: 'var(--green)' }}>
          <i className="ti ti-circle-check" style={{ color: 'var(--green)' }} /> Resume uploaded.
        </div>
      ) : (
        <>
          <p style={{ color: 'var(--text2)', fontSize: 13, margin: '0 0 10px' }}>
            Attached to any campaign with “attach resume” switched on. PDF or Word, up to 5 MB.
          </p>
          <input
            ref={fileRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }}
          />
          <button className="btn" type="button" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <><i className="ti ti-loader" /> Uploading…</> : <><i className="ti ti-upload" /> Upload resume</>}
          </button>
        </>
      )}

      {error && <div className="login-error" style={{ textAlign: 'left', marginTop: 14 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
        <button className="btn btn-primary" type="button" onClick={onDone}>Finish setup</button>
        <button className="btn" type="button" onClick={onSkip}>Skip for now</button>
      </div>
    </div>
  );
}
