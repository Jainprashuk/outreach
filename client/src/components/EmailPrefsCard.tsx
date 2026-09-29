import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { emailPrefsApi, setEmailPrefApi, type EmailPref } from '../lib/api';

const HELP: Record<EmailPref['key'], string> = {
  reminders: 'A nudge if setup stalls, or after a few quiet days with nothing sent.',
  'weekly-report': 'Every Monday: last week’s numbers, with the full report as a PDF.',
};

/** The user's own email choices. An admin can turn one off; the user cannot turn it back on. */
export default function EmailPrefsCard() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<EmailPref[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { emailPrefsApi().then(r => setPrefs(r.prefs)).catch(() => setPrefs([])); }, []);

  const flip = async (p: EmailPref) => {
    setBusy(p.key);
    try {
      setPrefs((await setEmailPrefApi(p.key, !p.on)).prefs);
    } catch (e: any) {
      toast(e.message || 'Could not save', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="s-card" style={{ animationDelay: '.1s' }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-mail-cog" /></div>
          <div>
            <div className="s-title">Emails from Outreach</div>
            <div className="s-sub">Updates sent to your sign-in address, never from your Gmail</div>
          </div>
        </div>
      </div>
      <div className="s-body">
        {!prefs && <div className="skeleton" style={{ height: 48 }} />}
        {prefs && prefs.map(p => (
          <label key={p.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', cursor: p.blockedByAdmin ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox" checked={p.on && !p.blockedByAdmin} disabled={p.blockedByAdmin || busy === p.key}
              onChange={() => flip(p)} style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontWeight: 500, fontSize: 13 }}>{p.label}</span>
              {p.blockedByAdmin && <span className="badge badge-pending" style={{ marginLeft: 8 }}>Turned off by admin</span>}
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>{HELP[p.key]}</div>
            </span>
          </label>
        ))}
        <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
          The welcome email when you finish setup is always sent. You can make a report for any period under Analytics → Reports.
        </p>
      </div>
    </div>
  );
}
