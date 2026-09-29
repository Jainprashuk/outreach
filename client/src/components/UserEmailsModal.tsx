import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../context/ToastContext';
import InfoTip from './InfoTip';
import Switch from './Switch';
import { adminSetUserEmailApi, type AdminUserRow, type LifecycleConfig, type LifecycleType } from '../lib/api';
import { EMAIL_TYPES, effectiveState, TONE_COLOR } from '../lib/lifecycleTypes';

// Per-account lifecycle email switches. The switch is only the admin's per-user
// choice; the line under each email says what will ACTUALLY happen, because the
// app-wide switches and the user's own opt-outs apply on top.
export default function UserEmailsModal({ row, config, onClose, onChanged }: {
  row: AdminUserRow;
  config: LifecycleConfig | null;
  onClose: () => void;
  onChanged: (blockedByAdmin: LifecycleType[]) => void;
}) {
  const toast = useToast();
  const [blocked, setBlocked] = useState<LifecycleType[]>(row.emails?.blockedByAdmin || []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async (fn: () => Promise<{ blockedByAdmin: LifecycleType[] }>, done: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setBlocked(r.blockedByAdmin);
      onChanged(r.blockedByAdmin);
      toast(done, 'success');
    } catch (e: any) {
      toast(e.message || 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  };

  const view: AdminUserRow = { ...row, emails: { blockedByAdmin: blocked, optOut: row.emails?.optOut || [] } };
  // With the master switch off every row would read "master switch off". Say
  // that once, and show each row as it will be once the master is on.
  const masterOff = !!config && !config.enabled;
  const rowConfig = config && masterOff ? { ...config, enabled: true } : config;
  const willSend = EMAIL_TYPES.filter(t => effectiveState(t, view, config).tone === 'on').length;
  const allOn = blocked.length === 0;
  const allOff = EMAIL_TYPES.every(t => blocked.includes(t.key));

  return createPortal(
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" aria-label={`Emails for ${row.email}`} style={{ maxWidth: 580 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}><i className="ti ti-mail-cog" /> Emails for this account</div>
            <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.email}</div>
          </div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button"><i className="ti ti-x" /></button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '14px 0 6px', padding: '10px 12px', background: 'var(--bg3)', borderRadius: 8 }}>
          <div style={{ fontSize: 12.5 }}>
            <strong>{willSend}</strong> of {EMAIL_TYPES.length} will actually be sent to them
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-xs btn-success" type="button" disabled={busy || allOn}
              onClick={() => apply(() => adminSetUserEmailApi(row.id!, null, false), `All emails on for ${row.email}`)}>
              <i className="ti ti-checks" /> Enable all
            </button>
            <button className="btn btn-xs btn-danger" type="button" disabled={busy || allOff}
              onClick={() => apply(() => adminSetUserEmailApi(row.id!, null, true), `All emails off for ${row.email}`)}>
              <i className="ti ti-ban" /> Disable all
            </button>
          </div>
        </div>

        {masterOff && (
          <div className="info-box" style={{ margin: '6px 0 4px', fontSize: 12.5 }}>
            <i className="ti ti-power" /> The master switch is off, so nothing is sent to anyone right now.
            Below is what will happen for this account once it is on.
          </div>
        )}

        <div>
          {EMAIL_TYPES.map(t => {
            const eff = effectiveState(t, view, rowConfig);
            const on = !blocked.includes(t.key);
            return (
              <div className="em-row" key={t.key}>
                <div className="em-ico" style={{ color: TONE_COLOR[eff.tone] }}><i className={`ti ${t.icon}`} /></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 13 }}>
                    {t.label}
                    <InfoTip label={`What is ${t.label}?`}><strong>{t.label}</strong>{t.what}<br /><br /><strong>When</strong>{t.when}</InfoTip>
                  </div>
                  <div className="em-state" style={{ color: eff.tone === 'on' ? 'var(--green)' : 'var(--text2)', whiteSpace: 'nowrap' }}>
                    <span className="em-dot" style={{ background: TONE_COLOR[eff.tone] }} /> {eff.label}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.4 }}>{eff.detail}</div>
                </div>
                <Switch
                  checked={on} disabled={busy} label={`${t.label} for ${row.email}`}
                  onChange={next => apply(() => adminSetUserEmailApi(row.id!, t.key, !next), `${t.label} ${next ? 'on' : 'off'} for ${row.email}`)}
                />
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '12px 0 0', lineHeight: 1.5 }}>
          The switch is your choice for this account only. An email still needs the master switch and its app-wide
          switch to be on, and the user’s own opt-out always wins. Turning a switch on never sends what was missed.
        </p>
      </div>
    </div>,
    document.body,
  );
}
