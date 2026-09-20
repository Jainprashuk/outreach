import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { createCampaignFromContactsApi } from '../lib/api';

/** A narrowly-scoped campaign creator for contacts already in Outreach. */
export default function CreateContactCampaignModal({ contactIds, onClose }: {
  contactIds: string[];
  onClose: () => void;
}) {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(`Contact campaign — ${new Date().toLocaleDateString()}`);
  const [templateKey, setTemplateKey] = useState(Object.keys(app.templates)[0] || '');
  const [contactsPerDay, setContactsPerDay] = useState(Math.min(25, contactIds.length));
  const [ratePerHour, setRatePerHour] = useState(5);
  const [runHourIst, setRunHourIst] = useState(9);
  const [attachResume, setAttachResume] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const submit = async () => {
    if (!name.trim()) { setError('A campaign name is required.'); return; }
    if (!templateKey) { setError('Choose a template.'); return; }
    setSaving(true); setError('');
    try {
      const campaign = await createCampaignFromContactsApi({
        name: name.trim(), templateKey, contactIds, contactsPerDay, ratePerHour, runHourIst, attachResume,
      });
      toast(`Campaign created with ${contactIds.length} selected contacts.`, 'success');
      navigate(`/campaigns/${campaign.id}`);
    } catch (e: any) {
      setError(e.message === 'credentials_missing'
        ? 'Set GMAIL_EMAIL and GMAIL_APP_PASSWORD on the server before starting a campaign.'
        : (e.message || 'Could not create the campaign.'));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 540, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div><div style={{ fontWeight: 600, fontSize: 15 }}>Create campaign from selected contacts</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{contactIds.length} contact{contactIds.length === 1 ? '' : 's'} selected</div></div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} disabled={saving} type="button"><i className="ti ti-x" /></button>
        </div>
        <div className="info-box" style={{ marginTop: 12 }}><i className="ti ti-info-circle" /><span>
          This schedules only the selected contacts. Their contact records stay in place; campaign sending follows the usual 24-hour send safeguard.
        </span></div>
        {error && <div className="info-box" style={{ marginTop: 10, background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent' }}><i className="ti ti-alert-triangle" /><span>{error}</span></div>}
        <label style={{ display: 'block', marginTop: 14 }}><div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>Campaign name</div>
          <input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%' }} /></label>
        <label style={{ display: 'block', marginTop: 10 }}><div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>Template</div>
          <select value={templateKey} onChange={e => setTemplateKey(e.target.value)} style={{ width: '100%' }}>
            {Object.entries(app.templates).map(([key, template]) => <option key={key} value={key}>{template.name}</option>)}
          </select></label>
        <div className="iv-grid" style={{ marginTop: 10 }}>
          <label><div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>Contacts per day</div><input type="number" min="1" max="500" value={contactsPerDay} onChange={e => setContactsPerDay(Number(e.target.value))} style={{ width: '100%' }} /></label>
          <label><div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>Emails per hour</div><input type="number" min="1" max="60" value={ratePerHour} onChange={e => setRatePerHour(Number(e.target.value))} style={{ width: '100%' }} /></label>
          <label><div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>Start hour (IST)</div><input type="number" min="0" max="23" value={runHourIst} onChange={e => setRunHourIst(Number(e.target.value))} style={{ width: '100%' }} /></label>
          <label style={{ display: 'flex', alignItems: 'end', gap: 7, fontSize: 13, paddingBottom: 7 }}><input type="checkbox" checked={attachResume} onChange={e => setAttachResume(e.target.checked)} /> Attach resume</label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-sm" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create campaign'}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
