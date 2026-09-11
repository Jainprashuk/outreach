import type { Campaign } from '../../lib/api';
import {
  fmtCountdown, fmtIst, projectSchedule, totalBatches, batchEndsAt,
} from '../../lib/campaigns';

/** Every remaining batch, projected forward from the next release. */
export default function UpcomingSchedule({ campaign }: { campaign: Campaign }) {
  const MAX_SHOWN = 60;
  const schedule = projectSchedule(campaign, MAX_SHOWN);
  const total = totalBatches(campaign);

  if (campaign.status === 'completed') {
    return (
      <div className="empty-state">
        <i className="ti ti-circle-check" /> This campaign has finished — nothing further is scheduled.
      </div>
    );
  }

  if (schedule.length === 0) {
    return (
      <div className="empty-state">
        <i className="ti ti-calendar-off" />
        {campaign.status === 'running'
          ? 'Nothing left to schedule — every row has been dealt with.'
          : `No batches are scheduled while the campaign is ${campaign.status}.`}
      </div>
    );
  }

  const last = schedule[schedule.length - 1];

  return (
    <>
      <div className="info-box" style={{ marginBottom: 12 }}>
        <i className="ti ti-calendar-repeat" />
        <span>
          <strong>{total.toLocaleString()}</strong> more {total === 1 ? 'batch' : 'batches'} at{' '}
          {campaign.contactsPerDay}/day.
          {/* A projection, not a delivery date — every row here depends on a
              trigger landing that day, and GitHub's scheduler is not reliable
              enough for that to be stated as fact. */}
          {' '}This assumes a trigger lands every day and that no further rows turn out to be
          duplicates, so treat the later dates as an estimate.
        </span>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 70 }}>Batch</th>
              <th style={{ width: 230 }}>Starts</th>
              <th style={{ width: 110 }}>Contacts</th>
              <th style={{ width: 170 }}>Last email ~</th>
              <th>Progress after it</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((b) => {
              const ms = b.date.getTime() - Date.now();
              const pct = Math.round((b.cumulative / Math.max(1, campaign.stats.pending)) * 100);
              return (
                <tr key={b.index}>
                  <td style={{ color: 'var(--text3)' }}>#{b.index}</td>
                  <td>
                    <div>{fmtIst(b.date)}</div>
                    {b.index === 1 && ms > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--green)' }}>in {fmtCountdown(ms)}</div>
                    )}
                  </td>
                  <td>{b.count}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {fmtIst(batchEndsAt(b.date, b.count, campaign.ratePerHour)).replace(/^\w+ \d+ \w+, /, '')}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="progress-bar" style={{ flex: 1, maxWidth: 200 }}>
                        <div className="progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                        {b.cumulative.toLocaleString()} of {campaign.stats.pending.toLocaleString()}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {total > schedule.length && (
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10 }}>
          Showing the next {schedule.length} of {total.toLocaleString()} batches — the rest continue daily
          after {fmtIst(last.date).replace(/,.*/, '')}.
        </div>
      )}
    </>
  );
}
