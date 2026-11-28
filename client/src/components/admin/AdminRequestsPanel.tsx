// Admin → Access requests. People who tried to sign in and weren't on the list.
import { Refreshing } from '../RefreshBar';
import Avatar from '../Avatar';
import { fmtAgo } from '../../lib/analytics';
import { approveAccessApi, rejectAccessApi, clearAccessRequestApi, type AccessRequestRow } from '../../lib/api';

export default function AdminRequestsPanel({ requests, filter, setFilter, loading, pending, busyId, decide, onAddDirectly }: {
  requests: AccessRequestRow[];
  filter: 'pending' | 'all';
  setFilter: (f: 'pending' | 'all') => void;
  loading: boolean;
  pending: number;
  busyId: string | null;
  decide: (row: AccessRequestRow, fn: () => Promise<any>, done: string) => void;
  onAddDirectly: () => void;
}) {
  return (
    <div className="an-card">
      <div className="an-card-head adm-card-head">
        <div>
          <div className="an-card-title">
            <i className="ti ti-inbox" /> Access requests
            {pending > 0 && <span className="adm-pill warn">{pending}</span>}
          </div>
          <div className="an-card-sub">
            Approving one creates their account and emails them; declining is final, and they are not emailed.
          </div>
        </div>
        <div className="seg-toggle" role="group" aria-label="Show">
          {(['pending', 'all'] as const).map(f => (
            <button key={f} type="button" className={`btn btn-xs${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'pending' ? 'Pending' : 'All'}
            </button>
          ))}
        </div>
      </div>
      <div className="an-card-body">
        <Refreshing active={loading}>
          {requests.length === 0 ? (
            <div className="an-empty">
              <i className="ti ti-inbox-off" />
              {filter === 'pending' ? 'Nothing waiting.' : 'No requests yet.'}{' '}
              <button type="button" className="adm-linkbtn" onClick={onAddDirectly}>Add someone directly</button>
            </div>
          ) : requests.map(r => (
            <div className="adm-req" key={r.id}>
              <Avatar name={r.name || r.email} />
              <div className="adm-req-body">
                <div className="adm-req-who">
                  {r.email}
                  {r.name && <span className="nm">· {r.name}</span>}
                  {r.status !== 'pending' && (
                    <span className={`badge ${r.status === 'approved' ? 'badge-sent' : 'badge-rejected'}`}>{r.status}</span>
                  )}
                  {r.requestCount > 1 && <span className="badge badge-pending">asked {r.requestCount}×</span>}
                </div>
                {/* Free text from a stranger. React escapes it; it is never
                    inserted as HTML anywhere. */}
                {r.note && <div className="adm-req-note">{r.note}</div>}
                <div className="adm-req-meta">{r.createdAt ? fmtAgo(new Date(r.createdAt).getTime()) : '—'}</div>
              </div>
              <div className="adm-req-actions">
                {r.status === 'pending' ? (
                  <>
                    <button
                      className="btn btn-sm btn-success" type="button" disabled={busyId === r.id}
                      onClick={() => decide(r, () => approveAccessApi(r.id), `${r.email} approved`)}
                    ><i className="ti ti-check" /> Approve</button>
                    <button
                      className="btn btn-sm btn-danger" type="button" disabled={busyId === r.id}
                      onClick={() => {
                        if (!window.confirm(`Decline ${r.email}? They are told plainly, and asking again will not reopen it.`)) return;
                        decide(r, () => rejectAccessApi(r.id), `${r.email} declined`);
                      }}
                    >Decline</button>
                  </>
                ) : (
                  <button
                    className="btn btn-xs" type="button" disabled={busyId === r.id}
                    title={r.status === 'rejected'
                      ? 'Remove this row. That address can then ask again.'
                      : 'Remove this row from the list.'}
                    onClick={() => decide(r, () => clearAccessRequestApi(r.id), 'Cleared')}
                  >Clear</button>
                )}
              </div>
            </div>
          ))}
        </Refreshing>
      </div>
    </div>
  );
}
