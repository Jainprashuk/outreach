import { useCallback, useEffect, useState } from 'react';
import {
  adminEmailLogApi, adminUpcomingEmailsApi,
  type AdminUpcomingEmails, type EmailVerdict, type LifecycleLogRow, type UpcomingEmail,
} from '../lib/api';
import { EMAIL_TYPES } from '../lib/lifecycleTypes';
import InfoTip from './InfoTip';

// Plain-language versions of lib/lifecycle/gate.js REASONS, short enough for a badge.
const REASON: Record<string, string> = {
  'master-off': 'Master switch off',
  'type-off': 'Type off app-wide',
  'user-blocked': 'Off for this user',
  'opted-out': 'User opted out',
  disabled: 'Account disabled',
  'sender-not-configured': 'Sender not set up',
  'links-not-configured': 'App URL not set',
  'test-mode': 'Test mode: recorded only',
  'test-mode-no-recipient': 'Test mode: no recipient',
  'not-due': 'Not due yet',
  'no-user': 'Account deleted',
  quiet: 'Quiet week',
};
const MISSING: Record<string, string> = { gmail: 'Gmail', identity: 'name' };

const ist = (v: string | Date, opts: Intl.DateTimeFormatOptions) =>
  new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
const dayTime = (v: string) => ist(v, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const day = (v: string) => ist(v, { day: 'numeric', month: 'short' });
const typeMeta = (t: string) => EMAIL_TYPES.find(x => x.key === t);

function verdictBadge(v: EmailVerdict) {
  if (v.send) return <span className="badge badge-sent">{v.testMode ? 'Will send (test mode)' : 'Will send'}</span>;
  const r = v.reason || '';
  const cls = r === 'opted-out' || r === 'user-blocked' ? 'badge-pending'
    : r.startsWith('test-mode') ? 'badge-queued'
      : r === 'master-off' || r === 'type-off' || r === 'not-due' ? 'badge-closed' : 'badge-rejected';
  return <span className={`badge ${cls}`}>{REASON[r] || r}</span>;
}

function detailOf(i: UpcomingEmail) {
  if (i.type === 'setup-reminder') return `Still missing: ${(i.missing || []).map(m => MISSING[m] || m).join(' + ') || 'finishing the wizard'}`;
  if (i.type === 'inactive' && i.since) return `Quiet since ${dayTime(i.since)}`;
  if (i.type === 'weekly-report' && i.period) return `Week of ${day(i.period.from)} – ${day(new Date(new Date(i.period.to).getTime() - 1).toISOString())}`;
  return '';
}

function TypeCell({ type }: { type: string }) {
  const t = typeMeta(type);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <i className={`ti ${t?.icon || 'ti-mail'}`} style={{ color: 'var(--text2)' }} />{t?.label || type}
    </span>
  );
}

function Account({ email, name }: { email: string; name: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{email}</div>
      {name && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{name}</div>}
    </div>
  );
}

