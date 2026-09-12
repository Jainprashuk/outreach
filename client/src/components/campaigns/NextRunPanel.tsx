import { useEffect, useState } from 'react';
import type { Campaign } from '../../lib/api';
import {
  batchEndsAt, dueSince, fmtCountdown, fmtIst, nextRunAt, projectedFinish,
} from '../../lib/campaigns';

/**
 * When the next batch actually goes out, with a live countdown.
 *
 * Times are stated in IST because that is the zone the schedule itself is
 * defined in — showing them in the viewer's local zone would make the number
 * disagree with the hour set in Setup.
 */
export default function NextRunPanel({ campaign, cronConfigured }: {
  campaign: Campaign;
  cronConfigured?: boolean;
}) {
  // Re-render every second so the countdown ticks.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const next = nextRunAt(campaign);
  const due = dueSince(campaign);

  if (campaign.status === 'completed') {
    return (
      <div className="info-box" style={{ background: 'var(--green-bg)', color: 'var(--green)' }}>
        <i className="ti ti-circle-check" />
        <span>Finished — there are no more batches to send.</span>
      </div>
    );
  }

  if (campaign.status === 'paused' || campaign.status === 'failed') {
    return (
      <div className="info-box" style={{ background: 'var(--amber-bg)', color: 'var(--amber)' }}>
        <i className="ti ti-player-pause" />
        <span>
          No batch is scheduled while the campaign is {campaign.status === 'paused' ? 'paused' : 'stopped'}.
          Continue it and the next release happens at {String(campaign.runHourIst).padStart(2, '0')}:35 IST.
        </span>
      </div>
    );
  }

  // Overdue is its own state. Counting down to the next hourly slot made a
  // waiting batch look like a schedule sliding forward an hour every hour.
  if (due) {
    return (
      <div className="info-box" style={{ display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <i className="ti ti-player-play" style={{ fontSize: 18 }} />
          <span style={{ fontSize: 13 }}>
            <strong>This batch is due</strong> — it was ready at {fmtIst(due)}
          </span>
          <span className="badge badge-pending" title="Waiting for the scheduled job to fire">
            waiting {fmtCountdown(Date.now() - due.getTime())}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, lineHeight: 1.7 }}>
          It goes out on the next trigger, which GitHub runs when it has capacity — often hours
          after the scheduled time. Nothing is wrong and nothing is lost; the batch has not been
          skipped. Use <strong>Run now</strong> if you do not want to wait.
        </div>
      </div>
    );
  }

  if (!next) return null;

  const ms = next.getTime() - Date.now();
  const ends = batchEndsAt(next, campaign.contactsPerDay, campaign.ratePerHour);
  const finish = projectedFinish(campaign);

  return (
    <div className="info-box" style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <i className={due ? 'ti ti-player-play' : 'ti ti-clock-play'} style={{ fontSize: 18 }} />
        <span style={{ fontSize: 13 }}>
          <strong>Next batch</strong> — {fmtIst(next)}
        </span>
        <span
          className="badge badge-sent"
          style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}
          title="Counts down to the scheduled release"
        >
          in {fmtCountdown(ms)}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, lineHeight: 1.7 }}>
        {campaign.contactsPerDay} contacts, one every {Math.round(60 / Math.max(1, campaign.ratePerHour))} minutes —
        the last one lands about <strong>{fmtIst(ends)}</strong>.
        {finish && <> At this pace the sheet finishes around <strong>{fmtIst(finish).replace(/,.*/, '')}</strong>.</>}
        {/* The schedule is a cron, not a promise — say so rather than letting a
            precise-looking countdown imply a guarantee. */}
        <div style={{ color: 'var(--text3)', marginTop: 4 }}>
          This is the earliest the batch can go out, not a guarantee. Releases are triggered by a
          scheduled job that GitHub runs when it has capacity — often hours late — so the batch goes
          out on the first trigger at or after the time above. An early send hour leaves more of the
          day for one to land.
          {cronConfigured === false && (
            <strong style={{ color: 'var(--amber)' }}>
              {' '}CRON_SECRET isn't configured, so nothing will fire on its own — use “Run now”.
            </strong>
          )}
        </div>
      </div>
    </div>
  );
}
