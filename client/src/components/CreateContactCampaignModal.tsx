import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { createCampaignFromContactsApi, previewCampaignFromContactsApi, type CampaignContactsPreview } from '../lib/api';

type SendWay = 'step' | 'campaign';

/** Step-wise sends carry their ids in the URL; past this, a campaign is the way. */
export const STEP_MAX = 200;

const SKIP_LABEL: Record<keyof CampaignContactsPreview['skipped'], string> = {
  missing: 'no longer exist',
  in_campaign: 'already in a campaign',
  invalid: 'not a valid address',
  cooldown: 'emailed in the last 24h',
  dead: 'bounced before',
  interview: 'in your interviews',
  replied: 'waiting on your reply',
};

/**
 * Sends a set of contacts, either step-wise (the New entry wizard, preloaded) or as
 * a drip campaign. The Contacts page opens it campaign-only with its selection; the
 * Action Center opens it from a workflow button with both ways offered.
 *
 * `prepare` is for workflows whose items aren't contacts yet (leads, Discover
 * people): it runs once, on submit, with the chosen template and returns the
 * contact ids to send.
 */
export default function CreateContactCampaignModal({
  contactIds: givenIds, onClose, title, subtitle, count, initialTemplateKey, initialName,
  prepare, stepHref, defaultMode, onDone,
}: {
  contactIds?: string[];
  onClose: () => void;
  title?: string;
  subtitle?: string;
  /** How many items `prepare` starts from, for the header. */
  count?: number;
  initialTemplateKey?: string;
  initialName?: string;
  prepare?: (templateKey: string) => Promise<string[]>;
  /** Offers the step-wise way: where the wizard starts with these ids. */
  stepHref?: (ids: string[]) => string;
  defaultMode?: SendWay;
  onDone?: () => void;
}) {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [ids, setIds] = useState<string[] | null>(givenIds || null);
  const total = givenIds ? givenIds.length : (count || 0);
  const [way, setWay] = useState<SendWay>(
    !stepHref ? 'campaign' : (defaultMode || (total <= 25 ? 'step' : 'campaign')),
  );
  const templateKeys = Object.keys(app.templates);
  const [name, setName] = useState(initialName || `Contact campaign — ${new Date().toLocaleDateString()}`);
  const [templateKey, setTemplateKey] = useState(
    initialTemplateKey && app.templates[initialTemplateKey] ? initialTemplateKey : (templateKeys[0] || ''),
  );
  const [contactsPerDay, setContactsPerDay] = useState(Math.max(1, Math.min(25, total || 25)));
  const [ratePerHour, setRatePerHour] = useState(5);
  const [runHourIst, setRunHourIst] = useState(9);
  const [attachResume, setAttachResume] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<CampaignContactsPreview | null>(null);

  // Templates load lazily; pick the requested one once it arrives.
  useEffect(() => {
    if (!templateKey && templateKeys.length) {
      setTemplateKey(initialTemplateKey && app.templates[initialTemplateKey] ? initialTemplateKey : templateKeys[0]);
    }
  }, [templateKeys.join(','), initialTemplateKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { app.loadTemplates().catch(() => { /* select shows what it has */ }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // How many of these a campaign would actually take, and why not the rest.
  useEffect(() => {
    if (!ids || !ids.length) return;
    let live = true;
    previewCampaignFromContactsApi(ids).then(p => { if (live) setPreview(p); }).catch(() => { /* the create reports it */ });
    return () => { live = false; };
  }, [ids]);

  const needsTemplate = way === 'campaign' || !!prepare;

  const submit = async () => {
    if (way === 'campaign' && !name.trim()) { setError('A campaign name is required.'); return; }
    if (needsTemplate && !templateKey) { setError('Choose a template.'); return; }
    setSaving(true); setError('');
    try {
      let sendIds = ids;
      if (!sendIds) {
        sendIds = prepare ? await prepare(templateKey) : [];
        setIds(sendIds);
      }
      if (!sendIds.length) { setError('Nothing left to send — they may already be contacts in another state.'); setSaving(false); return; }

      if (way === 'step' && stepHref) {
        if (sendIds.length > STEP_MAX) {
          setError(`Step-wise handles up to ${STEP_MAX} at a time — use a campaign for ${sendIds.length}.`);
          setSaving(false); return;
        }
        onDone?.();
        onClose();
        navigate(stepHref(sendIds));
        return;
      }

      const campaign = await createCampaignFromContactsApi({
        name: name.trim(), templateKey, contactIds: sendIds, contactsPerDay, ratePerHour, runHourIst, attachResume,
      });
      const accepted = campaign.stats?.total ?? sendIds.length;
      const left = sendIds.length - accepted;
      toast(`Campaign created with ${accepted} contact${accepted === 1 ? '' : 's'}${left > 0 ? ` (${left} left out)` : ''}.`, 'success');
      onDone?.();
      navigate(`/campaigns/${campaign.id}`);
    } catch (e: any) {
      setError(e.message === 'credentials_missing'
        ? 'Connect your Gmail in Settings before starting a campaign.'
        : (e.message || 'Could not create the campaign.'));
      setSaving(false);
    }
  };

  const skippedParts = preview
    ? (Object.keys(SKIP_LABEL) as (keyof CampaignContactsPreview['skipped'])[])
      .filter(k => preview.skipped[k] > 0).map(k => `${preview.skipped[k]} ${SKIP_LABEL[k]}`)
    : [];
  const label = (s: string) => <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{s}</div>;

  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 540, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="reply-modal-header">
          <div><div style={{ fontWeight: 600, fontSize: 15 }}>{title || 'Create campaign from selected contacts'}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{subtitle || `${total} contact${total === 1 ? '' : 's'} selected`}</div></div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} disabled={saving} type="button"><i className="ti ti-x" /></button>
        </div>

        {stepHref && (
          <div style={{ marginTop: 12 }}>
            {label('How do you want to send?')}
            <div className="seg-toggle" role="tablist" style={{ display: 'inline-flex' }}>
              <button type="button" role="tab" aria-selected={way === 'step'} className={`btn btn-xs${way === 'step' ? ' active' : ''}`} onClick={() => setWay('step')}>
                <i className="ti ti-list-check" /> Step-wise (send now)
              </button>
              <button type="button" role="tab" aria-selected={way === 'campaign'} className={`btn btn-xs${way === 'campaign' ? ' active' : ''}`} onClick={() => setWay('campaign')}>
                <i className="ti ti-calendar-repeat" /> Campaign (drip)
              </button>
            </div>
          </div>
        )}

        <div className="info-box" style={{ marginTop: 12 }}><i className="ti ti-info-circle" /><span>
          {way === 'step'
            ? 'Opens New entry with these contacts loaded: review and edit each email, then send in one go. Best for a short list you want to check.'
            : 'Schedules these contacts over the coming days at your daily limit. Their contact records stay in place; campaign sending follows the usual 24-hour send safeguard. Best for a long list.'}
        </span></div>

        {preview && (
          <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 10 }}>
            <strong style={{ color: 'var(--text)' }}>{preview.eligible} of {preview.requested}</strong> can be sent
            {skippedParts.length > 0 && <> · left out: {skippedParts.join(', ')}</>}
            {preview.credentialsMissing && way === 'campaign' && <div style={{ color: 'var(--red)', marginTop: 4 }}>Connect your Gmail in Settings first — a campaign sends unattended.</div>}
          </div>
        )}

        {error && <div className="info-box" style={{ marginTop: 10, background: 'var(--red-bg)', color: 'var(--red)', borderColor: 'transparent' }}><i className="ti ti-alert-triangle" /><span>{error}</span></div>}

        {way === 'campaign' && (
          <label style={{ display: 'block', marginTop: 14 }}>{label('Campaign name')}
            <input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%' }} /></label>
        )}
        {needsTemplate && (
          <label style={{ display: 'block', marginTop: 10 }}>{label('Template')}
            <select value={templateKey} onChange={e => setTemplateKey(e.target.value)} style={{ width: '100%' }}>
              {Object.entries(app.templates).map(([key, template]) => <option key={key} value={key}>{template.name}</option>)}
            </select></label>
        )}
        {way === 'campaign' && (
          <div className="iv-grid" style={{ marginTop: 10 }}>
            <label>{label('Contacts per day')}<input type="number" min="1" max="500" value={contactsPerDay} onChange={e => setContactsPerDay(Number(e.target.value))} style={{ width: '100%' }} /></label>
            <label>{label('Emails per hour')}<input type="number" min="1" max="60" value={ratePerHour} onChange={e => setRatePerHour(Number(e.target.value))} style={{ width: '100%' }} /></label>
            <label>{label('Start hour (IST)')}<input type="number" min="0" max="23" value={runHourIst} onChange={e => setRunHourIst(Number(e.target.value))} style={{ width: '100%' }} /></label>
            <label style={{ display: 'flex', alignItems: 'end', gap: 7, fontSize: 13, paddingBottom: 7 }}><input type="checkbox" checked={attachResume} onChange={e => setAttachResume(e.target.checked)} /> Attach resume</label>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-sm" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" onClick={submit} disabled={saving}>
            {saving ? 'Working…' : way === 'step' ? 'Continue to review' : 'Create campaign'}
          </button>
        </div>
      </div>
    </div>, document.body,
  );
}