/** Next few days of lifecycle emails, from the same forecast the preview script prints. */
function Upcoming() {
  const [days, setDays] = useState(3);
  const [data, setData] = useState<AdminUpcomingEmails | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try { setData(await adminUpcomingEmailsApi(d)); setError(''); } catch (e: any) { setError(e.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(days); }, [load, days]);

  const total = data ? data.runs.reduce((n, r) => n + r.items.length, 0) : 0;
  const willSend = data ? data.runs.reduce((n, r) => n + r.items.filter(i => i.now.send).length, 0) : 0;

  return (
    <div className="an-card" style={{ marginTop: 16 }}>
      <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="an-card-title">
            <i className="ti ti-calendar-time" /> Coming up
            <InfoTip label="How is this worked out?">
              <strong>The same check the scheduler runs</strong>
              Each row is someone the daily (10:00 IST) or Monday (09:00 IST) check would pick up, run through the
              same switches that decide a real send. Later days assume nobody visits or finishes setup in between,
              so treat them as an upper bound. Nothing here sends anything.
            </InfoTip>
          </div>
          <div className="an-card-sub">
            {data ? <>{total} email{total === 1 ? '' : 's'} fall due in the next {data.days} days; {willSend} will actually send with the switches as they are.</> : 'Loading…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div className="seg-toggle">
            {[3, 7].map(d => (
              <button key={d} type="button" className={`btn btn-xs${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
                {d === days && loading && data && <i className="ti ti-loader" aria-hidden="true" />}{d} days
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-xs" onClick={() => load(days)} disabled={loading} aria-label="Refresh">
            <i className="ti ti-refresh" />
          </button>
        </div>
      </div>
      <div className="an-card-body">
        {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 120 }} />}
        {data && !data.masterOn && (
          <div className="info-box" style={{ marginBottom: 14 }}>
            <strong>The master switch is off, so none of these will be sent.</strong>{' '}
            The “If switched on” column shows what would happen if you turned it on now, with every other switch as it is.
          </div>
        )}
        {data && data.runs.map(run => (
          <div key={run.at} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 13 }}>{dayTime(run.at)} IST</strong>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                {run.kind === 'weekly' ? 'Weekly report check' : run.kind === 'admin-daily' ? 'Daily admin digest' : 'Daily check: setup reminders and inactivity'}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
                {run.items.length ? `${run.items.length} due` : 'nobody due'}
              </span>
            </div>
            {run.items.length > 0 && (
              <div className="table-card" style={{ marginTop: 6, boxShadow: 'none' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Account</th><th>Email</th><th>Why</th>
                      <th>{data.masterOn ? 'Will it send?' : 'Now'}</th>
                      {!data.masterOn && <th>If switched on</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {run.items.map(i => (
                      <tr key={`${i.userId}|${i.type}`}>
                        <td><Account email={i.email} name={i.name} /></td>
                        <td><TypeCell type={i.type} /></td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{detailOf(i)}</td>
                        <td>{verdictBadge(data.masterOn ? i.now : { send: false, reason: 'master-off', testMode: false })}</td>
                        {!data.masterOn && <td>{verdictBadge(i.ifOn)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {data && (
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0' }}>
            <i className="ti ti-confetti" /> Welcome emails go out the moment someone finishes setup, so they have no fixed time.{' '}
            {data.midSetup.length
              ? <>{data.midSetup.length} account{data.midSetup.length === 1 ? ' is' : 's are'} mid-setup and would get one on finishing: {data.midSetup.map(u => u.email).join(', ')}.</>
              : 'Nobody is mid-setup right now.'}
          </p>
        )}
      </div>
    </div>
  );
}

/** Every lifecycle email slot ever claimed, newest first. */
function History() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<LifecycleLogRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const r = await adminEmailLogApi({ type, status, before });
      setRows(prev => (before ? [...prev, ...r.rows] : r.rows));
      setNext(r.next);
      setError('');
    } catch (e: any) { setError(e.message || 'Could not load'); }
    finally { setLoading(false); }
  }, [type, status]);
  useEffect(() => { load(null); }, [load]);

  const result = (r: LifecycleLogRow) => {
    if (r.status === 'sent') return <span className="badge badge-sent">{r.testMode ? 'Sent (test mode)' : 'Sent'}</span>;
    if (r.status === 'failed') return <span className="badge badge-rejected">Failed</span>;
    if (r.status === 'claimed') return <span className="badge badge-queued">Sending…</span>;
    return <span className="badge badge-closed">Skipped{r.reason ? `: ${(REASON[r.reason] || r.reason).toLowerCase()}` : ''}</span>;
  };

  return (
    <div className="an-card" style={{ marginTop: 16 }}>
      <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="an-card-title"><i className="ti ti-history" /> History</div>
          <div className="an-card-sub">Every lifecycle email that fell due, newest first: sent, skipped (and why) or failed. A skipped email is never sent late.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select id="email-log-type" className="login-input" style={{ padding: '4px 8px', fontSize: 12.5, width: 'auto' }}
            value={type} onChange={e => setType(e.target.value)} aria-label="Filter by email">
            <option value="">All emails</option>
            {EMAIL_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <select id="email-log-status" className="login-input" style={{ padding: '4px 8px', fontSize: 12.5, width: 'auto' }}
            value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by result">
            <option value="">Any result</option>
            <option value="sent">Sent</option>
            <option value="skipped">Skipped</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>
      <div className="an-card-body">
        {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
        {!error && rows.length === 0 && (loading
          ? <div className="skeleton" style={{ height: 80 }} />
          : <div className="an-empty">{type || status ? 'Nothing matches these filters.' : 'No lifecycle email has fallen due yet.'}</div>)}
        {rows.length > 0 && (
          <div className="table-card" style={{ boxShadow: 'none' }}>
            <table>
              <thead><tr><th>When</th><th>Account</th><th>Email</th><th>Result</th><th>About</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{dayTime(r.sentAt || r.updatedAt || r.createdAt)}</td>
                    <td><Account email={r.email} name={r.name} /></td>
                    <td><TypeCell type={r.type} /></td>
                    <td>{result(r)}{r.attempts > 1 && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{r.attempts} attempts</div>}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                      {r.about ? (r.type === 'weekly-report' ? `Week of ${day(r.about)}` : `Quiet since ${day(r.about)}`) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={loading} onClick={() => load(next)}>
              {loading ? <><i className="ti ti-loader" /> Loading…</> : 'Load older'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminEmailSchedule() {
  return (
    <>
      <Upcoming />
      <History />
    </>
  );
}
