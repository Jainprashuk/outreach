// Labels, badges and the two reminder rules for the Interviews store.
// Pure functions only — nothing here fetches or mutates.
import type { Interview, InterviewMode, InterviewStatus, WorkMode } from './api';

export const INTERVIEW_STATUS_ORDER: InterviewStatus[] = [
  'initial-discussion', 'asked-to-schedule', 'scheduled', 'in-process', 'selected', 'rejected',
];

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  'initial-discussion': 'Initial Discussion',
  'asked-to-schedule':  'Asked to Schedule Interview',
  'scheduled':          'Interview Scheduled',
  'in-process':         'Interviews in Process',
  'selected':           'Selected',
  'rejected':           'Rejected',
};

/** Written into statusHistory by "Mark followed up" — a touch, not a status. */
export const FOLLOWED_UP = 'followed-up';

export const historyLabel = (s: string) =>
  s === FOLLOWED_UP ? 'Followed up' : (INTERVIEW_STATUS_LABELS[s as InterviewStatus] || s);

export const historyBadgeClass = (s: string) =>
  s === FOLLOWED_UP ? 'badge-closed' : (INTERVIEW_BADGE_CLASS[s as InterviewStatus] || 'badge-queued');

export const INTERVIEW_BADGE_CLASS: Record<InterviewStatus, string> = {
  'initial-discussion': 'badge-queued',
  'asked-to-schedule':  'badge-pending',
  'scheduled':          'badge-inreview',
  'in-process':         'badge-iv-process',
  'selected':           'badge-sent',
  'rejected':           'badge-rejected',
};

/** Nothing left to chase — excluded from both reminders. */
export const TERMINAL_STATUSES: InterviewStatus[] = ['selected', 'rejected'];
export const isTerminal = (iv: Interview) => TERMINAL_STATUSES.includes(iv.status);

export const MODE_LABELS: Record<InterviewMode, string> = {
  '': 'Not set', call: 'Phone call', video: 'Video call', onsite: 'On-site',
};

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  '': 'Not set', remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site',
};

export const MODE_ICON: Record<InterviewMode, string> = {
  '': 'ti-help-circle', call: 'ti-phone', video: 'ti-video', onsite: 'ti-building',
};

// ── Reminder rule 1: nothing has happened in three days ──────────────────────

export const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Stale = an interview still in play whose lastActivityAt is 3+ days old.
 * Only lastActivityAt is consulted, so merely opening the record never resets
 * the clock — you have to change something or click "Mark followed up".
 */
export const isStale = (iv: Interview, now = Date.now()) =>
  !isTerminal(iv) && now - new Date(iv.lastActivityAt).getTime() >= STALE_MS;

export const daysSinceActivity = (iv: Interview, now = Date.now()) =>
  Math.floor((now - new Date(iv.lastActivityAt).getTime()) / (24 * 60 * 60 * 1000));

// ── Reminder rule 2: the interview is tomorrow or today ──────────────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole calendar days from today to `iso`. 0 = today, 1 = tomorrow, -1 = yesterday. */
export const calendarDaysUntil = (iso: string, now = new Date()): number => {
  const target = startOfDay(new Date(iso));
  const today = startOfDay(now);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
};

/**
 * Due = a scheduled interview happening tomorrow or today, still in play.
 * It keeps showing for the whole of the interview day rather than vanishing the
 * moment the slot passes — a time typed as 00:00 (or a slot that ran late)
 * shouldn't silently drop off the reminder before the day is out.
 */
export function isInterviewSoon(iv: Interview, now = new Date()): boolean {
  if (isTerminal(iv) || !iv.interviewAt) return false;
  const days = calendarDaysUntil(iv.interviewAt, now);
  return days === 0 || days === 1;
}

/** "Today at 02:30 PM" / "Tomorrow at 10:00 AM" / "Sep 14, 10:00 AM". */
export function whenLabel(iso: string | null, now = new Date()): string {
  if (!iso) return 'Not scheduled';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const days = calendarDaysUntil(iso, now);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`;
}

// ── Sweeps used by the reminder popup and the nav badge ──────────────────────

export interface ReminderSet {
  soon: Interview[];   // interview tomorrow or today
  stale: Interview[];  // no update in 3+ days
}

/**
 * An interview that is both due tomorrow AND untouched for a week belongs in the
 * "soon" list only — being reminded twice about the same person is noise, and
 * the imminent date is the more urgent fact.
 */
export function collectReminders(interviews: Interview[], now = new Date()): ReminderSet {
  const soon = interviews.filter(iv => isInterviewSoon(iv, now));
  const soonIds = new Set(soon.map(iv => iv.id));
  const stale = interviews.filter(iv => !soonIds.has(iv.id) && isStale(iv, now.getTime()));
  // Soonest first; longest-ignored first.
  soon.sort((a, b) => new Date(a.interviewAt!).getTime() - new Date(b.interviewAt!).getTime());
  stale.sort((a, b) => new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime());
  return { soon, stale };
}

/**
 * The reverse of toLocalInputValue: a datetime-local value carries no timezone,
 * so it MUST be resolved to an absolute instant in the browser, where "local"
 * means the user's clock. Sending the bare 'YYYY-MM-DDTHH:mm' would let the
 * server parse it in ITS zone — UTC on Vercel — silently shifting every
 * interview time by the user's offset.
 */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `<input type="datetime-local">` needs a LOCAL 'YYYY-MM-DDTHH:mm', not an ISO UTC string. */
export function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
