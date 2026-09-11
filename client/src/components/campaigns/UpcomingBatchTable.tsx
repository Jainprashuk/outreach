import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Avatar from '../Avatar';
import { useToast } from '../../context/ToastContext';
import {
  previewCampaignApi, removeCampaignRowsApi, type Campaign, type CampaignPreview,
} from '../../lib/api';
import { SKIP_REASON_BADGE, SKIP_REASON_LABEL, fmtHour } from '../../lib/campaigns';

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
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cbRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      setPreview(await previewCampaignApi(campaign.id));
      setSelected(new Set());
    } catch (err) {
      toast((err as Error).message, 'error');
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

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <i className="ti ti-inbox" />
        Nothing left to release{preview?.exhausted ? ' — the sheet is used up.' : '.'}
      </div>
    );
  }

  return (
    <>
      <div className="info-box" style={{ marginBottom: 12 }}>
        <i className="ti ti-clock" />
        <span>
          These <strong>{rows.length}</strong> go out{' '}
          {campaign.status === 'running'
            ? <>on the next release at <strong>{fmtHour(campaign.runHourIst)} IST</strong>, one every {minutesApart} minutes</>
            : <>when you continue the campaign</>}
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
