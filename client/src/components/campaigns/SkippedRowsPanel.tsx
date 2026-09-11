import { useEffect, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { toDelimitedText, downloadTextFile } from '../../lib/csv';
import {
  loadCampaignRowsApi, restoreCampaignRowsApi, type Campaign, type CampaignRow,
} from '../../lib/api';
import { SKIP_REASON_BADGE, SKIP_REASON_LABEL } from '../../lib/campaigns';

/** Rows that never became contacts, and why. */
export default function SkippedRowsPanel({ campaign, status, onChanged }: {
  campaign: Campaign;
  status: 'skipped' | 'removed';
  onChanged: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await loadCampaignRowsApi(campaign.id, { status, limit: '500' });
    setRows(res.rows);
  };
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, [campaign.id, status, campaign.stats.skipped, campaign.stats.removed]);

  // Reuses the existing CSV export helpers verbatim, so a rejected row can be
  // fixed in the sheet and re-uploaded as its own campaign.
  function exportCsv() {
    if (!rows || rows.length === 0) return;
    const text = toDelimitedText(
      ['Name', 'Email', 'Company', 'Role', 'Reason', 'Sheet row'],
      rows.map((r) => [r.name, r.email, r.company, r.role,
        r.skipReason ? SKIP_REASON_LABEL[r.skipReason] : '', String(r.sourceRow)]),
      ',',
    );
    downloadTextFile(`${campaign.name.replace(/[^\w-]+/g, '-')}-${status}.csv`, text, 'text/csv');
  }

  async function restore(ids: string[]) {
    setBusy(true);
    try {
      const { restored } = await restoreCampaignRowsApi(campaign.id, ids);
      toast(`${restored} put back into the campaign.`, 'success');
      await load();
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  }

  if (rows === null) return <div className="empty-state"><i className="ti ti-loader-2" /> Loading…</div>;
  if (rows.length === 0) {
    // A campaign that has never released has nothing recorded here yet, even
    // though the Upcoming preview may already be reporting duplicates. The
    // preview is a pure read — it deliberately writes nothing — so saying only
    // "nothing has been skipped" would contradict the other tab.
    const neverRan = (campaign.releases || []).length === 0;
    return (
      <div className="empty-state">
        <i className="ti ti-circle-check" />
        {status === 'removed' ? (
          "You haven't removed anyone."
        ) : neverRan ? (
          <div style={{ maxWidth: 560 }}>
            Nothing recorded here yet — no batch has run.
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8, lineHeight: 1.6 }}>
              Rows are only marked skipped when a batch actually runs. Anything the Upcoming tab
              reports as a duplicate is still queued and untouched until then.
            </div>
          </div>
        ) : (
          'Nothing has been skipped.'
        )}
      </div>
    );
  }

  return (
    <>
      <div className="section-head">
        <span style={{ fontSize: 12, color: 'var(--text2)' }}>
          {rows.length.toLocaleString()} {status === 'skipped' ? 'skipped' : 'removed'} rows
        </span>
        <button className="btn btn-sm" type="button" onClick={exportCsv}>
          <i className="ti ti-file-export" /> Download as CSV
        </button>
      </div>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th style={{ width: 160 }}>Company</th>
              <th style={{ width: 190 }}>Why</th><th style={{ width: 80 }}>Row</th>
              {status === 'removed' && <th style={{ width: 110 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name || '—'}</td>
                <td>{r.email || <em style={{ color: 'var(--text3)' }}>(blank)</em>}</td>
                <td>{r.company || '—'}</td>
                <td>
                  {r.skipReason
                    ? <span className={`badge ${SKIP_REASON_BADGE[r.skipReason]}`}>{SKIP_REASON_LABEL[r.skipReason]}</span>
                    : '—'}
                </td>
                <td style={{ color: 'var(--text3)' }}>{r.sourceRow}</td>
                {status === 'removed' && (
                  <td>
                    <button className="btn btn-xs" type="button" disabled={busy} onClick={() => restore([r.id])}>
                      <i className="ti ti-arrow-back-up" /> Put back
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
