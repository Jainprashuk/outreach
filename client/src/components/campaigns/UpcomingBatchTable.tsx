import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Avatar from '../Avatar';
import { useToast } from '../../context/ToastContext';
import {
  previewCampaignApi, removeCampaignRowsApi, type Campaign, type CampaignPreview,
} from '../../lib/api';
import { SKIP_REASON_BADGE, SKIP_REASON_LABEL, fmtCountdown, fmtIst, nextRunAt } from '../../lib/campaigns';

/**
 * The batch that goes out next, with the ability to pull anyone before it does.
 *
 * The rows come from the same dry-run scan the release uses, so what's listed
 * here is exactly who would be emailed — not an approximation of it.
 */
export default function UpcomingBatchTable({ campaign, onChanged }: {
  campaign: Campaign;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [deepScanning, setDeepScanning] = useState(false);
  const [deepScanned, setDeepScanned] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cbRef = useRef<HTMLInputElement>(null);

  /** Read the WHOLE sheet, not just far enough to fill one batch. */
  const deepScan = async () => {
    setDeepScanning(true);
    try {
      // want=400 raises the scan cap to 4,000 rows, which covers any sheet this
      // size. It stops early once it finds 400 sendable — enough either way to
      // answer the question.
      setPreview(await previewCampaignApi(campaign.id, 400));
      setDeepScanned(true);
      setLoadError('');
    } catch (err) {
      setLoadError((err as Error).message || 'The deeper scan could not finish');
    } finally {
      setDeepScanning(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      setPreview(await previewCampaignApi(campaign.id));
      setSelected(new Set());
      setLoadError('');
    } catch (err) {
      // Record it. Rendering a failed request as "nothing to release" would say
      // the opposite of what happened.
      setLoadError((err as Error).message || 'Could not work out the next batch');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [campaign.id, campaign.stats.released, campaign.stats.pending]);

  const rows = preview?.willRelease || [];
  const allChecked = rows.length > 0 && selected.size === rows.length;
  const someChecked = selected.size > 0 && !allChecked;
  useEffect(() => { if (cbRef.current) cbRef.current.indeterminate = someChecked; }, [someChecked]);

  const minutesApart = useMemo(
    () => Math.round(60 / Math.max(1, campaign.ratePerHour)),
    [campaign.ratePerHour],
  );

  async function remove(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const { removed } = await removeCampaignRowsApi(campaign.id, ids);
      toast(`${removed} ${removed === 1 ? 'contact' : 'contacts'} removed from the campaign.`, 'success');
      await load();
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading && !preview) {
    return <div className="empty-state"><i className="ti ti-loader-2" /> Working out who goes next…</div>;
  }

  if (campaign.status === 'completed') {
    return (
      <div className="empty-state">
        <i className="ti ti-circle-check" />
        This campaign has finished — every row in the sheet has been dealt with.
      </div>
    );
  }

  // A failed request is not an empty batch. Say which one happened.
  if (loadError || !preview) {
    return (
      <div className="empty-state">
        <i className="ti ti-alert-triangle" style={{ color: 'var(--red)' }} />
        <div style={{ marginBottom: 10 }}>
          Couldn't work out the next batch — {loadError || 'no response from the server'}.
          {campaign.stats.pending > 0 && <>
            {' '}Your {campaign.stats.pending.toLocaleString()} queued contacts are untouched.
          </>}
        </div>
        <button className="btn btn-sm" type="button" onClick={load}>
          <i className="ti ti-refresh" /> Try again
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    const breakdown = Object.entries(preview.skipBreakdown || {})
      .map(([reason, n]) => `${n} ${SKIP_REASON_LABEL[reason as keyof typeof SKIP_REASON_LABEL] || reason}`)
      .join(', ');
    return (
      <div className="empty-state">
        <i className={preview.timedOut ? 'ti ti-clock-exclamation' : 'ti ti-inbox'} />
        {preview.timedOut ? (
          <div style={{ marginBottom: 10 }}>
            Working out the next batch took too long, so this list is incomplete — it does{' '}
            <strong>not</strong> mean there is nothing to send. The scheduled release is unaffected.
          </div>
        ) : preview.exhausted ? (
          <div>Nothing left to release — every row in the sheet has been dealt with.</div>
        ) : preview.capped ? (
          <div style={{ marginBottom: 10 }}>
            Read {preview.scanned.toLocaleString()} rows without finding anyone sendable
            {breakdown ? <> — {breakdown}</> : null}.{' '}
            {preview.remainingPending.toLocaleString()} rows are still queued further down the sheet.
          </div>
        ) : (
          <div style={{ marginBottom: 10 }}>
            Nothing to release right now
            {breakdown ? <> — {breakdown} in the rows scanned</> : null}.
          </div>
        )}
        {preview.timedOut && (
          <button className="btn btn-sm" type="button" onClick={load}>
            <i className="ti ti-refresh" /> Try again
          </button>
        )}
        {preview.capped && !deepScanned && (
          <div>
            <button className="btn btn-sm btn-primary" type="button"
              disabled={deepScanning} onClick={deepScan}>
              {deepScanning
                ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Reading the whole sheet…</>
                : <><i className="ti ti-search" /> Scan the rest of the sheet</>}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
              Checks all {preview.remainingPending.toLocaleString()} remaining rows so you can see how many
              are genuinely new. Nothing is sent and nothing is changed.
            </div>
          </div>
        )}
        {deepScanned && preview.exhausted && (
          <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>
            Every row in this sheet is already in your Contacts — there is nobody new to email.
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="info-box" style={{ marginBottom: 12 }}>
        <i className="ti ti-clock" />
        <span>
          These <strong>{rows.length}</strong> go out{' '}
          {(() => {
            const n = nextRunAt(campaign);
            if (!n) return <>when you continue the campaign</>;
            const ms = n.getTime() - Date.now();
            return <>
              <strong>{fmtIst(n)}</strong>{ms > 0 && <> — in {fmtCountdown(ms)}</>}, one every {minutesApart} minutes
            </>;
          })()}
          . Removing someone here takes them out of the campaign entirely — they are never re-queued.
        </span>
      </div>

      {preview && preview.willSkip.length > 0 && (
        <div className="info-box" style={{ marginBottom: 12, background: 'var(--bg3)' }}>
          <i className="ti ti-filter" />
          <span>
            {preview.willSkip.length} rows were passed over to reach {rows.length} — we keep reading down the
            sheet so a day is never short.
          </span>
        </div>
      )}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th className="cb-col">
                <input type="checkbox" className="row-cb" ref={cbRef} checked={allChecked}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
              </th>
              <th>Contact</th>
              <th style={{ width: 170 }}>Company</th>
              <th style={{ width: 140 }}>Role</th>
              <th style={{ width: 90 }}>Sheet row</th>
              <th style={{ width: 110 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td className="cb-col">
                    <input type="checkbox" className="row-cb" checked={selected.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.id); else next.delete(r.id);
                        setSelected(next);
                      }} />
                  </td>
                  <td>
                    <div className="contact-chip">
                      <Avatar name={r.name} />
                      <div>
                        <div className="name">{r.name}</div>
                        <div className="email">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>{r.company || '—'}</td>
                  <td>{r.role || '—'}</td>
                  <td style={{ color: 'var(--text3)' }}>{r.row}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    {/* The exact subject/body that will send — same renderer, so
                        this is the email, not a preview of it. */}
                    <button className="btn btn-xs" type="button" title="See the email"
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <i className="ti ti-mail" />
                    </button>
                    <button className="btn btn-xs" type="button" disabled={busy}
                      title="Remove from the campaign" onClick={() => remove([r.id])}>
                      <i className="ti ti-trash" />
                    </button>
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg)', padding: 14 }}>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>Subject</div>
                      <div style={{ fontWeight: 500, marginBottom: 10 }}>{r.subject}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>Body</div>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>{r.body}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {preview && preview.willSkip.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text2)' }}>
            Show the {preview.willSkip.length} rows passed over for this batch
          </summary>
          <div className="table-card" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th style={{ width: 190 }}>Why</th><th style={{ width: 90 }}>Row</th></tr></thead>
              <tbody>
                {preview.willSkip.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name || '—'}</td>
                    <td>{s.email || <em style={{ color: 'var(--text3)' }}>(blank)</em>}</td>
                    <td><span className={`badge ${SKIP_REASON_BADGE[s.reason]}`}>{SKIP_REASON_LABEL[s.reason]}</span></td>
                    <td style={{ color: 'var(--text3)' }}>{s.sourceRow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className={`bulk-bar${selected.size > 0 ? ' visible' : ''}`}>
        <span className="bb-count">{selected.size} selected</span>
        <button className="btn btn-sm" type="button" onClick={() => setSelected(new Set())}>Clear</button>
        <button className="btn btn-sm btn-danger" type="button" disabled={busy}
          onClick={() => remove([...selected])}>
          <i className="ti ti-trash" /> Remove from campaign
        </button>
      </div>
    </>
  );
}
