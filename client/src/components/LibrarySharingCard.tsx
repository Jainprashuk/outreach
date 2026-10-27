import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { librarySharingApi, setLibrarySharingApi } from '../lib/api';
import Switch from './Switch';

/** The user's own choice: is their contact data part of the shared Library? On unless turned off. */
export default function LibrarySharingCard() {
  const toast = useToast();
  const [sharing, setSharing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { librarySharingApi().then(r => setSharing(r.sharing)).catch(() => setSharing(null)); }, []);

  const flip = async (next: boolean) => {
    setBusy(true);
    try {
      setSharing((await setLibrarySharingApi(next)).sharing);
      toast(next ? 'Your contact data is shared in the Library' : 'Your data is no longer in the Library', 'success');
    } catch (e: any) {
      toast(e.message || 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s-card" style={{ animationDelay: '.12s' }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-books" /></div>
          <div>
            <div className="s-title">Shared Library</div>
            <div className="s-sub">Let other users reuse the contact details you collect</div>
          </div>
        </div>
        {sharing !== null && <Switch label="Share my data in the Library" checked={sharing} disabled={busy} onChange={flip} />}
      </div>
      <div className="s-body">
        {sharing === null && <div className="skeleton" style={{ height: 48 }} />}
        {sharing !== null && (
          <div className="sr-share">
            <div className="sr-share-item"><strong>Shared:</strong> the name, email, company, role and LinkedIn of your contacts, leads and Discover people,
              where each came from, and the email formats you set. Your name is shown next to what you added.</div>
            <div className="sr-share-item never"><strong>Never shared:</strong> whether you emailed someone, their replies, your notes,
              templates, campaigns or interviews. The one exception is a plain “bounced” mark on an address that doesn’t exist, so nobody else wastes a send on it.</div>
            <div className="sr-faint">Turning this off removes your data from the Library straight away. Nothing is copied, so nothing is left behind.</div>
          </div>
        )}
      </div>
    </div>
  );
}
