import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { loadSettingsApi, saveSettingsApi } from '../lib/api';

const MAX = 2000;
const EXAMPLE = `Backend engineer, 4 years (Node.js, Go, AWS); currently at Acme Payments.
Notice period: 30 days. Open to Bangalore, Pune or remote. Not open to relocating abroad.
Expected CTC: 28–32 LPA. Free for calls weekdays after 6pm IST.`;

/**
 * Facts the AI may use when it drafts a reply in the Mailbox. It is told to use only these,
 * the conversation and your note — so anything missing here comes back as a [placeholder]
 * rather than an invented answer. Saves on its own, independently of the Save button.
 */
export default function ReplyProfileCard() {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadSettingsApi()
      .then(s => { setValue(s.replyProfile || ''); setSaved(s.replyProfile || ''); })
      .catch(() => setValue(''));
  }, []);

  const save = async () => {
    if (value === null) return;
    setBusy(true);
    try {
      const s = await saveSettingsApi({ replyProfile: value });
      setSaved(s.replyProfile || '');
      toast('Reply profile saved', 'success');
    } catch (e: any) {
      toast(e.message || 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s-card" style={{ animationDelay: '.1s' }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-sparkles" /></div>
          <div>
            <div className="s-title">Reply profile</div>
            <div className="s-sub">What the AI may say about you when it drafts a reply in the Mailbox</div>
          </div>
        </div>
      </div>
      <div className="s-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {value === null ? <div className="skeleton" style={{ height: 96 }} /> : (
          <>
            <textarea id="reply-profile" aria-label="Reply profile" rows={5} maxLength={MAX} value={value}
              placeholder={EXAMPLE} onChange={e => setValue(e.target.value)}
              style={{ width: '100%', resize: 'vertical', font: 'inherit', fontSize: 13 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', flex: 1 }}>
                Role, experience, notice period, locations, salary, availability. Anything not here, the AI leaves as a [gap] for you to fill. {value.length}/{MAX}
              </span>
              <button className="btn btn-sm btn-primary" type="button" onClick={save} disabled={busy || value === saved}>
                {busy ? <i className="ti ti-loader" /> : <i className="ti ti-check" />} Save profile
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
