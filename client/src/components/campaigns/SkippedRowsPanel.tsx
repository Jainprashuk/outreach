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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const PAGE_SIZE = 100;
  // The endpoint caps a page at 500. Reading one page and calling its length the
  // total is what made 1,754 skipped rows report as "500 skipped rows".
  const FETCH_MAX = 500;

  const load = async (p = page) => {
    const res = await loadCampaignRowsApi(campaign.id, {
      status, page: String(p), limit: String(PAGE_SIZE),
    });
    setRows(res.rows);
    setTotal(res.total);
    setPages(Math.max(1, res.pages));
  };
  useEffect(() => { load(page).catch((e) => toast(e.message, 'error')); },
    [campaign.id, status, page, campaign.stats.skipped, campaign.stats.removed]);
  // A status switch must not land the user on a page that no longer exists.
  useEffect(() => { setPage(1); }, [status]);

  // Reuses the existing CSV export helpers verbatim, so a rejected row can be
  // fixed in the sheet and re-uploaded as its own campaign.
  //
  // Pages through EVERYTHING rather than exporting the rows currently on screen:
  // a file silently missing 1,254 of 1,754 rows is worse than no file at all.
  async function exportCsv() {
    if (total === 0) return;
    setExporting(true);
    try {
      const all: CampaignRow[] = [];
      for (let p = 1; ; p++) {
        const res = await loadCampaignRowsApi(campaign.id, {
          status, page: String(p), limit: String(FETCH_MAX),
        });
        all.push(...res.rows);
        if (res.rows.length < FETCH_MAX || all.length >= res.total) break;
      }
      const text = toDelimitedText(
        ['Name', 'Email', 'Company', 'Role', 'Reason', 'Sheet row'],
        all.map((r) => [r.name, r.email, r.company, r.role,
          r.skipReason ? SKIP_REASON_LABEL[r.skipReason] : '', String(r.sourceRow)]),
        ',',
      );
      downloadTextFile(`${campaign.name.replace(/[^\w-]+/g, '-')}-${status}.csv`, text, 'text/csv');
      toast(`Exported ${all.length.toLocaleString()} rows.`, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setExporting(false);
    }
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
          {total.toLocaleString()} {status === 'skipped' ? 'skipped' : 'removed'} rows
          {pages > 1 && (
            <span style={{ color: 'var(--text3)' }}>
              {' '}· showing {rows.length.toLocaleString()} on this page
            </span>
          )}
        </span>
        <button className="btn btn-sm" type="button" onClick={exportCsv} disabled={exporting}>
          {exporting
            ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Exporting…</>
            : <><i className="ti ti-file-export" /> Download all as CSV</>}
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

      {pages > 1 && (
        <div className="pagination-bar">
          <button className="btn btn-sm" type="button" disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}>
            <i className="ti ti-chevron-left" /> Prev
          </button>
          <span className="page-info">Page {page} of {pages}</span>
          <button className="btn btn-sm" type="button" disabled={page === pages}
            onClick={() => setPage((p) => p + 1)}>
            Next <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}
    </>
  );
}
