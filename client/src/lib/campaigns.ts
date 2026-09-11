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

/** The next IST hour:00 at which this campaign would release. */
export const nextRunAt = (c: Campaign): Date | null => {
  if (c.status !== 'running') return null;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const todayKey = ist.toISOString().slice(0, 10);
  const alreadyToday = c.lastReleaseOn === todayKey;
  const dayOffset = alreadyToday || ist.getUTCHours() >= c.runHourIst ? 1 : 0;
  const target = new Date(Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (alreadyToday ? 1 : dayOffset),
    c.runHourIst, 0, 0,
  ));
  return new Date(target.getTime() - IST_OFFSET_MS);
};
