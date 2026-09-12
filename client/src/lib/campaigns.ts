// Pure display helpers for the Campaigns screens. No network, no React.

import type { Campaign, CampaignSkipReason, CampaignStatus, CampaignRowStatus } from './api';

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  completed: 'Finished',
  failed: 'Needs attention',
};

// Reuses the badge palette already defined in css/style.css — no new colours.
export const CAMPAIGN_STATUS_BADGE: Record<CampaignStatus, string> = {
  draft: 'badge-queued',
  running: 'badge-sent',
  paused: 'badge-pending',
  completed: 'badge-closed',
  failed: 'badge-rejected',
};

export const ROW_STATUS_BADGE: Record<CampaignRowStatus, string> = {
  pending: 'badge-queued',
  queued: 'badge-pending',
  released: 'badge-sent',
  skipped: 'badge-closed',
  removed: 'badge-rejected',
};

export const SKIP_REASON_LABEL: Record<CampaignSkipReason, string> = {
  blank_email: 'No email address',
  invalid_email: "Not an email address",
  duplicate_in_file: 'Duplicate in the file',
  duplicate_contact: 'Already in Contacts',
  removed_by_user: 'Removed by you',
  queue_failed: 'Could not be queued',
  render_empty: 'Template rendered empty',
};

export const SKIP_REASON_BADGE: Record<CampaignSkipReason, string> = {
  blank_email: 'badge-closed',
  invalid_email: 'badge-rejected',
  duplicate_in_file: 'badge-pending',
  duplicate_contact: 'badge-queued',
  removed_by_user: 'badge-rejected',
  queue_failed: 'badge-rejected',
  render_empty: 'badge-rejected',
};

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** "9:00 am", from an hour in IST. The server releases on this hour. */
export const fmtHour = (h: number) => {
  const hour = ((h % 24) + 24) % 24;
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${suffix}`;
};

/** How long one day's batch takes to finish at the configured drip rate. */
export const dripDuration = (contactsPerDay: number, ratePerHour: number) => {
  if (!(ratePerHour > 0) || !(contactsPerDay > 0)) return '';
  const mins = Math.round((contactsPerDay / ratePerHour) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** Whole days left at the current pace, given what is still pending. */
export const daysRemaining = (c: Campaign) => {
  const pending = c.stats?.pending || 0;
  if (pending <= 0) return 0;
  return Math.ceil(pending / Math.max(1, c.contactsPerDay));
};

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
};

export const fromNow = (iso: string | null | undefined) => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'never';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

// A running campaign that has not released in this long has probably lost its
// cron. GitHub disables scheduled workflows after 60 days of repo inactivity,
// and that silence is otherwise invisible — the same failure that left the
// mailbox cron doing nothing for months.
const STALE_MS = 36 * 60 * 60 * 1000;

export const isCronStale = (c: Campaign) =>
  c.status === 'running'
  && !!c.lastReleaseAt
  && Date.now() - new Date(c.lastReleaseAt).getTime() > STALE_MS;

// The workflow asks for ':05 past every UTC hour', but GitHub runs scheduled
// jobs when it has capacity, not at the requested minute — observed fires on
// this repo land at 00:29, 03:03, 05:24 IST and so on. So the trigger time
// cannot be predicted at all.
//
// What IS predictable is when a batch becomes RELEASABLE: the runner tests
// `runHourIst <= istHour()`, which is true from the top of the hour. Everything
// here is therefore expressed as "earliest releasable at runHourIst:00, then
// whenever a trigger next lands".
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * When the next batch will actually be released.
 *
 * Walks the real cron fire slots rather than assuming runHourIst:00, because two
 * things make that assumption wrong: fires land at :35, and if the hour has
 * already passed without a release the runner CATCHES UP on the very next fire
 * rather than waiting for tomorrow.
 */
export const nextRunAt = (c: Campaign): Date | null => {
  if (c.status !== 'running') return null;
  const now = Date.now();
  const ist = new Date(now + IST_OFFSET_MS);

  // Today, then tomorrow. Nothing further is needed: a campaign releases once a
  // day, so the next window is always within 48 hours.
  for (let d = 0; d <= 2; d++) {
    const slot = new Date(Date.UTC(
      ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + d, c.runHourIst, 0, 0,
    ));
    const at = slot.getTime() - IST_OFFSET_MS;
    if (at <= now) continue;
    if (c.lastReleaseOn === slot.toISOString().slice(0, 10)) continue;
    return new Date(at);
  }
  return null;
};

/**
 * True when the send hour has arrived and today's batch has not gone out.
 *
 * Once runHourIst:00 passes with nothing released the campaign is OVERDUE: it
 * goes out on whatever trigger lands next. Without this, nextRunAt rolled to the
 * following day the instant the hour passed, which read as the schedule sliding
 * away rather than a batch waiting to go.
 */
export const isDueNow = (c: Campaign): boolean => dueSince(c) !== null;

/**
 * When today's batch became releasable, or null if it is not due.
 *
 * The runner's test is `runHourIst <= istHour()`, so a batch is releasable from
 * the TOP of its hour. It does not wait for any particular minute.
 */
export const dueSince = (c: Campaign): Date | null => {
  if (c.status !== 'running') return null;
  if ((c.stats?.pending || 0) <= 0) return null;

  const ist = new Date(Date.now() + IST_OFFSET_MS);
  if (c.lastReleaseOn === ist.toISOString().slice(0, 10)) return null;

  const dueAt = Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), c.runHourIst, 0, 0,
  ) - IST_OFFSET_MS;
  return Date.now() >= dueAt ? new Date(dueAt) : null;
};

/** "2d 4h", "3h 12m", "45m 08s" — coarser the further away it is. */
export const fmtCountdown = (ms: number): string => {
  if (ms <= 0) return 'any moment';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
};

/** "Fri 11 Sep, 10:35 pm IST" — always stated in IST, the schedule's own zone. */
export const fmtIst = (d: Date): string => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][ist.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][ist.getUTCMonth()];
  const h24 = ist.getUTCHours();
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${day} ${ist.getUTCDate()} ${mon}, ${h12}:${String(ist.getUTCMinutes()).padStart(2, '0')} ${suffix} IST`;
};

