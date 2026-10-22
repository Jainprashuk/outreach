import { useState } from 'react';
import { createPortal } from 'react-dom';
import { cloudConsentApi } from '../../lib/api';

// The way into a user's browser on the cloud VM (deploy/cloud-worker). The
// first time, it explains where their job-site logins will live and asks them
// to agree; after that it is a plain link. The admin sees the agreement date
// in their drawer.
//
// The confirm button is itself the <a target="_blank">, so the new tab opens
// from the click (popup blockers allow that); the agreement is recorded
// alongside, without waiting for it.
export default function CloudBrowserButton({ url, consentedAt, className = 'btn btn-sm', label = 'Cloud browser', onConsent }: {
  url: string;
  consentedAt: string | null;
  className?: string;
  label?: React.ReactNode;
  onConsent?: (at: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState<boolean>(!!consentedAt);

  if (agreed) {
    return (
      <a className={className} href={url} target="_blank" rel="noreferrer"
        title="The browser your workers use, running in the cloud. Log in to your job sites here.">
        <i className="ti ti-cloud" /> {label}
      </a>
    );
  }

  const agree = () => {
    setAgreed(true);
    setAsking(false);
    cloudConsentApi().then(r => onConsent?.(r.cloudConsentAt)).catch(() => { /* asked again next time */ setAgreed(false); });
  };

  return (
    <>
      <button className={className} type="button" onClick={() => setAsking(true)}
        title="The browser your workers use, running in the cloud. Log in to your job sites here.">
        <i className="ti ti-cloud" /> {label}
      </button>
      {asking && createPortal(
        <div className="edit-modal-wrap open" onClick={(e) => { if (e.target === e.currentTarget) setAsking(false); }}>
          <div className="edit-modal" role="dialog" aria-modal="true" aria-label="Before you open your cloud browser"
            style={{ maxWidth: 520, width: '100%' }}>
            <h2 style={{ marginTop: 0 }}><i className="ti ti-cloud" /> Before you open your cloud browser</h2>
            <p style={{ margin: '6px 0 10px' }}>
              Your Naukri, Instahyre and Hirist workers now run on a server, using a Chrome browser that lives there.
              Your computer can be off.
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.6 }}>
              <li>You log in to your job sites in that browser yourself. Your passwords are never shared with anyone.</li>
              <li>Those logins stay saved on the server, so your runs can happen on schedule.</li>
              <li>The admin who runs the server can technically access it, as with any hosted service.</li>
            </ul>
            <p className="page-info" style={{ margin: '0 0 14px' }}>
              Rather keep running the workers on your own computer? Contact the admin who invited you.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-sm" type="button" onClick={() => setAsking(false)}>Not now</button>
              <a className="btn btn-sm btn-primary" href={url} target="_blank" rel="noreferrer" onClick={agree}>
                I understand, open it
              </a>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
