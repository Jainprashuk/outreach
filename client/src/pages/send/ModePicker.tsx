// Send-mode picker modal — shared by Step1 (fresh entries) and Step3 (retry flows).
export type SendMode = 'sequential' | 'bulk' | 'drip';

export default function ModePicker({ open, mode, onPick, onConfirm, dripRate, onDripRateChange, showDripRate }: {
  open: boolean;
  mode: SendMode;
  onPick: (m: SendMode) => void;
  onConfirm: () => void;
  dripRate?: number;
  onDripRateChange?: (n: number) => void;
  showDripRate?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="mode-picker-wrap open">
      <div className="mode-picker">
        <h2>Choose send mode</h2>
        <p>How should emails be sent in this batch?</p>
        <div className="mode-options">
          <button className={`mode-option${mode === 'sequential' ? ' selected' : ''}`} onClick={() => onPick('sequential')} type="button">
            <div className="mo-icon"><i className="ti ti-send" /></div>
            <div className="mo-title">Sequential</div>
            <div className="mo-desc">One email every 1.5 s, separate SMTP connection per email. Can trigger Gmail's "Too many login attempts" on larger batches.</div>
            <span className="mo-badge warn">Risk of login errors</span>
          </button>
          <button className={`mode-option${mode === 'bulk' ? ' selected' : ''}`} onClick={() => onPick('bulk')} type="button">
            <div className="mo-icon"><i className="ti ti-bolt" /></div>
            <div className="mo-title">Bulk (fast)</div>
            <div className="mo-desc">Single pooled SMTP connection — authenticates once and sends all emails through it. No repeated logins, no rate-limit errors.</div>
            <span className="mo-badge">Recommended</span>
          </button>
          <button className={`mode-option${mode === 'drip' ? ' selected' : ''}`} onClick={() => onPick('drip')} type="button">
            <div className="mo-icon"><i className="ti ti-clock" /></div>
            <div className="mo-title">Drip</div>
            <div className="mo-desc">Sends emails gradually at your chosen rate (e.g. 5/hr). Runs in the background — safest for avoiding Gmail spam flags.</div>
            <span className="mo-badge" style={{ background: 'var(--green-bg)', color: 'var(--green)' }}>Spam-safe</span>
          </button>
        </div>
        {showDripRate && mode === 'drip' && (
          <div style={{ marginTop: 16, padding: 14, background: 'var(--bg2)', borderRadius: 'var(--radius-lg)', border: '0.5px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ margin: 0, minWidth: 140 }}>
                <label className="form-label">Emails per hour</label>
                <input type="number" value={dripRate ?? 5} min={1} max={60} style={{ width: 90 }}
                  onChange={e => onDripRateChange?.(parseInt(e.target.value) || 5)} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text2)', paddingTop: 18 }}>
                Rate is configured here — you can adjust it before sending too.
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-primary" onClick={onConfirm} type="button"><i className="ti ti-check" /> Continue</button>
        </div>
      </div>
    </div>
  );
}