/** When the last email of a batch lands, at the configured drip rate. */
export const batchEndsAt = (start: Date, contactsPerDay: number, ratePerHour: number): Date =>
  new Date(start.getTime() + Math.max(0, contactsPerDay - 1) * (3_600_000 / Math.max(1, ratePerHour)));

/** Projected final batch, assuming no missed days. */
export const projectedFinish = (c: Campaign): Date | null => {
  const next = nextRunAt(c);
  if (!next) return null;
  const batches = Math.ceil((c.stats?.pending || 0) / Math.max(1, c.contactsPerDay));
  if (batches <= 0) return null;
  return new Date(next.getTime() + (batches - 1) * 86_400_000);
};

export interface ScheduledBatch {
  date: Date;
  count: number;
  cumulative: number;
  index: number;    // 1-based batch number
}

/** How many batches are left at the current daily rate. */
export const totalBatches = (c: Campaign) =>
  Math.ceil((c.stats?.pending || 0) / Math.max(1, c.contactsPerDay));

/**
 * Project every remaining batch forward from the next release.
 *
 * A straight projection, not a promise: it assumes a trigger lands every day and
 * that no further rows turn out to be duplicates. Both can slip, so the UI
 * showing this must say so rather than presenting it as a delivery date.
 *
 * IST has no DST, so adding whole days keeps the same wall-clock hour.
 */
export function projectSchedule(c: Campaign, max = 60): ScheduledBatch[] {
  const first = nextRunAt(c);
  const pending = c.stats?.pending || 0;
  if (!first || pending <= 0) return [];

  const per = Math.max(1, c.contactsPerDay);
  const batches = Math.ceil(pending / per);
  const out: ScheduledBatch[] = [];
  let done = 0;

  for (let i = 0; i < Math.min(batches, max); i++) {
    const count = Math.min(per, pending - done);
    done += count;
    out.push({
      date: new Date(first.getTime() + i * 86_400_000),
      count,
      cumulative: done,
      index: i + 1,
    });
  }
  return out;
}
