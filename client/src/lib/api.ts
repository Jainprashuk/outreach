import { loadLeadOutcomesSynced, loadLeadsSynced } from './leadCache';
// Port of the API layer from js/app.js — same endpoints, same semantics.

import { reportClientIssue } from './issueReporter';

// Always same-origin: Express serves the SPA at /app in prod, and the Vite dev
// server proxies /api → localhost:3000 in dev. Relative URLs work in both.
export const API_BASE = '';

export interface ActivityLog { id: string; category: string; action: string; message: string; meta: Record<string, unknown>; createdAt: string; }
export const loadActivityLogsApi = () => apiFetch<ActivityLog[]>('/api/logs?limit=200');

export type ContactStatus =
  | 'queued' | 'in-campaign' | 'sent' | 'follow-up-sent' | 'failed' | 'bounced'
  | 'replied' | 'follow-up-replied' | 'closed' | 'no-openings' | 'in-review' | 'blocked';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ReplyCategory = 'reviewing' | 'stay-in-touch' | 'no' | 'resume-requested' | 'needs-attention' | 'other';

/** Where a replied conversation stands — see lib/actionQueue.js on the server. */
export type ActionBucket = 'needs-you' | 'follow-up' | 'waiting' | 'snoozed' | 'done';

export interface ContactAction {
  /** Stored state. 'follow-up' is never stored — the server derives it from a due wait. */
  state: Exclude<ActionBucket, 'follow-up'> | null;
  reason: string | null;
  since: string | null;
  /** When a waiting/snoozed item comes back to Needs you. */
  dueAt: string | null;
  resolvedBy: 'you-replied' | 'manual' | 'auto' | null;
}

export interface StatusHistoryEntry {
  status: string;
  changedAt: string;
  note?: string;
}

export interface ThreadEntry {
  direction: 'outbound' | 'inbound';
  subject: string;
  text: string;
  html: string;
  messageId: string | null;
  inReplyTo: string | null;
  at: string;
}

export interface Contact {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
  template: string;
  /** Where the contact entered outreach: promoted from the Leads board, or fed in directly. */
  source: 'outreach' | 'lead';
  sourceLeadId: string | null;
  /** Only on contacts moved in from the Discover tab, whose address was guessed. */
  prospectId?: string;
  emailConfidence?: EmailConfidence;
  emailPattern?: string;
  /** Only on contacts from a Naukri job (Naukri → Find people); fills {{jobTitle}}. */
  jobTitle?: string;
  naukriJobId?: string;
  linkedin?: string;
  status: ContactStatus;
  approvalStatus: ApprovalStatus;
  editedSubject: string | null;
  editedBody: string | null;
  bounceReason: string | null;
  failReason?: string | null;
  messageId: string | null;
  sentSubject: string | null;
  repliedAt: string | null;
  replySnippet: string | null;
  replyRead: boolean;
  replyCategory: ReplyCategory | null;
  replyCategoryReasoning: string | null;
  replyCategorizedAt: string | null;
  // True only once the current latest reply has been SUCCESSFULLY classified — resets to
  // false whenever a new reply comes in. False (with replyCategory possibly null) means "needs
  // a manual trigger", which is distinct from a real "needs-attention" verdict.
  replyClassifierOk: boolean;
  lastSentAt: string | null;
  followUpSentAt: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  action?: ContactAction;
  statusHistory?: StatusHistoryEntry[];
  thread?: ThreadEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  key: string;
  name: string;
  subject: string;
  body: string;
}

export interface CustomVariable { key: string; value: string; }

export interface ResumeInfo { filename: string; size: number; uploadedAt: string; }

export interface Sender {
  name: string;
  company: string;
  email: string;
  customVariables: CustomVariable[];
  resume: ResumeInfo | null;
  lastMailboxCheckAt: Date | null;
}

export interface JobItem {
  contactId: string;
  to: string;
  name: string;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error?: string;
  messageId?: string | null;
  processedAt?: string;
}

export interface SendJob {
  id: string;
  // 'pending' is what the SendJob schema actually stores before the orchestrator
  // picks the job up; 'queued' was never a real value.
  status: 'pending' | 'processing' | 'paused' | 'done' | 'cancelled';
  sendMode?: 'sequential' | 'bulk' | 'drip' | null;
  ratePerHour?: number;
  campaignId?: string | null;
  campaignName?: string | null;
  // Set when Gmail's daily sending limit paused the job; the hourly quota watcher resumes
  // one such job per account at a time (pausedUntil = earliest retry).
  pauseReason?: 'gmail_daily_limit' | null;
  pausedUntil?: string | null;
  createdAt: string;
  items: JobItem[];
}

/**
 * Fired after any successful write to /api/jobs or /api/campaigns — anything that
 * can start, pause, resume or cancel a send job. SendJobWidget polls slowly while
 * nothing is in flight and listens for this to pick a new job up immediately.
 */
export const JOBS_CHANGED_EVENT = 'outreach:jobs-changed';
const JOB_WRITE_PATH = /^\/api\/(jobs|campaigns)(\/|\?|$)/;

export async function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const method = (opts?.method || 'GET').toUpperCase();
  let res: Response;
  let data: any;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch (err: any) {
    // A deliberate cancel is not a failure.
    if (err?.name !== 'AbortError') reportClientIssue('network_error', `${method} ${path}: ${err?.message || 'request failed'}`, { url: path, method });
    throw err;
  }
  try {
    data = await res.json();
  } catch (err: any) {
    // No JSON back — a platform timeout or an HTML error page, which the
    // server's own capture never saw.
    reportClientIssue('network_error', `${method} ${path}: HTTP ${res.status} with no readable response`, { url: path, method });
    throw err;
  }
  if (!res.ok) {
    const e: any = new Error((data as any).error || `Request to ${path} failed`);
    // A machine-readable reason when the server gave one (e.g. 'AI_KEY_REQUIRED').
    e.code = (data as any).code || null;
    e.status = res.status;
    throw e;
  }
  if (method !== 'GET' && JOB_WRITE_PATH.test(path) && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
  }
  return data as T;
}

/** True when a request failed because this account has no AI key it may use. */
export const isAiKeyRequired = (e: any) => !!e && e.code === 'AI_KEY_REQUIRED';

// ── Endpoint wrappers (1:1 with window._app) ─────────────────────────────────
export const loadContactsApi = () => apiFetch<Contact[]>('/api/contacts');
/** Your companies with a contact count each — for the Contacts company filter. */
/** Every contact address, lowercased — for the campaign wizard's "already in Contacts" count. */
export const loadContactEmailsApi = () => apiFetch<{ emails: string[] }>('/api/contacts/emails');
export const loadContactCompaniesApi = () => apiFetch<{ companies: { company: string; n: number }[] }>('/api/contacts/companies');
/** Only the contacts the Mailbox can show (queued or with an inbound message) — same objects as loadContactsApi. */
export const loadMailboxContactsApi = () => apiFetch<Contact[]>('/api/contacts?view=mailbox');
/** Every contact, carrying only the fields the Analytics page reads. Never put these in the app store. */
/** Only the contacts Send step 3 reads (approved + queued, or pending) — same objects as loadContactsApi. */
export const loadSendContactsApi = () => apiFetch<Contact[]>('/api/contacts?view=send');
export const loadAnalyticsContactsApi = () => apiFetch<Contact[]>('/api/contacts?view=analytics');

/** The contact side of the Recent activity card, at the server's `now` (lib/analyticsSummary.js). */
export interface AnalyticsActivity {
  now: number;
  /** window key → activity type → count. */
  counts: Record<string, Record<string, number>>;
  /** window key → the newest 40 contact events in it, newest first. */
  feeds: Record<string, Array<{ id: string; name: string; company?: string; t: number; type: string }>>;
}

/** Everything the Outreach analytics page derives from contacts, computed on the server. */
export interface AnalyticsSummary {
  now: number;
  tz: string;
  metrics: {
    total: number; sentCount: number; repliedCount: number; fuCount: number; bouncedCount: number;
    afterFuCount: number; beforeFuCount: number; inReviewEver: number; closedEver: number; queuedNow: number; inCampaignNow: number;
    replyRate: number; bounceRate: number;
  };
  statusCurrent: Array<{ s: string; n: number }>;
  statusEver: Array<{ s: string; n: number }>;
  /** The Mailbox Needs you queue (lib/queueAnalytics.js). */
  queue?: QueueAnalytics;
  journey: Array<[string, number]>;
  /** Template key → contacts emailed / ever replied, in the page's table order before its sort. */
  templates: Array<[string, { sent: number; replied: number }]>;
  companies: Array<{ co: string; total: number; replied: number; rate: number }>;
  /** Hours from a send to the reply it earned, ascending. */
  pairs: number[];
  series: Record<'30' | '90', Array<{ day: number; sent: number; replied: number }>>;
  /** Monday-first, for the Weekly rhythm chart. */
  weekday: { sends: number[]; replies: number[] };
  /** Replies by Date#getDay() (Sunday-first) and by hour, in your timezone. */
  replyWd: number[];
  replyHr: number[];
  week: { s1: number; s2: number; r1: number; r2: number };
  adv: number;
  due: number;
  /** The contacts the Interviews store points at — the only rows the interview funnel counts. */
  interviewRows: Array<{ id: string; email: string }>;
  activity: AnalyticsActivity;
}

const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
export const loadAnalyticsSummaryApi = () =>
  apiFetch<AnalyticsSummary>(`/api/contacts/analytics-summary?tz=${encodeURIComponent(browserTz())}`);
export const loadAnalyticsActivityApi = () => apiFetch<AnalyticsActivity>('/api/contacts/analytics-activity');
export const loadTemplatesApi = () => apiFetch<Template[]>('/api/templates');

/** Counts the Dashboard and Contacts headers show, over every contact. */
export interface ContactListStats {
  total: number; sent: number; bounced: number; replied: number; followUpReplied: number;
  pending: number; remaining: number; followUpDue: number; followUpSent: number;
  closed: number; noOpenings: number; inReview: number;
  resumable: number; failed: number; unread: number;
}
export interface ContactListPage {
  contacts: Contact[]; total: number; page: number; pages: number; limit: number;
  stats: ContactListStats;
  /** Every filtered id in order — only when asked for with ids=1. */
  ids?: string[];
}
/** One filtered, sorted page of contacts (GET /api/contacts/list). */
export const loadContactListApi = (params: Record<string, string>, signal?: AbortSignal) =>
  apiFetch<ContactListPage>(`/api/contacts/list?${new URLSearchParams(params)}`, { signal });
export const loadSettingsApi = () => apiFetch<any>('/api/settings');

export const createContactsApi = (rows: Partial<Contact>[]) =>
  apiFetch<{ created: Contact[]; skipped: number; invalid?: number }>('/api/contacts', {
    method: 'POST', body: JSON.stringify(rows),
  });

export const updateContactApi = (id: string, patch: Partial<Contact>) =>
  apiFetch<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const bulkUpdateContactsApi = (updates: Array<{ id: string } & Partial<Contact>>) =>
  apiFetch<{ ok: boolean; count: number }>('/api/contacts', { method: 'PATCH', body: JSON.stringify(updates) });

export const deleteContactApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/contacts/${id}`, { method: 'DELETE' });

/** Same soft delete as deleteContactApi, for many ids in one request. */
export const bulkDeleteContactsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; deleted: string[]; failed: number }>('/api/contacts/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }),
  });

export const checkMailboxApi = () =>
  apiFetch<any>('/api/check-mailbox', { method: 'POST' });

export interface ContactThread {
  name: string; email: string; company: string;
  replyCategory: ReplyCategory | null; replyCategoryReasoning: string | null;
  thread: ThreadEntry[];
}
export const loadContactThreadApi = (id: string) =>
  apiFetch<ContactThread>(`/api/contacts/${id}/thread`);

// Backfills thread + category data for replies that were detected before this pipeline
// existed. One call processes a bounded batch — call repeatedly until `remaining` is 0.
export const backfillReplyCountApi = () =>
  apiFetch<{ count: number }>('/api/contacts/backfill-replies/count');
export const backfillRepliesApi = (limit = 20) =>
  apiFetch<{ processed: number; remaining: number }>('/api/contacts/backfill-replies', {
    method: 'POST', body: JSON.stringify({ limit }),
  });

// Manually (re)triggers classification for one contact — e.g. after every provider hit a
// free-tier rate limit and the automatic attempt failed (replyClassifierOk: false). Throws (caller
// should toast the error); replyClassifierOk stays false either way until a call succeeds.
export const triggerReplyClassificationApi = (id: string) =>
  apiFetch<Contact>(`/api/contacts/${id}/classify-reply`, { method: 'POST' });

// The Needs you queue. The server decides every conversation's bucket (and the counts, from
// the same rows), so the Mailbox never works one out itself and the badge can't disagree
// with the list.
export interface ActionItem {
  id: string;
  bucket: ActionBucket;
  reason: string | null;
  since: string | null;
  dueAt: string | null;
  resolvedBy: ContactAction['resolvedBy'];
}
export interface ActionQueue { now: string; counts: Record<ActionBucket, number>; items: ActionItem[]; }
export const loadActionQueueApi = () => apiFetch<ActionQueue>('/api/actions');
export type ActionOp = 'done' | 'snooze' | 'reopen';
export const bulkActionApi = (ids: string[], op: ActionOp, until?: string) =>
  apiFetch<{ ok: boolean; updated: number }>('/api/actions/bulk', {
    method: 'POST', body: JSON.stringify({ ids, op, until }),
  });

// The bell at the top right (routes/notifications.js).
export type NotificationSeverity = 'success' | 'info' | 'warning' | 'error';
export interface AppNotification {
  id: string; type: string; severity: NotificationSeverity;
  title: string; body: string;
  /** In-app router path, e.g. /mailbox. Empty when there is nowhere to go. */
  link: string;
  read: boolean; createdAt: string;
}
export interface NotificationFeed { unread: number; unreadErrors: number; items: AppNotification[]; }
export const loadNotificationsApi = () => apiFetch<NotificationFeed>('/api/notifications');
export const markNotificationsReadApi = (opts: { ids?: string[]; all?: boolean }) =>
  apiFetch<{ ok: boolean; updated: number }>('/api/notifications/read', { method: 'POST', body: JSON.stringify(opts) });
export const clearNotificationsApi = (opts: { ids?: string[]; all?: boolean }) =>
  apiFetch<{ ok: boolean; updated: number }>('/api/notifications/clear', { method: 'POST', body: JSON.stringify(opts) });

// AI reply drafts, sent from your Gmail as a threaded reply (routes/replies.js).
export interface ReplyDraft { body: string; provider: string; attachResume: boolean; hasResume: boolean; }
export const draftReplyApi = (id: string, opts: { note?: string; attachResume?: boolean }) =>
  apiFetch<ReplyDraft>(`/api/replies/${id}/draft`, { method: 'POST', body: JSON.stringify(opts) });
export const sendReplyApi = (id: string, opts: { body: string; attachResume: boolean; allowPlaceholders?: boolean }) =>
  apiFetch<Contact>(`/api/replies/${id}/send`, { method: 'POST', body: JSON.stringify(opts) });

export const saveSettingsApi = (patch: any) =>
  apiFetch<any>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });

export const createTemplateApi = (data: Partial<Template>) =>
  apiFetch<Template>('/api/templates', { method: 'POST', body: JSON.stringify(data) });

export const updateTemplateApi = (key: string, patch: Partial<Template>) =>
  apiFetch<Template>(`/api/templates/${key}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteTemplateApi = (key: string) =>
  apiFetch<void>(`/api/templates/${key}`, { method: 'DELETE' });

export interface BlocklistEntry {
  id: string;
  type: 'email' | 'domain';
  value: string;
  reason: string;
  createdAt: string;
}

export const loadBlocklistApi = () => apiFetch<BlocklistEntry[]>('/api/blocklist');

export const createBlocklistEntryApi = (data: { type?: 'email' | 'domain'; value: string; reason?: string }) =>
  apiFetch<BlocklistEntry>('/api/blocklist', { method: 'POST', body: JSON.stringify(data) });

export const deleteBlocklistEntryApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/blocklist/${id}`, { method: 'DELETE' });

export interface CooldownSkip {
  id: string; name: string; email: string; status: ContactStatus;
  lastSentAt: string | null; remainingMs: number; reason?: 'cooldown' | 'in_campaign' | 'blocked' | 'in_interview' | 'replied';
}

export interface ResetForSendResult {
  ok: boolean;
  contacts: Contact[];
  cooldownLabel: string;
  /** Contacts left untouched because they were emailed inside the cooldown window. */
  skipped: CooldownSkip[];
}

export const resetForSendApi = (ids: string[]) =>
  apiFetch<ResetForSendResult>('/api/contacts/reset-for-send', { method: 'POST', body: JSON.stringify({ ids }) });

export const retryFailedApi = () =>
  apiFetch<{ retried: number }>('/api/contacts/retry-failed', { method: 'POST' });

export const contactsStatsApi = () => apiFetch<any>('/api/contacts/stats');

export const getJobApi = (id: string) => apiFetch<SendJob>(`/api/jobs/${id}`);
export const getActiveJobApi = () => apiFetch<SendJob | null>('/api/jobs/active');
export const getLatestJobApi = () => apiFetch<SendJob>('/api/jobs/latest');

export async function uploadResumeApi(file: File): Promise<ResumeInfo | null> {
  const formData = new FormData();
  formData.append('resume', file);
  const res = await fetch(`${API_BASE}/api/settings/resume`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.resume || null;
}

export const deleteResumeApi = () =>
  apiFetch<void>('/api/settings/resume', { method: 'DELETE' });

// ── Leads ───────────────────────────────────────────────────────────────────
// Staged harvester leads. Unrelated to Contact until promoted.

export type LeadStatus = 'new' | 'added-to-outreach';

/** The direct-application journey — manual, since nothing can observe it. */
export type ApplyStatus =
  | 'not-applied' | 'applied' | 'in-review' | 'interviewing' | 'offer' | 'rejected' | 'skipped';

export interface ApplyHistoryEntry { status: ApplyStatus; changedAt: string; note?: string }

/** One lead exactly as it appears in the uploaded harvester JSON (pre-explode). */
export interface SourceLead {
  author_name: string;
  author_url: string | null;
  company: string | null;
  emails: string[];
  fit_score: number;      // -999 = hard reject
  hiring: boolean;
  links: string[];
  post_url: string | null;
  source: string;
  query?: string;         // the search that surfaced this lead (added Sep 2026)
  // Only the Leads sources (paste / hn / web-post) send these.
  role?: string;
  location?: string;
  posted_at?: string | null;
  snippet?: string;
}

/** The whole uploaded file. */
export interface LeadFile {
  _readme?: string[];
  updated_at?: number;    // unix seconds
  last_run?: Record<string, unknown>;
  last_run_leads?: SourceLead[];
  all_leads?: SourceLead[];
}

/** One stored (author, email) pair. */
export interface Lead {
  id: string;
  authorName: string;
  authorUrl: string | null;
  email: string | null;   // null => cannot be moved to outreach
  company: string;
  role: string;
  fitScore: number;
  hiring: boolean;
  links: string[];
  postUrl: string | null;
  source: string;
  queries: string[];      // every search that surfaced this lead
  status: LeadStatus;
  applyStatus: ApplyStatus;
  appliedAt: string | null;
  applyUrl: string | null;
  applyNote: string;
  applyHistory?: ApplyHistoryEntry[];
  contactId: string | null;
  promotedAt: string | null;
  batchUpdatedAt: string | null;   // the harvest run's own updated_at
  // Only leads from the Leads sources (paste / hn / web-post) carry these.
  location?: string;
  postedAt?: string;
  snippet?: string;
  dedupeKey?: string;              // internal: how re-imports match this row
  createdAt: string;
  updatedAt: string;
}

export interface LeadImportResult {
  created: Lead[];
  skipped: number;          // already in the lead store
  updated: number;          // existing rows backfilled with new queries
  skippedInBatch: number;   // duplicate rows inside the uploaded file
  ignoredRows: number;
  totalSourceLeads: number;
  explodedRows: number;
}

export interface MoveToOutreachRow { id: string; name: string; company: string; role: string; }

export interface MoveToOutreachResult {
  ok: boolean;
  created: Contact[];
  alreadyExisted: number;
  skippedNoEmail: number;
  movedIds: string[];
  /** Every contact the moved leads now stand for — new and already existing. */
  contactIds?: string[];
  statusUpdateFailed?: boolean;
}

/** What became of a lead once it entered outreach. Keyed by lowercased email. */
export interface LeadOutcome {
  contactId: string;
  status: ContactStatus;
  approvalStatus: ApprovalStatus;
  template: string;
  lastSentAt: string | null;
  followUpSentAt: string | null;
  repliedAt: string | null;
  replySnippet: string | null;
  bounceReason: string | null;
  failReason: string | null;
}

export type LeadOutcomeMap = Record<string, LeadOutcome>;

/** Every lead, as GET /api/leads returns them — through the browser copy in lib/leadCache.ts. */
export const loadLeadsApi = () => loadLeadsSynced<Lead>();
/** Every lead with only links/applyUrl/postUrl — enough to suggest job boards, nothing else. */
export const loadLeadBoardLinksApi = () => apiFetch<Lead[]>('/api/leads?view=boards');

/** As GET /api/leads/outcomes returns it — through the browser copy in lib/leadCache.ts. */
export const loadLeadOutcomesApi = () => loadLeadOutcomesSynced<LeadOutcome>();

export const importLeadsApi = (payload: LeadFile | SourceLead[]) =>
  apiFetch<LeadImportResult>('/api/leads/import', { method: 'POST', body: JSON.stringify(payload) });

// ── Leads sources: Paste text, HN "Who is hiring?", hiring posts ────────────

export interface SourcesConfig {
  roles: string[];
  locations: string[];
  maxYears: number | null;
  webOn: boolean;
  webPerDay: number;
  hnOn: boolean;
}

export interface SourcesConfigView {
  config: SourcesConfig;
  hasSearchKey: boolean;
  tavily: { used: number; cap: number };
  maxPerDay: number;
}

export interface SourceRun {
  id: string;
  source: 'web' | 'hn';
  trigger: 'cron' | 'manual';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  label: string;
  queries: string[];
  credits: number;
  read: number;
  withEmail: number;
  matched: number;
  created: number;
  duplicates: number;
  rejected: number;
  error: string | null;
}

/** One preview row from Paste text: a lead in the harvester shape, plus why it scored what it did. */
export interface PasteLead extends SourceLead {
  fit_reasons: string[];
  existing: string[];      // of `emails`, the ones already on your Leads board
}

export interface PastePreview {
  leads: PasteLead[];
  chunks: number;
  skippedChunks: number;
  truncated: boolean;
  deadDomains: string[];
  aiError: string | null;
  maxText: number;
}

export const sourcesConfigApi = () => apiFetch<SourcesConfigView>('/api/sources/config');
export const saveSourcesConfigApi = (patch: Partial<SourcesConfig>) =>
  apiFetch<SourcesConfigView>('/api/sources/config', { method: 'PUT', body: JSON.stringify(patch) });
export const sourceRunsApi = () => apiFetch<{ web: SourceRun[]; hn: SourceRun[] }>('/api/sources/runs');
export const runSourceApi = (source: 'web' | 'hn') =>
  apiFetch<{ ok: true }>('/api/sources/run', { method: 'POST', body: JSON.stringify({ source }) });
export const pastePreviewApi = (text: string) =>
  apiFetch<PastePreview>('/api/sources/paste/preview', { method: 'POST', body: JSON.stringify({ text }) });

export const moveLeadsToOutreachApi = (template: string, leads: MoveToOutreachRow[]) =>
  apiFetch<MoveToOutreachResult>('/api/leads/move-to-outreach', {
    method: 'POST', body: JSON.stringify({ template, leads }),
  });

export const updateLeadApi = (id: string, patch: Partial<Lead> & { note?: string }) =>
  apiFetch<Lead>(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const bulkUpdateLeadsApi = (updates: Array<{ id: string; note?: string } & Partial<Lead>>) =>
  apiFetch<{ ok: boolean; count: number }>('/api/leads', { method: 'PATCH', body: JSON.stringify(updates) });

export const deleteLeadApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/leads/${id}`, { method: 'DELETE' });

export const deleteLeadsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; deleted: number }>('/api/leads/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }),
  });

// ── Job postings ────────────────────────────────────────────────────────────
// A Posting is a role a company currently lists on a public ATS board. It is
// deliberately NOT a Lead: there is no join key between them (postings carry no
// email, and Lever/Ashby expose no company name), so they are two independent
// journeys that share a vocabulary. See lib/postings.ts.

export type BoardSource = 'greenhouse' | 'lever' | 'ashby' | 'muse' | 'jobicy';
/** 'board' = one company's ATS page (authoritative, so vanishing = closed).
 *  'search' = a query across many employers (a partial slice, so it never closes). */
export type SourceKind = 'board' | 'search';
export type ListingStatus = 'open' | 'closed';

/** ApplyStatus plus 'saved'. A SEPARATE type on purpose — widening ApplyStatus
 *  would change Lead's enum, the server Lead schema and the Leads filter panel,
 *  i.e. modify a working feature for no benefit. */
export type TrackStatus =
  | 'not-applied' | 'saved' | 'applied' | 'in-review'
  | 'interviewing' | 'offer' | 'rejected' | 'skipped';

export type BoardSyncStatus = 'never' | 'ok' | 'empty' | 'not-found' | 'error' | 'skipped';

export interface TrackHistoryEntry {
  status: TrackStatus;
  changedAt: string;
  note?: string;
}

export interface Posting {
  id: string;
  source: BoardSource;
  boardToken: string;
  boardId: string | null;
  sourceId: string;
  sourceKey: string;
  title: string;
  company: string;
  department: string;
  team: string;
  location: string;
  locations: string[];
  remote: boolean;
  workplaceType: string;
  employmentType: string;
  country: string;
  url: string;
  applyUrl: string;
  requisitionId: string;
  /** Which saved searches surfaced this. Only used by 'search' sources, where
   *  one job is stored once no matter how many queries found it. */
  queries: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  postedAt: string | null;
  sourceUpdatedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  listingStatus: ListingStatus;
  closedAt: string | null;
  reopenedAt: string | null;
  closeCount: number;
  applyStatus: TrackStatus;
  appliedAt: string | null;
  appliedVia: string | null;
  applyNote: string;
  applyHistory?: TrackHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Search parameters. Empty for company boards; each search source validates
 *  its own vocabulary server-side. */
export interface BoardQuery {
  category?: string;   // muse
  company?: string;    // muse — scopes a search to one employer
  industry?: string;   // jobicy
  level?: string;      // both
  location?: string;   // muse
  geo?: string;        // jobicy
  tag?: string;        // jobicy
}

export interface JobBoard {
  id: string;
  source: BoardSource;
  token: string;
  label: string;
  enabled: boolean;
  query?: BoardQuery;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  /** Set once, on a board's first success. firstSeenAt equal to this means
   *  "imported with the board", not "new to the world". */
  firstSyncAt: string | null;
  lastSyncStatus: BoardSyncStatus;
  lastError: string;
  lastHttpStatus: number | null;
  lastPostingCount: number;
  lastNewCount: number;
  lastClosedCount: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSyncReport {
  boardId: string;
  source: BoardSource;
  token: string;
  label: string;
  status: BoardSyncStatus;
  httpStatus: number | null;
  error: string | null;
  fetched: number;
  filtered: number;
  /** Listed by the source but not stored, because your criteria excluded it.
   *  These are NOT closed — the company still has them open. */
  filteredOut: number;
  kind: SourceKind;
  inserted: number;
  updated: number;
  reopened: number;
  closed: number;
  firstSync: boolean;
  /** The board fetched nothing and closed a lot — could be a hiring freeze,
   *  could be a renamed board. Reversible either way. */
  massClosed: boolean;
  writeErrors: number;
  ms: number;
  enrichError?: string;
}

export interface SyncRunReport {
  ok: boolean;
  reason?: 'locked' | 'no-boards';
  since?: string | null;
  startedAt: string;
  finishedAt: string;
  ms: number;
  previousSyncAt: string | null;
  boards: BoardSyncReport[];
  criteriaEnabled?: boolean;
  totals: {
    boards: number; ok: number; empty: number; notFound: number;
    errored: number; skipped: number; fetched: number; filteredOut: number;
    inserted: number; updated: number; reopened: number; closed: number;
  };
  massCloseWarnThreshold?: number;
}

export interface PostingsMeta {
  lastSyncAt: string | null;
  previousSyncAt: string | null;
  cronConfigured: boolean;
  syncRunning: boolean;
  counts: { open: number; closed: number; tracked: number; newSinceLastSync: number };
}

export interface JobCriteria {
  enabled: boolean;
  include: string[];
  /** A blocklist, and it WINS over `include` — so "Solution Engineer
   *  (Pre-Sales)" is dropped despite containing "engineer". */
  exclude: string[];
  locations: string[];
  remoteOnly: boolean;
}

export interface CriteriaTestResult {
  total: number;
  kept: number;
  dropped: number;
  keptSample: string[];
  droppedSample: string[];
}

export interface SourceInfo {
  label: string;
  kind: SourceKind;
  closes: boolean;
  tokenHint: string;
  categories: string[] | null;
  industries: string[] | null;
  levels: string[] | null;
}

export interface MuseCompany {
  name: string;
  token: string;
  size: string;
  industries: string[];
}

/** A curated, pre-verified company board. `approxRoles` is a snapshot and goes
 *  stale — the live count comes from the preview. */
export interface StarterBoard {
  source: BoardSource;
  token: string;
  name: string;
  approxRoles: number;
}

export interface BoardPreview {
  kind: 'ok' | 'empty' | 'not-found' | 'error';
  httpStatus: number | null;
  token: string;
  count: number;
  filtered: number;
  sample: Array<{ title: string; location: string }>;
  suggestedLabel: string;
  error: string | null;
}

export const loadPostingsApi = (params?: Record<string, string>) =>
  apiFetch<Posting[]>(`/api/postings${params ? '?' + new URLSearchParams(params) : ''}`);

export const loadPostingsMetaApi = () => apiFetch<PostingsMeta>('/api/postings/meta');

export const loadBoardsApi = () => apiFetch<{ boards: JobBoard[] }>('/api/postings/boards');

export const createBoardApi = (body: { source: BoardSource; token: string; label?: string } & BoardQuery) =>
  apiFetch<{ board: JobBoard; revived?: boolean }>('/api/postings/boards', {
    method: 'POST', body: JSON.stringify(body),
  });

export const updateBoardApi = (id: string, patch: { label?: string; enabled?: boolean; query?: BoardQuery }) =>
  apiFetch<{ board: JobBoard }>(`/api/postings/boards/${id}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });

export const deleteBoardApi = (id: string, mode: 'keep' | 'delete' = 'keep') =>
  apiFetch<{ ok: boolean; board: JobBoard; postingsDeleted: number }>(
    `/api/postings/boards/${id}?postings=${mode}`, { method: 'DELETE' });

export const previewBoardApi = (body: { source: BoardSource; token: string } & BoardQuery) =>
  apiFetch<BoardPreview>('/api/postings/boards/preview', {
    method: 'POST', body: JSON.stringify(body),
  });

/** The Muse's employer directory — the only source here that publishes one. */
export const loadCompaniesApi = (refresh = false) =>
  apiFetch<{ companies: MuseCompany[]; cached: boolean; pages: number; error: string | null }>(
    `/api/postings/companies${refresh ? '?refresh=1' : ''}`);

export const loadStarterBoardsApi = () =>
  apiFetch<{ starterBoards: StarterBoard[] }>('/api/postings/starter-boards');

export const loadSourcesApi = () =>
  apiFetch<{ sources: Record<BoardSource, SourceInfo> }>('/api/postings/sources');

export const loadCriteriaApi = () =>
  apiFetch<{ criteria: JobCriteria; defaults: JobCriteria }>('/api/postings/criteria');

export const saveCriteriaApi = (criteria: JobCriteria) =>
  apiFetch<{ criteria: JobCriteria }>('/api/postings/criteria', {
    method: 'PUT', body: JSON.stringify(criteria),
  });

/** Preview a profile against what you already have, before turning it on. */
export const testCriteriaApi = (criteria: JobCriteria) =>
  apiFetch<CriteriaTestResult>('/api/postings/criteria/test', {
    method: 'POST', body: JSON.stringify(criteria),
  });

/**
 * A sync is the likeliest endpoint here to hit an edge timeout, and apiFetch
 * calls res.json() unconditionally — so a plain-text 504 from Vercel surfaces as
 * an opaque SyntaxError. Translate it into something true: the run is idempotent
 * (one runStartedAt is both the lastSeenAt stamp and the close cutoff), so
 * re-running really does lose nothing.
 */
export const syncPostingsApi = async (body?: { boardIds?: string[]; dryRun?: boolean }) => {
  try {
    return await apiFetch<SyncRunReport>('/api/postings/sync', {
      method: 'POST', body: JSON.stringify(body || {}),
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('The sync took too long to respond — run it again; nothing was lost.');
    }
    throw err;
  }
};

export const updatePostingApi = (
  id: string,
  patch: { applyStatus?: TrackStatus; applyNote?: string; appliedVia?: string | null; note?: string },
) => apiFetch<Posting>(`/api/postings/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const bulkUpdatePostingsApi = (
  updates: Array<{ id: string; applyStatus?: TrackStatus; applyNote?: string; note?: string }>,
) => apiFetch<{ ok: boolean; count: number }>('/api/postings', {
  method: 'PATCH', body: JSON.stringify(updates),
});

export const deletePostingApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/postings/${id}`, { method: 'DELETE' });

export const deletePostingsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; deleted: number }>('/api/postings/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }),
  });

// ── Interviews ──────────────────────────────────────────────────────────────
// People who actually got back to you. A separate store from Contact/Lead: the
// source row keeps its own journey, this record carries the conversation.

export type InterviewStatus =
  | 'initial-discussion' | 'assignment' | 'asked-to-schedule' | 'scheduled'
  | 'in-process' | 'selected' | 'rejected';

export type InterviewSource = 'contact' | 'lead' | 'manual';
export type InterviewMode = '' | 'call' | 'video' | 'onsite';
export type WorkMode = '' | 'remote' | 'hybrid' | 'onsite';
export type InterviewFileKind = 'cv' | 'jd';

export interface InterviewFile {
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}

export interface Interview {
  id: string;
  sourceType: InterviewSource;
  sourceId: string | null;
  name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  status: InterviewStatus;
  rejectionReason: string;
  interviewAt: string | null;
  round: string;
  mode: InterviewMode;
  meetingLink: string;
  expectedCtc: string;
  offeredCtc: string;
  noticePeriod: string;
  location: string;
  workMode: WorkMode;
  notes: string;
  cv: InterviewFile | null;
  jd: InterviewFile | null;
  statusHistory?: StatusHistoryEntry[];
  /** Bumped by every status change, edit, upload or explicit follow-up. */
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Everything the create/edit forms can send. `note` annotates the history entry. */
export type InterviewPatch = Partial<Omit<Interview,
  'id' | 'cv' | 'jd' | 'statusHistory' | 'lastActivityAt' | 'createdAt' | 'updatedAt'>>
  & { note?: string };

export const loadInterviewsApi = () => apiFetch<Interview[]>('/api/interviews');

/** 409 means this person already has a record — the caller opens that instead. */
export class AlreadyTrackedError extends Error {
  interview: Interview;
  constructor(interview: Interview) {
    super('This person is already being tracked in Interviews');
    this.name = 'AlreadyTrackedError';
    this.interview = interview;
  }
}

export async function createInterviewApi(body: InterviewPatch): Promise<Interview> {
  const res = await fetch(`${API_BASE}/api/interviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 409 && data.interview) throw new AlreadyTrackedError(data.interview);
  if (!res.ok) throw new Error(data.error || 'Could not add to interviews');
  return data as Interview;
}

export const updateInterviewApi = (id: string, patch: InterviewPatch) =>
  apiFetch<Interview>(`/api/interviews/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const markInterviewFollowedUpApi = (id: string, note?: string) =>
  apiFetch<Interview>(`/api/interviews/${id}/followed-up`, {
    method: 'POST', body: JSON.stringify({ note }),
  });

export const deleteInterviewApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/interviews/${id}`, { method: 'DELETE' });

export async function uploadInterviewFileApi(
  id: string, kind: InterviewFileKind, file: File,
): Promise<Interview> {
  const formData = new FormData();
  formData.append('file', file);
  // No Content-Type header — the browser must set the multipart boundary itself.
  const res = await fetch(`${API_BASE}/api/interviews/${id}/file/${kind}`, {
    method: 'POST', body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data as Interview;
}

export const deleteInterviewFileApi = (id: string, kind: InterviewFileKind) =>
  apiFetch<Interview>(`/api/interviews/${id}/file/${kind}`, { method: 'DELETE' });

export const interviewFileUrl = (id: string, kind: InterviewFileKind) =>
  `${API_BASE}/api/interviews/${id}/file/${kind}`;

// ── Campaigns ───────────────────────────────────────────────────────────────
// A Campaign owns a list of CampaignRows and releases them in daily batches.
// Each released batch creates one ordinary SendJob with sendMode 'drip', so the
// existing job widget, /api/jobs/* and analytics keep working untouched — a
// campaign is a scheduler on top of SendJob, not a replacement.

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed';

export type CampaignRowStatus = 'pending' | 'queued' | 'released' | 'skipped' | 'removed';

export type CampaignSkipReason =
  | 'blank_email' | 'invalid_email' | 'duplicate_in_file' | 'duplicate_contact'
  | 'removed_by_user' | 'queue_failed' | 'render_empty' | 'cooldown' | 'source_contact_missing'
  | 'in_interview' | 'bounced';

export interface CampaignStats {
  total: number; pending: number; released: number; skipped: number; removed: number;
  queued?: number;
}

/** One entry in the campaign's activity log. Embedded on the campaign, newest last.
 *  'release' = a day's batch went out. 'reconcile' = rows were retired because
 *  they were already Contacts. */
export interface CampaignRelease {
  kind?: 'release' | 'reconcile';
  releasedOn: string;              // 'YYYY-MM-DD' in IST
  trigger: 'cron' | 'manual' | 'upload';
  jobId: string | null;
  released: number;
  skipped: number;
  scanned: number;
  exhausted: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Stored for display only — the client applied the mapping before uploading. */
export interface CampaignColumnMap {
  name?: number[] | null;
  email?: number | null;
  company?: number | null;
  role?: number | null;
}

/** What became of the contacts this campaign created, joined from Contact. */
export interface CampaignOutcomes {
  total: number;
  delivered: number;   // sent or follow-up-sent, no reply yet
  replied: number;     // replied or follow-up-replied
  bounced: number;
  failed: number;
  queued: number;
  closed: number;
  byStatus: Record<string, number>;
}

export interface Campaign {
  id: string;
  name: string;
  fileName: string;
  templateKey: string;
  status: CampaignStatus;
  contactsPerDay: number;
  ratePerHour: number;
  runHourIst: number;              // 0-23, Asia/Kolkata
  attachResume: boolean;
  columnMap: CampaignColumnMap;
  sourceColumns: string[];
  headerRow: number;
  stats: CampaignStats;
  lastReleaseOn: string | null;
  lastReleaseAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  releases: CampaignRelease[];
  completedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** True while a released campaign batch is still sending its emails. */
  sending?: boolean;
  /** Present on the list endpoint; the detail endpoint returns it alongside. */
  outcomes?: CampaignOutcomes;
}

export interface CampaignRow {
  id: string;
  campaignId: string;
  rowIndex: number;
  sourceRow: number;               // 1-based line in the original sheet
  name: string;
  email: string;
  company: string;
  role: string;
  extras: { k: string; v: string }[];
  status: CampaignRowStatus;
  skipReason: CampaignSkipReason | null;
  contactId: string | null;
  jobId: string | null;
  releasedAt: string | null;
  releasedOn: string | null;
}

/** Per-batch send outcome, so a drip that failed wholesale is visible. */
export interface CampaignJobSummary {
  id: string;
  status: SendJob['status'];
  sendMode: string;
  ratePerHour: number;
  createdAt: string;
  total: number; sent: number; failed: number; skipped: number; pending: number;
}

export interface CampaignDetail {
  campaign: Campaign;
  jobSummaries: CampaignJobSummary[];
  outcomes: CampaignOutcomes;
}

export interface CampaignMeta {
  dailyCap: number;
  sentToday: number;
  inFlight: number;
  headroom: number;
  todayIst: string;
  cronConfigured: boolean;
  credentialSource: 'env' | 'none';
  running: number;
  paused: number;
  dailyCommitment: number;
}

/** A row after the client has applied the column mapping. */
export interface CampaignRowInput {
  name: string; email: string; company: string; role: string;
  extras: { k: string; v: string }[];
  row: number;
}

/** Byte-identical to what the release will send — same renderer, same inputs. */
export interface CampaignPreview {
  campaignId: string;
  date: string;
  templateMissing: boolean;
  willRelease: Array<CampaignRowInput & { id: string; rowIndex: number; subject: string; body: string }>;
  willSkip: Array<{ id: string; rowIndex: number; sourceRow: number; name: string; email: string; reason: CampaignSkipReason }>;
  scanned: number;
  exhausted: boolean;
  remainingPending: number;
  /** The scan ran out of its time budget — an empty batch here means "unknown",
   *  not "nothing to send". */
  timedOut: boolean;
  /** The scan read its maximum stretch of rows without filling the batch. */
  capped: boolean;
  skipBreakdown: Partial<Record<CampaignSkipReason, number>>;
}

export interface CampaignReleaseReport {
  ok: boolean;
  reason?: string;
  campaignId: string;
  name?: string;
  released: number;
  skipped: number;
  scanned: number;
  exhausted: boolean;
  jobId: string | null;
  error: string | null;
  /** The run answered nothing (timed out / hit the row cap), so the day was NOT
   *  consumed and the next scheduled fire will try again. */
  retryable?: boolean;
  timedOut?: boolean;
  capped?: boolean;
}

export interface TimelineBucket {
  key: string;            // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH', in IST
  t: number;              // epoch ms at the bucket start
  sent: number;           // already delivered
  scheduled: number;      // in flight or projected
  peakSent: number;       // busiest hour inside the bucket
  peakScheduled: number;
  past: boolean;
}

export type TimelineRange = '24h' | '7d' | '30d';
/** 'campaigns' counts only batches a campaign released; 'all' includes manual sends. */
export type TimelineScope = 'all' | 'campaigns';

export interface Timeline {
  range: TimelineRange;
  scope: TimelineScope;
  granularity: 'day' | 'hour';
  now: number;
  from: number;
  to: number;
  /** Null on the admin's fleet view: the cap is per Gmail account. */
  dailyCap: number | null;
  buckets: TimelineBucket[];
}

export const loadTimelineApi = (range: TimelineRange, scope: TimelineScope) =>
  apiFetch<Timeline>(`/api/campaigns/timeline?range=${range}&scope=${scope}`);

export const loadCampaignsApi = () => apiFetch<Campaign[]>('/api/campaigns');

export const loadCampaignApi = (id: string) => apiFetch<CampaignDetail>(`/api/campaigns/${id}`);

export const loadCampaignMetaApi = () => apiFetch<CampaignMeta>('/api/campaigns/meta');

/** Phase 1 of creation: config + mapping metadata, no rows. Returns a draft. */
export const createCampaignApi = (body: {
  name: string; templateKey: string; contactsPerDay: number; ratePerHour: number;
  runHourIst: number; attachResume: boolean;
  columnMap: CampaignColumnMap; sourceColumns: string[]; headerRow: number; fileName: string;
}) => apiFetch<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify(body) });

/** The Action Center's send actions, recorded on what they start (Analytics). */
export type ActionKind = 'followup' | 'ready' | 'pending' | 'leads' | 'prospects';
// A step-wise send from the Action Center crosses three wizard pages; Step 3 reads
// this back when it creates the batch, if it is fresh and for the same contacts.
const SEND_ORIGIN_KEY = 'outreach.sendOrigin';
export function rememberSendOrigin(actionKind: ActionKind, ids: string[]) {
  try { sessionStorage.setItem(SEND_ORIGIN_KEY, JSON.stringify({ actionKind, ids: [...ids].sort(), at: Date.now() })); } catch { /* optional */ }
}
export function takeSendOrigin(ids: string[]): { origin: 'action-center'; actionKind: ActionKind } | null {
  try {
    const raw = sessionStorage.getItem(SEND_ORIGIN_KEY);
    sessionStorage.removeItem(SEND_ORIGIN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const sent = new Set(ids);
    // Within an hour, and the batch is (a subset of) what the Action Center offered.
    if (Date.now() - o.at > 3600000 || !ids.length || !ids.every(id => o.ids.includes(id)) || !o.ids.some((id: string) => sent.has(id))) return null;
    return { origin: 'action-center', actionKind: o.actionKind };
  } catch { return null; }
}

/** Create a campaign that sends to existing Contacts without re-importing them. */
export const createCampaignFromContactsApi = (body: {
  name: string; templateKey: string; contactIds: string[]; contactsPerDay: number;
  ratePerHour: number; runHourIst: number; attachResume: boolean;
  origin?: 'action-center'; actionKind?: ActionKind;
}) => apiFetch<Campaign>('/api/campaigns/from-contacts', {
  method: 'POST', body: JSON.stringify(body),
});

export interface CampaignContactsPreview {
  requested: number;
  eligible: number;
  skipped: { missing: number; in_campaign: number; invalid: number; cooldown: number; dead: number; interview: number; replied: number };
  credentialsMissing: boolean;
}
/** What createCampaignFromContactsApi would accept, without creating anything. */
export const previewCampaignFromContactsApi = (contactIds: string[]) =>
  apiFetch<CampaignContactsPreview>('/api/campaigns/from-contacts', {
    method: 'POST', body: JSON.stringify({ contactIds, dryRun: true }),
  });

/** Phase 2: rows, in byte-budgeted chunks. `last: true` flips draft -> running. */
export const appendCampaignRowsApi = (
  id: string, payload: { startIndex: number; rows: CampaignRowInput[]; last: boolean },
) => apiFetch<{ ok: boolean; inserted: number; duplicates: number; received: number;
                totalRows: number; campaign: Campaign }>(
  `/api/campaigns/${id}/rows`, { method: 'POST', body: JSON.stringify(payload) });

export const loadCampaignRowsApi = (id: string, params?: Record<string, string>) =>
  apiFetch<{ rows: CampaignRow[]; total: number; page: number; limit: number; pages: number }>(
    `/api/campaigns/${id}/rows${params ? '?' + new URLSearchParams(params) : ''}`);

export const previewCampaignApi = (id: string, limit?: number) =>
  apiFetch<CampaignPreview>(`/api/campaigns/${id}/preview${limit ? `?limit=${limit}` : ''}`);

export const updateCampaignApi = (id: string, patch: Partial<Pick<Campaign,
  'name' | 'contactsPerDay' | 'ratePerHour' | 'runHourIst' | 'templateKey' | 'attachResume'>>) =>
  apiFetch<Campaign>(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

/** Stops FUTURE releases only — a batch already in flight finishes on its own. */
export const pauseCampaignApi = (id: string) =>
  apiFetch<{ campaign: Campaign; inFlightJobs: Array<{ id: string; status: string; pending: number }> }>(
    `/api/campaigns/${id}/pause`, { method: 'POST' });

export const resumeCampaignApi = (id: string, releaseNow = false) =>
  apiFetch<{ campaign: Campaign; released: CampaignReleaseReport | null }>(
    `/api/campaigns/${id}/resume`, { method: 'POST', body: JSON.stringify({ releaseNow }) });

export const runCampaignNowApi = (id: string, force = false) =>
  apiFetch<CampaignReleaseReport>(`/api/campaigns/${id}/run-now`, {
    method: 'POST', body: JSON.stringify({ force }),
  });

/** 409 when the rows are no longer pending — the batch already started sending. */
export const removeCampaignRowsApi = (id: string, ids: string[]) =>
  apiFetch<{ ok: boolean; removed: number }>(`/api/campaigns/${id}/rows/remove`, {
    method: 'POST', body: JSON.stringify({ ids }),
  });

/** Retire queued rows that are already Contacts. Idempotent; safe to re-run. */
export const recheckCampaignRowsApi = (id: string) =>
  apiFetch<{ ok: boolean; scanned: number; marked: number; complete: boolean; campaign: Campaign }>(
    `/api/campaigns/${id}/rows/recheck`, { method: 'POST' });

export const restoreCampaignRowsApi = (id: string, ids: string[]) =>
  apiFetch<{ ok: boolean; restored: number }>(`/api/campaigns/${id}/rows/restore`, {
    method: 'POST', body: JSON.stringify({ ids }),
  });

export const deleteCampaignApi = (id: string, purgeRows = false) =>
  apiFetch<{ ok: boolean; purgedRows: number }>(
    `/api/campaigns/${id}${purgeRows ? '?purgeRows=1' : ''}`, { method: 'DELETE' });

// ── LinkedIn scrape runs ────────────────────────────────────────────────────
// The harvest itself runs on a worker on Prashuk's Mac, not on the server —
// `jl harvest` drives a real logged-in Chrome over CDP and has no headless
// path. These endpoints are the queue between the two.

export type ScrapeRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

export interface ScrapeRun {
  id: string;
  status: ScrapeRunStatus;
  trigger: 'manual' | 'scheduled';
  queries: string[];
  claimedAt: string | null;
  finishedAt: string | null;
  workerHost: string;
  stats: { rendered: number; hiring: number; new: number; seen: number; searches: number };
  /** Live, overwritten as the harvest runs. `stats` is only written at the end. */
  progress: {
    currentQuery: string;
    searchesDone: number;
    searchesTotal: number;
    rendered: number;
    hiring: number;
    new: number;
    perQuery: Array<{ query: string; rendered: number; hiring: number; new: number }>;
    updatedAt: string | null;
  };
  importResult: { created: number; skipped: number; updated: number; skippedInBatch: number };
  error: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScrapeSchedule {
  id: string;
  enabled: boolean;
  days: number[];          // 0 = Sunday .. 6 = Saturday
  time: string;            // 'HH:mm', wall clock in `timezone`
  timezone: string;
  queries: string[];
  catchUpHours: number;
  lastFiredAt: string | null;
}

export interface ScrapeWorkerState {
  everSeen: boolean;
  online: boolean;
  lastSeenAt: string | null;
  host: string;
  chromeUp: boolean;
  linkedinLoggedIn: boolean;
  /** Next `pmset` wake, so an offline message can name a time instead of "eventually". */
  nextWakeAt: string | null;
}

export interface ScrapeStatus {
  activeRun: ScrapeRun | null;
  lastRun: ScrapeRun | null;
  worker: ScrapeWorkerState;
  schedule: ScrapeSchedule;
  nextOccurrence: string | null;
  /** The worker's config.json query list — what you pick a run's queries from. */
  defaultQueries: string[];
  /** Set for 7 days after LinkedIn shows a checkpoint. Nothing may run until it passes. */
  blockedUntil: string | null;
  blockedReason: string;
}

export const scrapeStatusApi = () => apiFetch<ScrapeStatus>('/api/scrapes/status');

/** A worker run for the floating progress panel (routes/runs.js). */
export interface WorkerRunCard {
  id: string;
  /** 'linkedin' or a job platform id. */
  source: string;
  label: string;
  kind: string;
  kindLabel: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
  createdAt: string;
  finishedAt: string | null;
  detail: string;
  done: number;
  total: number;
  unit: string;
  counts: Partial<Record<'found' | 'hiring' | 'new' | 'applied' | 'skipped' | 'failed' | 'rehearsed' | 'tracked', number>>;
  error: string | null;
  link: string;
}
export const activeRunsApi = () => apiFetch<{ runs: WorkerRunCard[] }>('/api/runs/active');

export const listScrapeRunsApi = (page = 1, limit = 20) =>
  apiFetch<{ runs: ScrapeRun[]; total: number; page: number; limit: number; pages: number }>(
    `/api/scrapes?page=${page}&limit=${limit}`);

/** 409 when a run is already queued or running; 423 while a checkpoint block is active. */
export const queueScrapeApi = (queries: string[]) =>
  apiFetch<{ run: ScrapeRun }>('/api/scrapes', { method: 'POST', body: JSON.stringify({ queries }) });

export const cancelScrapeApi = (id: string) =>
  apiFetch<{ run: ScrapeRun }>(`/api/scrapes/${id}/cancel`, { method: 'POST' });

export const updateScrapeScheduleApi = (patch: Partial<Pick<ScrapeSchedule,
  'enabled' | 'days' | 'time' | 'timezone' | 'queries' | 'catchUpHours'>>) =>
  apiFetch<{ schedule: ScrapeSchedule; nextOccurrence: string | null }>(
    '/api/scrapes/schedule', { method: 'PUT', body: JSON.stringify(patch) });

// ── First-run setup ──────────────────────────────────────────────────────────

export interface OnboardingStatus {
  complete: boolean;
  step: number;
  skipped: string[];
  steps: string[];
  required: string[];
  checks: { gmail: boolean; identity: boolean; templates: boolean; resume: boolean };
  gmailEmail: string;
  senderName: string;
  senderCompany: string;
  templateCount: number;
  /** False when the server has no CREDENTIAL_KEY, which makes the Gmail step —
   *  and therefore onboarding — impossible until an operator sets one. */
  credentialKeyConfigured: boolean;
}

export const onboardingStatusApi = () => apiFetch<OnboardingStatus>('/api/onboarding/status');

export const onboardingStepApi = (step: number) =>
  apiFetch<{ ok: true }>('/api/onboarding/step', { method: 'PUT', body: JSON.stringify({ step }) });

export const onboardingSkipApi = (step: string) =>
  apiFetch<{ ok: true }>('/api/onboarding/skip', { method: 'POST', body: JSON.stringify({ step }) });

export const onboardingSeedTemplatesApi = () =>
  apiFetch<{ created: number; total: number }>('/api/onboarding/templates', { method: 'POST' });

export const onboardingStarterTemplatesApi = () =>
  apiFetch<Array<{ key: string; name: string; subject: string; body: string }>>('/api/onboarding/starter-templates');

export const onboardingCompleteApi = () =>
  apiFetch<{ ok: true }>('/api/onboarding/complete', { method: 'POST' });

/** Verifies the credential over SMTP before storing it, so a failure here means
 *  the App Password genuinely does not work — not that saving failed. */
export const connectGmailApi = (email: string, appPassword: string, name?: string) =>
  apiFetch<{ ok: true; message: string }>('/api/config', {
    method: 'POST', body: JSON.stringify({ email, appPassword, name }),
  });

export const disconnectGmailApi = () =>
  apiFetch<{ ok: true }>('/api/settings/gmail', { method: 'DELETE' });

// ── Admin (fleet-wide) ───────────────────────────────────────────────────────
// Everything here is behind requireAdmin on the server. The client's own
// isAdmin check only decides whether to render the link.

export interface AdminCount { total: number; by: Record<string, number> }

export interface AdminUserRow {
  id: string | null;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Can see the shared Library tab (admins always can). */
  libraryAccess?: boolean;
  /** May run on the owner's AI keys when they have none of their own. */
  aiOwnerFallback?: boolean;
  /** Link to their browser on the cloud VM; null when their workers run on their own computer. */
  cloudScreenUrl?: string | null;
  /** When they agreed to their logins living on the VM; null = not yet. */
  cloudConsentAt?: string | null;
  /** Their data is part of the shared Library (they have not opted out). */
  librarySharing?: boolean;
  status: 'active' | 'invited' | 'disabled' | 'n/a';
  createdAt: string | null;
  lastLoginAt: string | null;
  /** Last time a person used the app (hour granularity). Null before lifecycle emails shipped. */
  lastActiveAt?: string | null;
  /** Email types off for this account: by an admin, and by the user's own choice. */
  emails?: { blockedByAdmin: LifecycleType[]; optOut: string[] };
  activeSessions: number;
  onboarding: { completedAt: string | null; step: number; skipped: string[]; current: boolean };
  config: {
    hasGmail: boolean; hasResume: boolean; settingsDocs: number; templates: number;
    /** How many of their own AI keys are saved, 0–3. */
    aiKeyCount?: number;
    hasWorkerToken: boolean; hasShareToken: boolean; lastMailboxCheckAt: string | null;
  };
  contacts: AdminCount & { everSent: number; everReplied: number; everFollowedUp: number; lastSentAt: string | null };
  campaigns: AdminCount;
  leads: AdminCount;
  scrapes: AdminCount & { lastRunAt: string | null };
  sendJobs: AdminCount;
  interviews: AdminCount;
  activity: { events: number; events30d: number; lastEventAt: string | null };
}

export interface AdminOverview {
  generatedAt: string;
  days: number;
  users: AdminUserRow[];
  /** Documents with no userId — they predate the multi-tenant backfill and are
   *  invisible to every account, so only an admin will ever see them. */
  unassigned: AdminUserRow | null;
  totals: {
    users: number; active: number; invited: number; disabled: number;
    onboarded: number; withGmail: number; contacts: number;
    everSent: number; everReplied: number; replyRate: number;
    leads: number; campaigns: number; interviews: number;
    activeSessions: number; scrapeFailures: number; duplicateSettings: number;
    pendingRequests: number;
  };
  series: Array<{ day: string; sent: number; replied: number }>;
  signups: Array<{ month: string; n: number }>;
}

export const adminOverviewApi = (days = 30) =>
  apiFetch<AdminOverview>(`/api/admin/users?days=${days}`);

export interface AdminPlatformRun {
  account: string;
  platform: 'naukri' | 'instahyre' | 'hirist';
  platformLabel: string;
  kind: 'refresh' | 'harvest' | 'apply' | 'probe' | 'track';
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
  trigger: 'manual' | 'scheduled';
  dryRun: boolean;
  createdAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  results: { found: number; new: number; updated: number; applied: number; skipped: number; failed: number; rehearsed: number; tracked: number };
}
export const adminPlatformRunsApi = (q: { days?: number | 'all'; page?: number; status?: string; kind?: string; platform?: string; userId?: string } = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) if (value !== undefined && value !== '') params.set(key, String(value));
  return apiFetch<{ runs: AdminPlatformRun[]; total: number; page: number; limit: number; days: number; pages: number }>(
    `/api/admin/platform-runs?${params.toString()}`,
  );
};

/** Creates the account and, unless `notify` is false, emails them to say so. */
export const adminInviteApi = (email: string, opts?: { name?: string; isAdmin?: boolean; notify?: boolean }) =>
  apiFetch<{ ok: true; id: string; email: string; status: string; emailed: boolean; warning?: string }>(
    '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, name: opts?.name, isAdmin: opts?.isAdmin, notify: opts?.notify }),
    });

export const adminUpdateUserApi = (id: string, patch: { status?: string; isAdmin?: boolean }) =>
  apiFetch<{ ok: true; revoked: number }>(`/api/admin/users/${id}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });

/** Show or hide the shared Library tab for one account (admins always see it). */
export const adminSetLibraryAccessApi = (id: string, on: boolean) =>
  apiFetch<{ ok: true; libraryAccess: boolean }>(`/api/admin/users/${id}/library-access`, {
    method: 'POST', body: JSON.stringify({ on }),
  });

export const adminRevokeSessionsApi = (id: string) =>
  apiFetch<{ ok: true; revoked: number }>(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' });

// ── One account (admin): analytics, numbers only, and actions ───────────────
/** GET /api/admin/users/:id/analytics — every name/company/text field stripped server-side. */
export interface AdminUserAnalytics {
  user: { id: string; email: string; name: string; status: string; isAdmin: boolean; lastActiveAt: string | null; createdAt: string };
  label: string;
  report: Omit<ReportStats, 'label' | 'topReplies' | 'waiting' | 'upcomingInterviews'> & {
    waiting: { count: number };
    upcomingInterviewCount: number;
  };
  discover: Omit<DiscoverAnalytics, 'topRoles' | 'companies'>;
  naukri?: NaukriAnalytics | null;
  pipeline: {
    contacts: Record<string, number>; approval: Record<string, number>; replies: Record<string, number>;
    leads: Record<string, number>; leadsByApply?: Record<string, number>; interviews: Record<string, number>;
  };
  sending: {
    jobs: Record<string, number>; campaigns: Record<string, number>;
    pausedByAdmin: { jobs: number; campaigns: number };
    hasGmail: boolean; lastMailboxCheckAt: string | null;
  };
}
export const adminUserAnalyticsApi = (id: string, q: ReportPeriodQuery, days = 30) =>
  apiFetch<AdminUserAnalytics>(`/api/admin/users/${id}/analytics?${reportQueryString(q)}&days=${days}`);

export const adminPauseSendingApi = (id: string) =>
  apiFetch<{ ok: true; jobs: number; campaigns: number }>(`/api/admin/users/${id}/sending/pause`, { method: 'POST' });
export const adminResumeSendingApi = (id: string) =>
  apiFetch<{ ok: true; jobs: number; jobsDone: number; jobsNoCredentials: number; campaigns: number; campaignsCompleted: number }>(
    `/api/admin/users/${id}/sending/resume`, { method: 'POST' });

export type AdminSendNowType = 'weekly-report' | 'welcome' | 'setup-reminder' | 'inactive';
export const adminSendEmailNowApi = (id: string, type: AdminSendNowType) =>
  apiFetch<{ ok: boolean; status: string; reason?: string; to?: string; testMode?: boolean }>(
    `/api/admin/users/${id}/emails/send`, { method: 'POST', body: JSON.stringify({ type }) });

export const adminCheckMailboxApi = (id: string) =>
  apiFetch<{ ok: boolean; skipped?: 'no_credentials'; scanned?: number; replied?: number; bounced?: number }>(
    `/api/admin/users/${id}/check-mailbox`, { method: 'POST' });

/** Cloud browser link for an account; with issueToken also a new worker token, shown once. */
export const adminSetCloudWorkerApi = (id: string, screenUrl: string, issueToken: boolean) =>
  apiFetch<{ ok: true; cloudScreenUrl: string; token?: string;
    email?: { status: string; reason: string | null; testMode: boolean } }>(
    `/api/admin/users/${id}/cloud-worker`, { method: 'POST', body: JSON.stringify({ screenUrl, issueToken }) });

export const adminRemoveCloudWorkerApi = (id: string, revokeToken: boolean) =>
  apiFetch<{ ok: true; tokenRevoked: boolean }>(
    `/api/admin/users/${id}/cloud-worker${revokeToken ? '?revokeToken=1' : ''}`, { method: 'DELETE' });

export const adminOtpHealthApi = () =>
  apiFetch<{ since: string; failures: Array<{ email: string; error: string; at: string }> }>('/api/admin/otp-health');

// ── Access requests ──────────────────────────────────────────────────────────

export interface AccessRequestRow {
  id: string;
  email: string;
  name: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  requestCount: number;
  createdAt: string;
  lastRequestedAt: string;
  decidedAt: string | null;
}

export const accessRequestsApi = (status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') =>
  apiFetch<{ pendingCount: number; requests: AccessRequestRow[] }>(`/api/admin/access-requests?status=${status}`);

/** Creates the account, then emails them. `emailed: false` means they still
 *  have access but have not been told — pass that on rather than assuming. */
export const approveAccessApi = (id: string) =>
  apiFetch<{ ok: true; id: string; email: string; emailed: boolean; warning?: string }>(
    `/api/admin/access-requests/${id}/approve`, { method: 'POST' });

export const rejectAccessApi = (id: string, note?: string) =>
  apiFetch<{ ok: true }>(`/api/admin/access-requests/${id}/reject`, {
    method: 'POST', body: JSON.stringify({ note }),
  });

export const clearAccessRequestApi = (id: string) =>
  apiFetch<{ ok: true }>(`/api/admin/access-requests/${id}`, { method: 'DELETE' });

// ── Per-account tokens ───────────────────────────────────────────────────────
// Both are returned exactly once, at issue time: only a SHA-256 of each is
// stored, so neither can be shown again afterwards. The GET endpoints answer
// "is one registered", never the value.

export const shareLinkStatusApi = () =>
  apiFetch<{ registered: boolean }>('/api/share-link');

export const issueShareLinkApi = () =>
  apiFetch<{ token: string; path: string; note: string }>('/api/share-link', { method: 'POST' });

export const revokeShareLinkApi = () =>
  apiFetch<{ ok: true }>('/api/share-link', { method: 'DELETE' });

export const workerTokenStatusApi = () =>
  apiFetch<{ registered: boolean; cloudScreenUrl?: string | null; cloudConsentAt?: string | null }>('/api/scrapes/worker-token');

/** The user agrees to their job-site logins being kept on the cloud VM. */
export const cloudConsentApi = () =>
  apiFetch<{ ok: true; cloudConsentAt: string }>('/api/scrapes/cloud-consent', { method: 'POST' });

export const issueWorkerTokenApi = () =>
  apiFetch<{ token: string; note: string }>('/api/scrapes/worker-token', { method: 'POST' });

export const revokeWorkerTokenApi = () =>
  apiFetch<{ ok: true }>('/api/scrapes/worker-token', { method: 'DELETE' });

// ── Naukri ───────────────────────────────────────────────────────────────────
// Self-contained: its own models, routes, worker and tab. Like the LinkedIn
// scrape it runs on the Mac, because it drives a real logged-in Chrome over CDP
// and has no headless path — these endpoints are the queue between the two.
//
// The one rule worth knowing from the client side: a harvest may only ever
// create a job as `pending`. Approving is the ONLY thing that authorises an
// application, which is why decideNaukriJobsApi is also what queues the run.

export type NaukriRunKind = 'refresh' | 'harvest' | 'apply' | 'probe' | 'track';
/** What a recruiter did, read from Naukri's application history. */
export type NaukriStage = 'applied' | 'viewed' | 'shortlisted' | 'contacted' | 'not-shortlisted';
export type NaukriRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
export type NaukriApproval = 'pending' | 'approved' | 'rejected';
export type NaukriApplyStatus =
  | 'none' | 'applied' | 'skipped' | 'failed' | 'dismissed'
  | 'in-review' | 'interviewing' | 'offer' | 'rejected';

export interface NaukriRun {
  id: string;
  platform?: PlatformId;
  kind: NaukriRunKind;
  status: NaukriRunStatus;
  trigger: 'manual' | 'scheduled';
  /** Snapshotted at claim time, so a config change mid-run can't turn a rehearsal real. */
  dryRun: boolean;
  /** Harvest only: this run's own source choice; null = the configured default. */
  sources?: NaukriSources | null;
  claimedAt: string | null;
  finishedAt: string | null;
  workerHost: string;
  progress: {
    phase: string; label: string;
    page: number; pagesTotal: number;
    found: number; new: number;
    applied: number; skipped: number; failed: number;
    updatedAt: string | null;
  };
  stats: {
    found: number; new: number; updated: number;
    applied: number; skipped: number; failed: number; rehearsed: number; searches: number;
    /** Harvest only: new jobs auto-approve moved straight to Waiting. */
    autoApproved?: number;
    /** Apply only: left out because another platform had already applied. */
    dupSkipped?: number;
    /** Harvest only: listings read off Recommended jobs. */
    recommended?: number;
    /** Track only: recruiter actions read, and jobs moved in your pipeline. */
    tracked?: number;
    moved?: number;
  };
  results: Array<{
    jobId: string; title: string; company: string;
    outcome: 'applied' | 'skipped' | 'failed' | 'dry-run';
    reason: string; at: string;
  }>;
  error: string | null;
  /** 2 means Naukri showed a captcha — a hard stop, blocked for 7 days. */
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NaukriJob {
  id: string;
  sourceId: string;
  title: string;
  company: string;
  location: string;
  experienceMin: number | null;
  experienceMax: number | null;
  salaryText: string;
  tags: string[];
  url: string;
  postedText: string;
  queries: string[];
  /** Where it was found: your searches, the site's recommended / matched feed,
      or a recruiter reaching out (Instahyre). */
  origins?: Array<'search' | 'recommended' | 'recruiter'>;
  /** Which job platform it is on. */
  platform?: PlatformId;
  dupKey?: string;
  /** Its furthest-along copy on another platform, worked out on read. */
  dup?: JobDuplicate | null;
  dupOverride?: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  approval: NaukriApproval;
  approvedAt: string | null;
  /** 'auto' when auto-approve moved it to Waiting on its score. */
  approvedBy?: 'you' | 'auto' | null;
  /** Furthest recruiter action Naukri reports, and when. */
  naukriStage?: NaukriStage | null;
  naukriStageAt?: string | null;
  naukriTimeline?: Array<{ id: number; value: string; at: string | null }>;
  listingOpen?: boolean | null;
  /** Cleared out of the inbox by the tidy rules; Restore brings it back. */
  tidiedAt?: string | null;
  tidyReason?: string;
  /** 0–100 fit (lib/naukriScore.js). Null for rows harvested before scoring. */
  score?: number | null;
  scoreReasons?: string[];
  applyStatus: NaukriApplyStatus;
  appliedAt: string | null;
  applyNote: string;
  /** False when no future run can succeed on this — an external ATS, or already applied. */
  retryable: boolean;
  /** Predicted at harvest to apply on the company's own site, from employers already seen doing it. */
  likelyExternal: boolean;
  /** Non-zero means it jumps the queue on the next apply run. */
  priority: number;
  /** The screening question that caused a skip — offered as a one-click answer rule. */
  unknownQuestion: string;
  applyHistory: Array<{ at: string; from: string; to: string; note: string }>;
}

export interface JobDuplicate {
  platform: PlatformId; label: string;
  state: 'applied' | 'approved' | 'pending';
  at: string | null; jobId: string;
  /** "Already applied via Naukri on 12 Oct" / "Approved on Hirist" / "Also on …" */
  text: string;
}

export interface NaukriSchedule {
  enabled: boolean;
  days: number[];          // 0 = Sunday .. 6 = Saturday
  time: string;            // 'HH:mm', wall clock in `timezone`
  timezone: string;
  catchUpHours: number;
  lastFiredAt: string | null;
  runRefresh: boolean;
  runHarvest: boolean;
  /** Off by default: applying should follow your approvals, not a clock. */
  runApply: boolean;
  /** Read recruiter actions from Naukri (read-only). On by default. */
  runTrack?: boolean;
  /** Times 2 and 3, each with its own kinds. Empty = the single time above. */
  extraSlots: NaukriSlot[];
}

export type NaukriRecommendedTab = 'apply' | 'profile' | 'preference' | 'similar_jobs';
export interface NaukriSources {
  searches: boolean; recommended: boolean;
  /** Which Recommended-jobs tabs to read. Missing = all four. */
  recommendedTabs?: NaukriRecommendedTab[];
}

export interface NaukriSlot { time: string; runRefresh: boolean; runHarvest: boolean; runApply: boolean; runTrack?: boolean }

export interface NaukriInboxTidy { enabled: boolean; maxAgeDays: number; minScore: number; companySite: boolean }

export interface NaukriStageTally { sent: number; viewed: number; shortlisted: number; contacted: number; notShortlisted: number }

export interface NaukriResults extends NaukriStageTally {
  days: number;
  lastTracked: string | null;
  bySource: { search: NaukriStageTally; recommended: NaukriStageTally };
  byScore: Record<string, NaukriStageTally>;
}

export interface NaukriSetupItem { key: string; label: string; done: boolean; hint: string; card: string | null }

/** A scheduled wake: when, and which runs it starts. */
export interface NaukriOccurrence { at: string; kinds: NaukriRunKind[] }

export interface NaukriSearch {
  label: string; keywords: string; location: string;
  experienceYears: number | null; url: string; enabled: boolean;
}

export interface NaukriFilters {
  titleInclude: string[]; titleExclude: string[]; companyExclude: string[];
  locations: string[]; remoteOnly: boolean;
  minExperienceYears: number | null; maxExperienceYears: number | null;
  minSalaryLpa: number | null; maxPostedAgeDays: number | null;
  skipAlreadyApplied: boolean;
}

export interface NaukriProfileFields {
  fullName: string; email: string; phone: string;
  noticePeriodDays: number | null;
  currentCtcLpa: number | null; expectedCtcLpa: number | null;
  totalExperienceMonths: number | null;
  currentCompany: string; currentDesignation: string; currentLocation: string;
  preferredLocations: string[]; willingToRelocate: boolean;
  highestQualification: string; skills: string[];
}

export interface NaukriAnswer {
  /** Lowercased substring matched against the question. First match wins, so order matters. */
  pattern: string;
  /** May contain {{placeholders}} resolved from the profile at apply time. */
  answer: string;
  kind: 'text' | 'choice' | 'number' | 'yesno';
  enabled: boolean;
  /** 'auto' = written by the AI during an apply; editing or keeping it makes it 'you'. */
  origin?: 'you' | 'auto';
  confidence?: number | null;
  quote?: string;
}

export interface NaukriConfig {
  id: string;
  /** Which platform this view of the config is for; its own settings are at the top level. */
  platform?: PlatformId;
  label?: string;
  capabilities?: PlatformCapabilities;
  enabled?: boolean;
  applyMode?: ApplyMode;
  readOnlySince?: string | null;
  /** Shared by every platform. */
  duplicates?: DuplicateRules;
  crossPlatformOrder?: boolean;
  schedule: NaukriSchedule;
  searches: NaukriSearch[];
  useRecommended: boolean;
  /** Where harvests look by default. The Harvest button can override per run. */
  sources: NaukriSources;
  /** Settings can only lower these; the worker's hard caps are 10 and 8. */
  searchLimits: { maxSearches: number; maxPages: number };
  /** How often the worker checks in, 15–120s. Takes effect without a restart. */
  worker: { pollSeconds: number };
  /** Draft answers from the resume for questions with no rule. */
  aiDrafts: boolean;
  /** Let the AI answer DURING an apply when at least minConfidence% sure. Off by default. */
  autoAnswer: { enabled: boolean; minConfidence: number };
  /** Clear old / poor-fit / company-site jobs out of the inbox automatically. */
  inboxTidy: NaukriInboxTidy;
  filters: NaukriFilters;
  profile: NaukriProfileFields;
  answers: NaukriAnswer[];
  onUnknownQuestion: 'skip' | 'apply-anyway';
  apply: {
    maxPerRun: number; maxPerDay: number;
    /** THE gate. While false, nothing is applied to without an approval click. */
    autoApproveEnabled: boolean; autoApproveMinScore: number;
    delayMinMs: number; delayMaxMs: number; coverNote: string;
  };
  headlineVariants: string[];
  headlineIndex: number;
  safety: {
    /** One kill switch — while true the worker is handed no work at all. */
    pauseAll: boolean;
    /** Walk the whole apply flow, fill everything, submit nothing. */
    dryRun: boolean;
  };
  /** The resume Naukri will use: a Naukri-only upload ('naukri'), else the
      one from Settings ('settings'). size 0 = none anywhere. */
  resume?: { filename: string; size: number; uploadedAt: string | null; text?: string; source?: 'naukri' | 'settings' | null };
}

export interface NaukriWorkerState {
  everSeen: boolean;
  online: boolean;
  lastSeenAt: string | null;
  host: string;
  chromeUp: boolean;
  naukriLoggedIn: boolean;
  /** Logged into THIS platform's site (same value as naukriLoggedIn). */
  loggedIn?: boolean;
  nextWakeAt: string | null;
}

export interface NaukriOverview {
  platform?: PlatformId;
  label?: string;
  capabilities?: PlatformCapabilities;
  enabled?: boolean;
  applyMode?: ApplyMode;
  readOnlySince?: string | null;
  /** New jobs first seen in the last 7 days. */
  foundThisWeek?: number;
  activeRun: NaukriRun | null;
  queuedRuns: NaukriRun[];
  history: NaukriRun[];
  worker: NaukriWorkerState;
  schedule: NaukriSchedule;
  scheduleKinds: NaukriRunKind[];
  nextOccurrence: string | null;
  upcoming: NaukriOccurrence[];
  reviewCount: number;
  /** Skipped on a screening question that has no rule yet. */
  needsAnswerCount: number;
  /** Outcomes of the last 7 days. */
  week: { applied: number; skipped: number; failed: number };
  perRun: number;
  perDay: number;
  /** The default harvest sources, for the Harvest menu's tick. */
  sources: NaukriSources;
  /** What still needs setting up — each item names the card that fixes it. */
  setup: { items: NaukriSetupItem[]; done: number; total: number } | null;
  /** What recruiters did with the last 30 days of applications. */
  results: NaukriResults | null;
  inboxTidy: NaukriInboxTidy;
  appliedCount: number;
  appliedToday: number;
  /** Approved and still actionable — what a future apply run will draw from. */
  waitingCount: number;
  /** Reached and backed out of — needs an answer rule, or can never succeed. */
  skippedCount: number;
  paused: boolean;
  dryRun: boolean;
  autoApprove: boolean;
  /** Set for 7 days after Naukri shows a captcha. Nothing may run until it passes. */
  blockedUntil: string | null;
  blockedReason: string;
}

// ── Job platforms ────────────────────────────────────────────────────────────
// Naukri, Instahyre and Hirist run through one pipeline (lib/platforms.js). The
// Job Platforms page sets which one the naukri*Api helpers below talk to;
// everything else (the Action Center, Analytics) names its platform
// explicitly, so a page left on Instahyre can never send another surface's
// call there. 'all' is the All platforms view: job lists and Needs answer only.
export type PlatformId = 'naukri' | 'instahyre' | 'hirist';
export type PlatformScope = PlatformId | 'all';
export type ApplyMode = 'off' | 'dry-run' | 'on';
export interface PlatformCapabilities {
  refresh: boolean; harvest: boolean; dryRun: boolean; apply: boolean; track: boolean;
  /** The site's job search needs no login, so harvests run while logged out. */
  publicHarvest?: boolean;
}
export interface PlatformInfo {
  id: PlatformId; label: string; color: 'blue' | 'teal' | 'purple';
  capabilities: PlatformCapabilities;
  /** Harvest choices, by label. `recommended` null = the site has no matched feed (none today). */
  sources: { searches: string; recommended: string | null };
  enabled: boolean;
  /** Null while the platform is switched off. */
  overview: NaukriOverview | null;
}
export interface DuplicateRules { windowDays: number; blockAuto: boolean; blockApply: boolean }

let naukriScope: PlatformScope = 'naukri';
// Only while the Job Platforms page is open: anywhere else these helpers are
// Naukri's, as they always were. Read from the URL rather than reset by the
// page on unmount — React's dev double-mount would run that reset between
// the page setting its scope and the cards fetching with it.
const NB = () => {
  const onPage = typeof window !== 'undefined' && /\/job-platforms/.test(window.location.pathname);
  const s = onPage ? naukriScope : 'naukri';
  return s === 'naukri' ? '/api/naukri' : `/api/p/${s}`;
};
export const setNaukriPlatform = (p: PlatformScope) => { naukriScope = p; };
export const currentNaukriPlatform = () => naukriScope;
const PB = (p: PlatformId) => (p === 'naukri' ? '/api/naukri' : `/api/p/${p}`);

export const platformsApi = () =>
  apiFetch<{ platforms: PlatformInfo[]; duplicates: DuplicateRules; crossPlatformOrder: boolean }>('/api/naukri/platforms');
export const platformOverviewApi = (p: PlatformId) => apiFetch<NaukriOverview>(`${PB(p)}/overview`);

/** Found / applied / skipped / failed per platform in a window (days in IST). */
export type CountRange = 'today' | 'yesterday' | '7d' | '30d';
export interface PlatformCounts { found: number; applied: number; skipped: number; failed: number }
export const platformCountsApi = (range: CountRange) =>
  apiFetch<{ range: CountRange; from: string; to: string; counts: Partial<Record<PlatformId, PlatformCounts>> }>(
    `/api/p/all/counts?range=${range}`);
export const queuePlatformRunApi = (p: PlatformId, kind: NaukriRunKind, opts: { sources?: NaukriSources } = {}) =>
  apiFetch<{ run: NaukriRun }>(`${PB(p)}/runs`, { method: 'POST', body: JSON.stringify({ kind, ...opts }) });
export const updatePlatformConfigApi = (p: PlatformId, patch: Record<string, unknown>) =>
  apiFetch<{ config: NaukriConfig }>(`${PB(p)}/config`, { method: 'PATCH', body: JSON.stringify(patch) });

export const naukriOverviewApi = () => apiFetch<NaukriOverview>(`${NB()}/overview`);

export const naukriConfigApi = () =>
  apiFetch<{ config: NaukriConfig; nextOccurrence: string | null; upcoming: NaukriOccurrence[]; resume: NaukriConfig['resume'] | null }>(
    `${NB()}/config`);

/** Partial save — send only the section a card owns, so two open cards can't clobber each other.
    `requeued` counts skipped jobs a changed answer (or profile field) just moved back to Waiting. */
export const updateNaukriConfigApi = (patch: Record<string, unknown>) =>
  apiFetch<{ config: NaukriConfig; nextOccurrence: string | null; upcoming: NaukriOccurrence[]; requeued: number; tidied?: number }>(
    `${NB()}/config`, { method: 'PATCH', body: JSON.stringify(patch) });

/** Run the inbox tidy rules now. */
export const tidyNaukriInboxApi = () =>
  apiFetch<{ tidied: number }>(`${NB()}/inbox/tidy`, { method: 'POST' });

/** SUGGESTED profile values read from the resume by AI — nothing is saved. */
export const naukriProfileFromResumeApi = () =>
  apiFetch<{ suggested: {
    skills: string[]; totalExperienceMonths: number | null; currentDesignation: string;
    currentCompany: string; currentLocation: string; highestQualification: string;
  } }>(`${NB()}/config/profile-from-resume`, { method: 'POST' });

/** "Add common rules" — appends the starter rules you don't already have. */
export const addNaukriStarterRulesApi = () =>
  apiFetch<{ config: NaukriConfig; added: number; requeued: number }>(
    `${NB()}/config/starter-rules`, { method: 'POST' });

export interface NaukriDraft {
  answer: string; quote: string; source: 'resume' | 'profile' | 'answer' | '';
  status: 'ready' | 'unknown' | 'error' | 'ignored';
  /** The model's own 0–100, kept only when every check passed. */
  confidence?: number;
}

/** One time the AI was asked a question: where, what it said, why it wasn't used. */
export interface NaukriAiAttempt {
  at: string;
  where: 'apply' | 'page';
  outcome: 'used' | 'below-bar' | 'rejected' | 'not-stated' | 'error';
  answer?: string; quote?: string; confidence?: number;
  /** For rejected: 'quote-not-found' | 'not-an-option' | 'years-without-dates'; for error: the provider note. */
  why?: string;
}

/** An answer you gave to a question like this one — offered, never used on its own. */
export interface NaukriSimilarAnswer { pattern: string; answer: string; score: number }

export interface NaukriAutoAnswer {
  pattern: string; answer: string; confidence: number | null; quote: string; createdAt: string | null;
}

export interface NaukriQuestionGroup {
  question: string;
  /** How many jobs this one question is blocking. */
  count: number;
  lastSeenAt: string;
  /** The choices Naukri offered, when it was a radio question. */
  options: string[];
  jobs: Array<{ id: string; title: string; company: string; url: string; platform?: PlatformId }>;
  /** Which platforms asked it. The answer bank is shared by all of them. */
  platforms?: PlatformId[];
  draft: NaukriDraft | null;
  /** The last few AI attempts at this question, newest first. */
  attempts?: NaukriAiAttempt[];
  similar?: NaukriSimilarAnswer[];
}

export const naukriNeedsAnswerApi = () =>
  apiFetch<{
    aiDrafts: boolean; hasResumeText: boolean; questions: NaukriQuestionGroup[];
    autoAnswer: { enabled: boolean; minConfidence: number };
    /** Answers the AI gave live during applies, for review. */
    autoAnswered: NaukriAutoAnswer[];
    /** Jobs sent back to Waiting just now because a draft was confident enough. */
    autoRequeued?: number;
  }>(`${NB()}/needs-answer`);

export const reviewNaukriAutoAnswerApi = (pattern: string, action: 'keep' | 'edit' | 'remove', answer?: string) =>
  apiFetch<{ ok: true }>(`${NB()}/needs-answer/auto`, { method: 'POST', body: JSON.stringify({ pattern, action, answer }) });

export const draftNaukriAnswerApi = (question: string) =>
  apiFetch<{ draft: NaukriDraft; note?: string | null; autoUsed?: boolean; requeued?: number; attempt?: NaukriAiAttempt }>(
    `${NB()}/needs-answer/draft`, { method: 'POST', body: JSON.stringify({ question }) });

/** Make it a rule; every job blocked on it goes back to Waiting. */
export const useNaukriAnswerApi = (question: string, answer: string, pattern?: string) =>
  apiFetch<{ requeued: number; platforms?: Array<{ id: PlatformId; label: string }> }>(
    `${NB()}/needs-answer/use`, { method: 'POST', body: JSON.stringify({ question, answer, pattern }) });

export const ignoreNaukriQuestionApi = (question: string) =>
  apiFetch<{ dismissed: number }>(
    `${NB()}/needs-answer/ignore`, { method: 'POST', body: JSON.stringify({ question }) });

/** 409 when a run is already active; 423 while paused or inside a captcha block. */
export const queueNaukriRunApi = (kind: NaukriRunKind, opts: { sources?: NaukriSources } = {}) =>
  apiFetch<{ run: NaukriRun }>(`${NB()}/runs`, { method: 'POST', body: JSON.stringify({ kind, ...opts }) });

export const cancelNaukriRunApi = (id: string) =>
  apiFetch<{ run: NaukriRun }>(`${NB()}/runs/${id}/cancel`, { method: 'POST' });

export const listNaukriRunsApi = (page = 1, limit = 20, kind?: NaukriRunKind) =>
  apiFetch<{ runs: NaukriRun[]; total: number; page: number; limit: number; pages: number }>(
    `${NB()}/runs?page=${page}&limit=${limit}${kind ? `&kind=${kind}` : ''}`);

export interface NaukriJobQuery {
  /** Ask for a named set the server defines — 'waiting' is exactly what the
      Waiting badge counts, so the list and the number cannot disagree. */
  bucket?: 'waiting' | 'skipped' | 'needs-answer' | 'company-site' | 'other-skipped';
  approval?: NaukriApproval;
  /** 'sent' = actually went out (applied and beyond); 'any' = every outcome, skips included. */
  applyStatus?: NaukriApplyStatus | 'any' | 'sent';
  /** Free text over title, company and tags. */
  q?: string;
  location?: string;
  /** Experience bands are kept when they OVERLAP this range, not when contained. */
  minExp?: number | null;
  maxExp?: number | null;
  /** Listings that do not publish pay are kept — most of Naukri hides it. */
  minSalary?: number | null;
  maxAge?: number | null;
  sort?: 'score' | 'queue' | 'newest' | 'oldest' | 'experience' | 'company';
  /** Filter by how the job is applied to: 'native' (not a known company-site
      employer) or 'external' (one that is). A prediction, not a guarantee. */
  applyType?: 'native' | 'external';
  /** Where it was found. 'search' includes rows from before origins were recorded. */
  origin?: 'search' | 'recommended';
  /** '1' = only jobs the inbox tidy cleared away. */
  tidied?: '1';
  /** Applied only: by what the recruiter did. 'none' = no action seen yet. */
  stage?: 'none' | 'viewed' | 'shortlisted' | 'contacted' | 'not-shortlisted';
  page?: number;
  limit?: number;
}

export const listNaukriJobsApi = (params: NaukriJobQuery = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return apiFetch<{
    jobs: NaukriJob[]; total: number; page: number; limit: number; pages: number;
    /** Set when salary/age refinement hit its scan ceiling, so the count is a floor. */
    truncated?: boolean;
    /** Sizes for the apply-type chips, ignoring the type facet itself. */
    typeCounts?: { all: number; external: number; native: number };
    /** Sizes for the Searches / Recommended chips. A job found both ways counts in both. */
    originCounts?: { all: number; search: number; recommended: number };
    /** Applied only: how many sit at each recruiter stage. */
    stageCounts?: Record<'none' | 'viewed' | 'shortlisted' | 'contacted' | 'not-shortlisted', number> | null;
  }>(`${NB()}/jobs?${qs.toString()}`);
};

/** The authorisation point: approving is what permits an application, and it queues the run. */
export const decideNaukriJobsApi = (ids: string[], decision: NaukriApproval, reason?: string) =>
  apiFetch<{ updated: number; run: NaukriRun | { error: string } | null }>(
    `${NB()}/jobs/decide`, { method: 'POST', body: JSON.stringify({ ids, decision, reason }) });

/**
 * Act on a selection. The action names differ by where you are:
 * 'apply-next' sends these on the next run (ahead of the rest), 'skip' sets
 * them aside, 'requeue' puts skipped ones back, 'dismiss' rejects them.
 */
export const bulkNaukriJobsApi = (
  ids: string[],
  action: 'apply-next' | 'skip' | 'requeue' | 'dismiss' | 'restore' | 'allow-duplicate',
  reason?: string,
) => apiFetch<{ updated: number; run: NaukriRun | { error: string } | null }>(
  `${NB()}/jobs/bulk`, { method: 'POST', body: JSON.stringify({ ids, action, reason }) });

export const updateNaukriJobApi = (id: string, patch: { applyStatus?: NaukriApplyStatus; applyNote?: string }) =>
  apiFetch<{ job: NaukriJob }>(`${NB()}/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

/** Runs the same resolver the worker does, so the tester cannot disagree with reality. */
export const testNaukriAnswerApi = (question: string) =>
  apiFetch<{
    question: string; matched: boolean; answer: string | null; kind: string | null;
    pattern: string | null; ruleIndex: number | null; reason: string | null;
    missing: string[]; wouldSkip: boolean;
  }>(`${NB()}/config/test-answer`, { method: 'POST', body: JSON.stringify({ question }) });

/** "Would have kept 18 of 47", replayed against your last harvest before you commit. */
export const previewNaukriFiltersApi = (filters: Partial<NaukriFilters>) =>
  apiFetch<{
    counts: { total: number; kept: number; dropped: number };
    examples: Array<{ title: string; company: string; reason: string }>;
  }>(`${NB()}/config/preview-filters`, { method: 'POST', body: JSON.stringify({ filters }) });

/** Questions that caused skips — the loop by which the answer bank fills itself. */
export const naukriUnknownQuestionsApi = () =>
  apiFetch<{
    /** Only ones that still have no matching rule. */
    questions: Array<{ question: string; count: number; lastSeenAt: string }>;
    /** How many caused a skip but are now covered — lets the UI say "all answered". */
    answeredCount: number;
  }>(`${NB()}/config/unknown-questions`);

export const deleteNaukriResumeApi = () =>
  apiFetch<{ ok: true }>(`${NB()}/resume`, { method: 'DELETE' });

// ── Lifecycle emails & reports ───────────────────────────────────────────────

export type LifecycleType = 'welcome' | 'setup-reminder' | 'inactive' | 'weekly-report' | 'manual-report' | 'admin-daily'
  | 'ai-key-announce' | 'ai-key-ended' | 'cloud-browser';

export interface LifecycleConfig {
  enabled: boolean;
  firstEnabledAt: string | null;
  testMode: boolean;
  testRecipient: string;
  types: Record<LifecycleType, boolean>;
}

export interface AdminEmailsView {
  config: LifecycleConfig;
  types: Array<{ key: LifecycleType; label: string }>;
  counts: Record<LifecycleType, { sent: number; failed: number; skipped: number; testOnly: number; skippedBy: Record<string, number> }>;
  recentFailures: Array<{ email: string; type: LifecycleType; attempts: number; at: string }>;
  changes: Array<{ field: string; value: boolean; byEmail: string; at: string }>;
  readiness: { sender: boolean; links: boolean };
}

export const adminEmailsApi = () => apiFetch<AdminEmailsView>('/api/admin/emails');
export const adminSetEmailSwitchApi = (field: string, value: boolean) =>
  apiFetch<{ config: LifecycleConfig }>('/api/admin/emails', { method: 'PUT', body: JSON.stringify({ field, value }) });
export const adminSendSampleApi = (type: LifecycleType) =>
  apiFetch<{ ok: true; to: string }>('/api/admin/emails/sample', { method: 'POST', body: JSON.stringify({ type }) });
/** Sends the daily admin digest (today so far) to the admin who clicks. Ignores the switches. */
export const adminSendDigestNowApi = () =>
  apiFetch<{ ok: true; to: string }>('/api/admin/emails/daily-digest', { method: 'POST' });
/** One gate answer: will it send, and if not, the first switch that stops it. */
export interface EmailVerdict { send: boolean; reason: string | null; testMode: boolean }
export interface UpcomingEmail {
  userId: string; email: string; name: string; type: LifecycleType; due: string;
  missing?: string[];                       // setup reminder: readiness keys still missing
  since?: string;                           // inactive: when the quiet spell began
  period?: { from: string; to: string };    // weekly report: the week it covers
  now: EmailVerdict;                        // with the switches as saved
  ifOn: EmailVerdict;                       // as if the master switch were on
}
export interface AdminUpcomingEmails {
  generatedAt: string; until: string; days: number; masterOn: boolean;
  runs: Array<{ at: string; kind: 'daily' | 'weekly' | 'admin-daily'; items: UpcomingEmail[] }>;
  midSetup: Array<{ userId: string; email: string; name: string }>;
}
export interface LifecycleLogRow {
  id: string; userId: string; email: string; name: string; type: LifecycleType;
  status: 'sent' | 'skipped' | 'failed' | 'claimed'; reason: string | null; testMode: boolean;
  attempts: number; about: string | null; sentAt: string | null; createdAt: string; updatedAt: string;
}
export const adminUpcomingEmailsApi = (days = 3) =>
  apiFetch<AdminUpcomingEmails>(`/api/admin/emails/upcoming?days=${days}`);
export const adminEmailLogApi = (q: { type?: string; status?: string; before?: string | null; limit?: number } = {}) => {
  const p = new URLSearchParams();
  if (q.type) p.set('type', q.type);
  if (q.status) p.set('status', q.status);
  if (q.before) p.set('before', q.before);
  p.set('limit', String(q.limit || 50));
  return apiFetch<{ rows: LifecycleLogRow[]; next: string | null }>(`/api/admin/emails/log?${p}`);
};
/** `type: null` = every email type at once (Enable all / Disable all). */
export const adminSetUserEmailApi = (id: string, type: LifecycleType | null, blocked: boolean) =>
  apiFetch<{ ok: true; blockedByAdmin: LifecycleType[] }>(`/api/admin/users/${id}/emails`, {
    method: 'PATCH', body: JSON.stringify(type ? { type, blocked } : { all: true, blocked }),
  });

export interface EmailPref { key: 'reminders' | 'weekly-report'; label: string; on: boolean; blockedByAdmin: boolean }
export const emailPrefsApi = () => apiFetch<{ prefs: EmailPref[] }>('/api/settings/email-prefs');
export const setEmailPrefApi = (key: EmailPref['key'], on: boolean) =>
  apiFetch<{ prefs: EmailPref[] }>('/api/settings/email-prefs', { method: 'PUT', body: JSON.stringify({ key, on }) });

export type ReportPeriodQuery =
  | { period: 'last-week' | 'this-week' | 'last-30' }
  | { period: 'week'; week: string }
  | { period: 'custom'; from: string; to: string };

export interface ReportHeadline { value: number; previous: number; delta: number }
export interface ReportStats {
  label: string;
  period: { from: string; to: string; kind: string; days: number };
  previous: { from: string; to: string };
  generatedAt: string;
  quiet: boolean;
  headline: { sent: ReportHeadline; replies: ReportHeadline; replyRate: ReportHeadline; interviews: ReportHeadline };
  outreach: { firstSends: number; followUps: number; bounced: number; failed: number };
  series: { unit: 'day' | 'week'; points: Array<{ day: string; sent: number; replies: number }> };
  replyCategories: Array<{ key: string; label: string; n: number }>;
  campaigns: Array<{ name: string; status: string; sent: number; remaining: number; finishedInPeriod: boolean }>;
  pipeline: { leadsAdded: number; leadsApplied: number; naukriApplied: number; interviewsNew: number; interviewMoves: Array<{ status: string; n: number }> };
  topReplies: Array<{ name: string; company: string; category: string; categoryLabel: string; repliedAt: string }>;
  waiting: { count: number; items: Array<{ name: string; company: string; categoryLabel: string; repliedAt: string }> };
  upcomingInterviews: Array<{ name: string; company: string; role: string; round: string; interviewAt: string }>;
  /** First sends / replies / bounces by where the contact came from. Absent on older servers. */
  naukri?: { applied: number; skipped: number; failed: number; autoApproved: number; aiAsked: number; aiAnswered: number; viewed: number; shortlisted: number; notShortlisted: number };
  bySource?: Array<{ key: 'outreach' | 'lead' | 'discover' | 'library' | 'naukri'; label: string; sent: number; replies: number; bounced: number; replyRate: number }>;
}

export const reportQueryString = (q: ReportPeriodQuery) => new URLSearchParams(q as Record<string, string>).toString();
export const reportApi = (q: ReportPeriodQuery) => apiFetch<ReportStats>(`/api/reports?${reportQueryString(q)}`);
export const reportPdfUrl = (q: ReportPeriodQuery) => `${API_BASE}/api/reports/pdf?${reportQueryString(q)}`;
export const reportWeeksApi = () => apiFetch<{ weeks: Array<{ week: string; label: string }> }>('/api/reports/weeks');
export const emailReportApi = (q: ReportPeriodQuery) =>
  apiFetch<{ ok: true; to: string }>(`/api/reports/email?${reportQueryString(q)}`, { method: 'POST' });

// ── Discover (prospects) ──────────────────────────────────────────────

export type EmailConfidence = 'high' | 'medium' | 'low' | 'generic';
export type ProspectStatus = 'new' | 'ready' | 'moved' | 'discarded' | 'error';
export type DiscoveryProvider = 'tavily' | 'serpapi' | 'hunter' | 'github';

export interface Prospect {
  id: string;
  domain: string;
  company: string;
  name: string;
  title: string;
  linkedin: string | null;
  foundVia: string[];
  roleMatch: boolean;
  knownEmail: string | null;
  email: string | null;
  emailPattern: string | null;
  emailConfidence: EmailConfidence | null;
  emailSource: string | null;
  note: string;
  status: ProspectStatus;
  existingContactId: string | null;
  contactedAs: string | null;
  contactId: string | null;
  movedAt: string | null;
  createdAt: string;
}

export interface ProspectSearchStep {
  key: 'company' | 'people-search' | 'github' | 'website' | 'web-format' | 'pattern' | 'emails';
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  found: number;
  detail: string;
  /** Facts for the plain-English report; shape varies per step. */
  info?: Record<string, any>;
  at: string | null;
}

export interface ProspectSearch {
  id: string;
  domain: string;
  companyName: string;
  roles: string[];
  status: 'queued' | 'running' | 'done' | 'error';
  steps: ProspectSearchStep[];
  counts: { people: number; withEmail: number; added?: number; high?: number; medium?: number; low?: number; generic?: number; manual?: number; none?: number };
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ProspectCompany {
  domain: string;
  companyName: string;
  lastSearchAt: string;
  lastSearchId: string;
  total: number;
  open: number;
  moved: number;
}

export interface PatternSummary {
  pattern: string;
  score: number;
  replies: number;
  delivered: number;
  hardBounces: number;
  real: number;
  hunter: boolean;
  /** How many email-format directory sites name this format. */
  directory?: number;
}

export interface CompanyFormat {
  domain: string;
  companyName: string;
  hasMx: boolean | null;
  githubOrg: string | null;
  githubOrgManual: boolean;
  githubCheckedAt: string | null;
  websiteCheckedAt: string | null;
  hunterAskedAt: string | null;
  webAskedAt: string | null;
  gravatarCheckedAt: string | null;
  directory: { site: string; pattern: string; share: number | null }[];
  /** A format you set yourself (or confirmed with a test email); it wins over the automatic one. */
  manual: { pattern: string; from: 'list' | 'example' | 'test'; example: string | null; at: string | null } | null;
  /** Test emails at this company, newest first. */
  tests: FormatTest[];
  lastMailboxCheckAt: string | null;
  genericEmails: string[];
  samples: Record<string, number>;
  contactsAtDomain: number;
  decision: {
    pattern: string;
    confidence: 'high' | 'medium' | 'low';
    source: string;
    runnerUp: string | null;
    patterns: PatternSummary[];
    /** With a format set by you: what the app would pick on its own. */
    auto: { pattern: string; confidence: 'high' | 'medium' | 'low'; source: string } | null;
    /** Your own sends disagree with the format you set. */
    conflict: 'bounces' | 'replies' | null;
    conflictWith: string | null;
    /** A first-name-only format with no reply behind it: held at low/medium. */
    nameOnly?: boolean;
    /** Confirmed by a test email at a company that may accept every address. */
    catchAllRisk?: boolean;
  };
  defaultGuess: string;
}

export type FormatTestStatus = 'sending' | 'held' | 'failed' | 'waiting' | 'no-bounce' | 'replied' | 'bounced' | 'bounce-other' | 'gone';
export interface FormatTest {
  id: string;
  prospectId: string;
  contactId: string;
  name: string;
  email: string;
  pattern: string | null;
  templateKey: string;
  createdAt: string;
  confirmedAt: string | null;
  status: FormatTestStatus;
  reason: string;
  sentAt: string | null;
  /** "No bounce" needs a mailbox check after this time. */
  checkAfter: string | null;
}

export interface DiscoveryConfigView {
  keys: Record<DiscoveryProvider, boolean>;
  usage: { month: string; tavily: number; serpapi: number; hunter: number };
  caps: Record<DiscoveryProvider, number | null>;
  canStoreKeys: boolean;
  /** Roles the Discover search box starts filled with. */
  defaultRoles: string[];
  /** Outside-signal sources switched off for "Worth searching". */
  enrichOff: EnrichSource[];
}

export interface MoveProspectsResult {
  ok: boolean;
  /** New contacts plus ones these people already were. */
  contactIds?: string[];
  moved: number;
  alreadyMoved: number;
  notReady: number;
  blocked: number;
  duplicates: number;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const discoveryConfigApi = () => apiFetch<DiscoveryConfigView>('/api/prospects/config');
export const saveDiscoveryKeysApi = (keys: Partial<Record<DiscoveryProvider, string>>) =>
  apiFetch<DiscoveryConfigView>('/api/prospects/config', { method: 'PUT', ...json(keys) });
export const saveDefaultRolesApi = (defaultRoles: string[]) =>
  apiFetch<DiscoveryConfigView>('/api/prospects/config', { method: 'PUT', ...json({ defaultRoles }) });
export const removeDiscoveryKeyApi = (provider: DiscoveryProvider) =>
  apiFetch<DiscoveryConfigView>(`/api/prospects/config/${provider}`, { method: 'DELETE' });

export const startProspectSearchApi = (body: { domain: string; companyName?: string; roles?: string[]; force?: boolean; naukriJobId?: string }) =>
  apiFetch<{ search: ProspectSearch; reused?: boolean }>('/api/prospects/search', { method: 'POST', ...json(body) });

// ── Discover: "Worth searching" ──────────────────────────────────────────────
export interface WorthReason {
  points: number;
  text: string;
  /** 'app' for the app's own signals, else the outside source (news, hn, careers, github, fit). */
  kind: string;
  url?: string | null;
}
export interface SuggestedCompany {
  key: string;
  company: string;
  domain: string | null;
  needsDomain: boolean;
  /** The app's own signals only. */
  base: number;
  /** base + outside signals. */
  score: number;
  reasons: WorthReason[];
  /** Outside checks that failed or were skipped. They add 0. */
  notes: string[];
  roles: string[];
  /** Credits a search with these roles costs. */
  cost: number;
  naukriJobId: string | null;
  jobTitle: string | null;
  linkedin: number;
  naukri: number;
  lastSeenAt: string | null;
}
export interface SuggestedPage {
  suggestions: SuggestedCompany[];
  done: { key: string; company: string; domain: string | null; score: number; searchedAt: string | null }[];
  /** Search credits left this month; null when no search key is set. */
  creditsLeft: number | null;
  /** Suggestions left out because the credits wouldn't cover them. */
  cutForCredits: number;
  minScore: number;
}
export const suggestedCompaniesApi = () => apiFetch<SuggestedPage>('/api/prospects/suggested');
export const dismissSuggestionApi = (key: string, days = 60) =>
  apiFetch<{ ok: boolean }>('/api/prospects/suggested/dismiss', { method: 'POST', ...json({ key, days }) });
export const undoDismissSuggestionApi = (key: string) =>
  apiFetch<{ ok: boolean }>(`/api/prospects/suggested/dismiss/${encodeURIComponent(key)}`, { method: 'DELETE' });
export const refreshSuggestionsApi = () => apiFetch<{ ok: boolean }>('/api/prospects/suggested/refresh', { method: 'POST' });
export type EnrichSource = 'news' | 'hn' | 'careers' | 'github' | 'fit';
export const saveEnrichOffApi = (enrichOff: EnrichSource[]) =>
  apiFetch<DiscoveryConfigView>('/api/prospects/config', { method: 'PUT', ...json({ enrichOff }) });

// ── Company pages ────────────────────────────────────────────────────────────
export interface CompanyListRow {
  key: string; company: string; domain: string | null; score: number | null; excluded: string | null;
  base: number | null; reasons: WorthReason[]; notes: string[];
  leads: number; naukri: number; contacts: number; sent: number; replied: number; bounced: number; lastAt: string | null;
}
export interface CompanyPerson {
  id: string; name: string; email: string; role: string; status: ContactStatus;
  replyCategory: ReplyCategory | null; repliedAt: string | null; lastSentAt: string | null;
  jobTitle: string | null; linkedin: string | null;
  /** Shows up in the Mailbox (wrote back, or in a to-do bucket). */
  hasConversation: boolean;
}
export interface CompanyTally { contacts: number; sent: number; replied: number; bounced: number }
export interface CompanyDetail {
  key: string | null;
  company: string;
  domain: string | null;
  worth: { score: number; base: number; reasons: WorthReason[]; notes: string[]; excluded: string | null; roles: string[] | null; naukriJobId: string | null; jobTitle: string | null } | null;
  totals: CompanyTally;
  contacts: Partial<Record<'outreach' | 'lead' | 'discover' | 'naukri', CompanyTally & { people: CompanyPerson[] }>>;
  leads: { id: string; authorName: string; authorUrl: string; email: string | null; postUrl: string; fitScore: number; status: string; createdAt: string }[];
  naukriJobs: { id: string; title: string; location: string; url: string; approval: string; applyStatus: string; appliedAt: string | null; postedAt: string | null }[];
  interviews: { id: string; name: string; role: string; status: string; interviewAt: string | null }[];
  prospects: { total: number; byStatus: Record<string, number> };
  searches: { id: string; at: string; status: string; roles: string[]; people: number; jobTitle: string | null }[];
  format: {
    pattern: string | null; confidence: string | null; source: string | null; verified: boolean;
    replies: number; delivered: number; hardBounces: number; real: number; domainBounces: number; runnerUp: string | null;
  } | null;
  timeline: { at: string; what: string; kind: string }[];
}
export const companiesApi = (p: { q?: string; sort?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
  return apiFetch<{ companies: CompanyListRow[]; total: number }>(`/api/companies${qs ? `?${qs}` : ''}`);
};
export const companyApi = (key: string) => apiFetch<CompanyDetail>(`/api/companies/${encodeURIComponent(key)}`);

// ── Naukri → Find people ─────────────────────────────────────────────────────
export interface NaukriJobOutreach {
  searched: boolean; domain: string | null; searchId: string | null; searchStatus: string | null;
  people: number; contacts: number; replied: number;
}
export const naukriJobsOutreachApi = (ids: string[]) =>
  apiFetch<{ jobs: Record<string, NaukriJobOutreach> }>(`${NB()}/jobs/outreach?ids=${ids.join(',')}`);
export const prospectSearchApi = (id: string) => apiFetch<{ search: ProspectSearch }>(`/api/prospects/search/${id}`);
export const cancelSearchApi = (id: string) =>
  apiFetch<{ ok: boolean; cancelled: boolean; search: ProspectSearch }>(`/api/prospects/search/${id}/cancel`, { method: 'POST' });
export interface DiscoverLabelRow {
  label: 'high' | 'medium' | 'low' | 'generic' | 'manual';
  found: number; moved: number; emailed: number; replied: number; bounced: number; hardBounced: number; waiting: number;
}
export interface DiscoverCompanyRow {
  domain: string; company: string; people: number; high: number; medium: number; low: number;
  moved: number; emailed: number; replied: number; bounced: number;
}
export interface DiscoverAnalytics {
  days: number;
  totals: {
    found: number; withEmail: number; moved: number; emailed: number; replied: number; bounced: number;
    hardBounced: number; waiting: number; searches: number; searchesLastDays: number; companies: number;
  };
  byLabel: DiscoverLabelRow[];
  status: { open: number; moved: number; discarded: number };
  via: { search: number; github: number; website: number; other?: number };
  runs: { done: number; failed: number; cancelled: number; running: number; queued?: number };
  searchesPerDay: { day: string; n: number }[];
  topRoles: { role: string; n: number }[];
  companies: DiscoverCompanyRow[];
  allowance: { provider: 'tavily' | 'serpapi' | 'hunter'; hasKey: boolean; used: number; cap: number }[];
  month: string;
}
export const discoverAnalyticsApi = (days = 30) => apiFetch<DiscoverAnalytics>(`/api/prospects/analytics?days=${days}`);

/** Analytics → Naukri (lib/naukriAnalytics.js). State is all-time; flows cover `days`. */
export interface NaukriAnalytics {
  days: number;
  timezone: string;
  totals: {
    found: number; scored: number; pending: number; approved: number; approvedAuto: number; rejected: number; tidied: number;
    waiting: number; applied: number; appliedToday: number; responded: number; shortlisted: number; tracked: number;
    interviewing: number; offer: number; employerRejected: number; skipped: number; failed: number; dismissed: number;
  };
  limits: { maxPerDay: number; autoApproveEnabled: boolean; autoApproveMinScore: number; tidyEnabled: boolean };
  scores: Array<{ from: number; to: number; n: number; applied: number }>;
  unscored: number;
  stages: Array<{ stage: 'applied' | 'viewed' | 'shortlisted' | 'contacted' | 'not-shortlisted' | 'unknown'; n: number }>;
  responseMedianHours: number | null;
  perDay: Array<{ day: string; applied: number; skipped: number; failed: number }>;
  reasons: Array<{ key: string; label: string; skipped: number; failed: number }>;
  origins: { search: number; recommended: number; searchApplied: number; recommendedApplied: number };
  /** Your saved searches — not sent to admins. */
  queries?: Array<{ query: string; found: number; applied: number; responded: number }>;
  runs: Array<{ kind: string; total: number; done: number; failed: number; blocked: number; cancelled: number; scheduled: number }>;
  blocked: { runs: number; lastAt: string | null };
  autoApproved: number;
  ai: { asked: number; answered: number; drafts: Record<'ready' | 'unknown' | 'error' | 'ignored', number>; answers: { you: number; auto: number } };
  tidy: Record<'stale' | 'low-fit' | 'company-site' | 'other', number>;
  /** One row per job platform with jobs or runs (all-platform scope compares them). */
  byPlatform?: Array<{
    platform: PlatformId; label: string; found: number; approved: number; applied: number; appliedToday: number;
    responded: number; shortlisted: number; interviewing: number; runs: number; failedRuns: number; blockedRuns: number;
  }>;
}
export const naukriAnalyticsApi = (days = 30, platform: PlatformScope = 'naukri') =>
  apiFetch<NaukriAnalytics>(`${platform === 'naukri' ? '/api/naukri' : `/api/p/${platform}`}/analytics?days=${days}`);

export interface QueueAnalytics {
  days: number;
  buckets: Record<'needs-you' | 'follow-up' | 'waiting' | 'snoozed' | 'done', number>;
  reasons: Array<{ bucket: 'needs-you' | 'follow-up'; reason: string; label: string; n: number }>;
  resolved: { total: number; by: Array<{ key: string; label: string; n: number }> };
}

/** Analytics → Outreach's Campaigns card (lib/campaignAnalytics.js). */
export interface CampaignAnalytics {
  days: number;
  campaigns: Array<{
    id: string; name: string; status: string; pausedByAdmin: boolean;
    origin: string | null; originLabel: string | null; actionKind: string | null;
    total: number; released: number; skipped: number; pending: number; replied: number; replyRate: number;
    createdAt: string; completedAt: string | null;
  }>;
  totals: { campaigns: number; running: number; released: number; skipped: number; replied: number };
  /** What the Action Center started in the window, per action. */
  actionCenter: Array<{ kind: ActionKind | 'other'; campaigns: number; batches: number; contacts: number; replied: number }>;
  skipReasons: Array<{ key: string; label: string; n: number }>;
  quota: { pauses: number; lastPausedAt: string | null; pausedNow: { gmailLimit: number; admin: number; you: number } };
}
export const campaignAnalyticsApi = (days = 30) => apiFetch<CampaignAnalytics>(`/api/campaigns/analytics?days=${days}`);

/** Analytics → Leads: automatic source runs (GET /api/sources/analytics). */
export interface SourceAnalytics {
  days: number;
  runs: Array<{
    source: 'web' | 'hn'; trigger: 'cron' | 'manual'; runs: number; failed: number;
    read: number; withEmail: number; matched: number; created: number; duplicates: number; rejected: number;
    credits: number; lastAt: string | null;
  }>;
}
export const sourceAnalyticsApi = (days = 30) => apiFetch<SourceAnalytics>(`/api/sources/analytics?days=${days}`);

/** Settings → AI usage: your own AI calls as counts (GET /api/settings/ai-usage). */
export interface AiUsage {
  days: number;
  totals: { calls: number; ok: number; tokens: number; yourKey: number; adminKey: number };
  features: Array<{ key: string; label: string; calls: number; ok: number; tokens: number }>;
  outcomes: Array<{ key: string; label: string; n: number }>;
  providers: Array<{ provider: string; calls: number; ok: number }>;
  lastFailure: { at: string; provider: string; outcome: string; label: string } | null;
}
export const aiUsageApi = (days = 30) => apiFetch<AiUsage>(`/api/settings/ai-usage?days=${days}`);
export interface HiringCompany {
  key: string;
  company: string;
  /** Known for LinkedIn posts (from the email); null for a Naukri-only company. */
  domain: string | null;
  linkedin: number;
  naukri: number;
  roles: string[];
  lastSeenAt: string | null;
  signals: number;
  sources: ('linkedin' | 'naukri')[];
  searchedAt: string | null;
  people: number;
}
export interface HiringPage {
  companies: HiringCompany[];
  total: number; page: number; pages: number;
  counts: { all: number; linkedin: number; naukri: number; searched: number };
}
export const hiringCompaniesApi = (p: { days: number; q?: string; source?: string; hideSearched?: boolean; page?: number }) => {
  const qs = new URLSearchParams({
    days: String(p.days), page: String(p.page || 1),
    ...(p.q ? { q: p.q } : {}), ...(p.source ? { source: p.source } : {}), ...(p.hideSearched ? { hideSearched: '1' } : {}),
  });
  return apiFetch<HiringPage>(`/api/prospects/hiring?${qs}`);
};
export const prospectHistoryApi = () => apiFetch<{ searches: ProspectSearch[] }>('/api/prospects/searches');
export const removeSearchApi = (id: string) => apiFetch<{ ok: boolean }>(`/api/prospects/searches/${id}`, { method: 'DELETE' });
export const clearHistoryApi = () => apiFetch<{ ok: boolean; cleared: number }>('/api/prospects/searches', { method: 'DELETE' });
export const prospectCompaniesApi = () => apiFetch<{ companies: ProspectCompany[] }>('/api/prospects/companies');
export interface CompanyCandidate {
  domain: string;
  name: string;
  source: 'contacts' | 'directory' | 'guess' | 'typed';
  contacts: number;
  /** Safe to pick without asking. */
  exact: boolean;
}
export const lookupCompanyApi = (q: string) =>
  apiFetch<{ candidates: CompanyCandidate[] }>(`/api/prospects/lookup?q=${encodeURIComponent(q)}`);
export const suggestDomainsApi = (q: string) =>
  apiFetch<{ domains: { domain: string; contacts: number }[] }>(`/api/prospects/domains/suggest?q=${encodeURIComponent(q)}`);

export const loadProspectsApi = (params: { domain?: string; status?: string; confidence?: string; q?: string; limit?: string }) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return apiFetch<{ prospects: Prospect[]; total: number; page: number; pages: number }>(`/api/prospects?${qs}`);
};
export const updateProspectApi = (id: string, patch: { name?: string; title?: string; email?: string }) =>
  apiFetch<{ prospect: Prospect }>(`/api/prospects/${id}`, { method: 'PATCH', ...json(patch) });
export const moveProspectsApi = (ids: string[], template: string) =>
  apiFetch<MoveProspectsResult>('/api/prospects/move', { method: 'POST', ...json({ ids, template }) });
export const discardProspectsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; discarded: number }>('/api/prospects/discard', { method: 'POST', ...json({ ids }) });
export const restoreProspectsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; restored: number }>('/api/prospects/restore', { method: 'POST', ...json({ ids }) });
export const addGenericProspectApi = (domain: string, email: string) =>
  apiFetch<{ prospect: Prospect; existed?: boolean }>('/api/prospects/add-generic', { method: 'POST', ...json({ domain, email }) });

export const companyFormatApi = (domain: string) => apiFetch<CompanyFormat>(`/api/prospects/patterns/${encodeURIComponent(domain)}`);
export const setGithubOrgApi = (domain: string, githubOrg: string) =>
  apiFetch<{ ok: boolean; githubOrg: string | null }>(`/api/prospects/patterns/${encodeURIComponent(domain)}`, { method: 'PATCH', ...json({ githubOrg }) });
export type SetFormatBody = { pattern: string | null } | { exampleName: string; exampleEmail: string };
export const setCompanyFormatApi = (domain: string, body: SetFormatBody) =>
  apiFetch<{ ok: boolean; pattern: string | null; from: 'list' | 'example' | null; people: number; withEmail: number }>(
    `/api/prospects/patterns/${encodeURIComponent(domain)}`, { method: 'PATCH', ...json(body) });
export const prospectAddressesApi = (id: string) =>
  apiFetch<{ addresses: Record<string, string | null>; knownEmail: string | null }>(`/api/prospects/${encodeURIComponent(id)}/addresses`);
export const startFormatTestApi = (body: { prospectId: string; template: string; pattern?: string; email?: string; attachResume?: boolean }) =>
  apiFetch<{ ok: boolean; error: string | null; tests: FormatTest[]; lastMailboxCheckAt: string | null }>('/api/prospects/format-tests', { method: 'POST', ...json(body) });
export const confirmFormatTestApi = (id: string) =>
  apiFetch<{ ok: boolean; pattern: string; confidence: string; people: number; withEmail: number }>(
    `/api/prospects/format-tests/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
export const recheckCompanyApi = (domain: string) =>
  apiFetch<{ ok: boolean; people: number; withEmail: number; pattern: string; confidence: string }>(
    `/api/prospects/patterns/${encodeURIComponent(domain)}/recheck`, { method: 'POST' });

// ── Admin: Issues ────────────────────────────────────────────────────────────
export type IssueSource = 'server' | 'validation' | 'job' | 'client';
export interface IssueRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  source: IssueSource;
  area: string;
  kind: string;
  message: string;
  detail: string;
  meta: Record<string, unknown>;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
}
export interface IssuesView {
  issues: IssueRow[];
  total: number;
  open: Partial<Record<IssueSource, { issues: number; occurrences: number }>>;
  users: Array<{ id: string; email: string }>;
}
export const adminIssuesApi = (params: Record<string, string>) =>
  apiFetch<IssuesView>(`/api/admin/issues?${new URLSearchParams(params)}`);
export const adminSetIssueStatusApi = (ids: string[], status: 'open' | 'resolved') =>
  apiFetch<{ ok: true; updated: number }>('/api/admin/issues/status', { method: 'POST', body: JSON.stringify({ ids, status }) });

// ── Admin: Sending ───────────────────────────────────────────────────────────
export interface SendingBatch {
  id: string; userId: string | null; userEmail: string; senderEmail: string;
  campaignId: string | null; campaignName: string | null;
  status: 'pending' | 'processing' | 'paused' | 'done' | 'cancelled';
  sendMode: 'sequential' | 'bulk' | 'drip'; ratePerHour: number | null;
  total: number; sent: number; failed: number; skipped: number; pending: number;
  createdAt: string; firstAt: string | null; lastAt: string | null; updatedAt: string;
  etaAt: string | null; idleMs: number; stalled: boolean;
  topError: string | null; topErrorCount: number;
}
export interface SendingUpcoming {
  campaignId: string; name: string; userId: string; userEmail: string;
  nextAt: string; dueNow: boolean; overdueMs: number;
  batch: number; pending: number; perDay: number; ratePerHour: number; batchHours: number;
  daysLeft: number; lastReleaseAt: string | null; lastError: string | null;
}
export interface SendingAccount {
  userId: string; userEmail: string; sentToday: number; failedToday: number; inFlight: number;
  cap: number; usedPct: number; failRate: number; topError: string | null;
}
export interface SendingCron {
  name: string; label: string; everyMin: number;
  lastAt: string | null; lastStatus: number | null; lastMs: number | null; lastOkAt: string | null;
  lastSummary: Record<string, number | string> | null;
  runs24h: number; expected24h: number; medianGapMin: number | null;
}
/** `userId` is absent on scheduler alerts, which concern every account. */
export interface SendingAlert { level: 'critical' | 'warning' | 'info'; area: string; text: string; ref: string; userId?: string | null }
export interface SendingView {
  now: string; days: number; dailyCap: number;
  totals: {
    liveBatches: number; pausedBatches: number; stalled: number; queued: number;
    sentToday: number; failedToday: number; sendingAccounts: number;
    pastBatches: number; pastSent: number; pastFailed: number; pastSkipped: number; scheduledToday: number;
  };
  alerts: SendingAlert[];
  live: SendingBatch[]; past: SendingBatch[]; upcoming: SendingUpcoming[];
  accounts: SendingAccount[]; crons: SendingCron[];
}
export const adminSendingApi = (days: number) => apiFetch<SendingView>(`/api/admin/sending?days=${days}`);
export const adminSendingTimelineApi = (range: TimelineRange, scope: TimelineScope) =>
  apiFetch<Timeline>(`/api/admin/sending/timeline?range=${range}&scope=${scope}`);

// ── Admin: Gemini logs ───────────────────────────────────────────────────────
export type AiFeature = 'classify' | 'draft' | 'discover' | 'sources' | 'naukri' | 'other';
export type AiOutcome = 'ok' | 'rate-limited' | 'auth' | 'transient' | 'bad-output' | 'aborted';
export interface AiTokens { input?: number | null; output?: number | null; thinking?: number | null; total?: number | null }
export interface AiContext { contactEmail?: string | null; contactName?: string | null; contactId?: string | null; company?: string | null }
export interface AiCallRow {
  id: string; at: string;
  userId: string | null; userEmail: string | null;
  feature: AiFeature; runId: string | null; attempt: number;
  provider: string; model: string | null; method: 'classify' | 'complete';
  outcome: AiOutcome | string; status: number | null; latencyMs: number | null; error: string | null;
  finishReason: string | null; tokens: AiTokens; result: { category?: string; reasoning?: string } | null; context: AiContext;
  promptPreview: string; outputPreview: string;
  /** Whose key paid: the account's own, or the owner's env keys. */
  keySource?: 'user' | 'owner';
  /** 'history': rebuilt from the activity log for a call made before this log existed. */
  source: 'live' | 'history'; note: string | null;
}
export interface AiProviderStats {
  provider: string; calls: number; ok: number; rateLimited: number; failed: number;
  avgLatencyMs: number | null; maxLatencyMs: number | null;
  tokensIn: number; tokensOut: number; tokensThinking: number;
  lastAt: string | null; lastFailure: { at: string; error: string | null; outcome: string } | null;
}
export interface AiCallsView {
  range: string;
  calls: AiCallRow[];
  total: number;
  nextBefore: string | null;
  providers: AiProviderStats[];
  features: Partial<Record<AiFeature, { calls: number; ok: number }>>;
  geminiToday: number;
  geminiModel: string;
  providerOrder: string[];
  configured: string[];
  models: string[];
  users: Array<{ id: string; email: string }>;
}
export interface AiCallDetail extends Omit<AiCallRow, 'promptPreview' | 'outputPreview'> {
  system: string; prompt: string; output: string; params: Record<string, unknown> | null;
  run: Array<{ id: string; attempt: number; provider: string; model: string | null; outcome: string; latencyMs: number | null; error: string | null; at: string }>;
}
export const adminAiCallsApi = (params: Record<string, string>) =>
  apiFetch<AiCallsView>(`/api/admin/ai-calls?${new URLSearchParams(params)}`);
export const adminAiCallApi = (id: string) => apiFetch<AiCallDetail>(`/api/admin/ai-calls/${encodeURIComponent(id)}`);

// ── Shared Library ───────────────────────────────────────────────────────────
// Every account's contact data, pooled — never anyone's progress. Behind
// requireLibraryAccess on the server; the session's canSeeLibrary only decides
// whether to show the link.

export type LibraryTab = 'people' | 'leads' | 'discover' | 'companies';
export interface LibraryAddedBy { name: string; you: boolean }
interface LibraryRowBase { key: string; addedBy: LibraryAddedBy[]; firstAt: string | null; lastAt: string | null }
interface LibraryPersonFlags { email: string; bounced: boolean; inMine: boolean }
export interface LibraryPerson extends LibraryRowBase, LibraryPersonFlags {
  name: string; company: string; role: string; jobTitle: string; linkedin: string;
  /** lead | discover | naukri | outreach */
  sources: string[];
}
export interface LibraryLead extends LibraryRowBase, LibraryPersonFlags {
  name: string; company: string; role: string; location: string;
  authorUrl: string; postUrl: string; postedAt: string | null;
  /** scroll | paste | hn | web-post | gmail */
  sources: string[];
}
export interface LibraryProspect extends LibraryRowBase, LibraryPersonFlags {
  name: string; title: string; company: string; domain: string; linkedin: string;
  emailPattern: string; emailConfidence: '' | 'high' | 'medium' | 'low' | 'generic';
  foundVia: string[];
}
export interface LibraryCompany extends LibraryRowBase {
  domain: string; company: string; people: number; contacts: number; leads: number; prospects: number;
  contributors: number;
  /** Formats people set for this company in Discover, with how many accounts agree. */
  formats: { pattern: string; accounts: number; tested: boolean }[];
  genericEmails: string[];
}
export type LibraryRow = LibraryPerson | LibraryLead | LibraryProspect | LibraryCompany;
export interface LibraryPage<R = LibraryRow> { rows: R[]; total: number; page: number; pages: number; limit: number; ids?: string[] }

export const loadLibraryApi = (tab: LibraryTab, params: Record<string, string>, signal?: AbortSignal) =>
  apiFetch<LibraryPage>(`/api/library/${tab}?${new URLSearchParams(params)}`, { signal });

export interface LibraryImportResult {
  created: number; existing: number; filled: number;
  noEmail: number; bounced: number; blocked: number; lowConfidence: number; notFound: number;
}
export const importLibraryApi = (tab: LibraryTab, keys: string[], template: string) =>
  apiFetch<LibraryImportResult>('/api/library/import', { method: 'POST', body: JSON.stringify({ tab, keys, template }) });

export const librarySharingApi = () => apiFetch<{ sharing: boolean }>('/api/settings/library-sharing');
export const setLibrarySharingApi = (sharing: boolean) =>
  apiFetch<{ sharing: boolean }>('/api/settings/library-sharing', { method: 'PUT', body: JSON.stringify({ sharing }) });

// ── Your own AI keys (routes/settings.js → lib/ai/keys.js) ─────────────────
export type AiProvider = 'gemini' | 'groq' | 'cerebras';
export interface AiKeyStatus { state: 'ok' | 'invalid' | 'quota'; checkedAt: string; error: string | null }
export interface AiAccess {
  enforce: boolean;
  graceUntil: string | null;
  inGrace: boolean;
  ownerFallback: boolean;
  has: Record<AiProvider, boolean>;
  keyCount: number;
  /** Has the required Groq key. */
  ready: boolean;
  status: Partial<Record<AiProvider, AiKeyStatus>>;
  /** Is any AI available to this account right now? */
  aiOn: boolean;
}
export const aiAccessApi = () => apiFetch<AiAccess>('/api/settings/ai-keys');
export const saveAiKeyApi = (provider: AiProvider, key: string) =>
  apiFetch<AiAccess>('/api/settings/ai-keys', { method: 'PUT', body: JSON.stringify({ provider, key }) });
export const removeAiKeyApi = (provider: AiProvider) =>
  apiFetch<AiAccess>(`/api/settings/ai-keys/${provider}`, { method: 'DELETE' });
/** Fired after a key is saved or removed, so the banner re-checks without a reload. */
export const AI_KEYS_CHANGED_EVENT = 'outreach:ai-keys-changed';

// Admin: the rollout switch and the per-user fallback.
export interface AiRollout {
  enforce: boolean;
  graceUntil: string | null;
  enforcedAt: string | null;
  inGrace: boolean;
  counts: { active: number; withBackup: number; groqOnly: number; fallback: number; none: number };
}
export const adminAiRolloutApi = () => apiFetch<AiRollout>('/api/admin/ai-keys/rollout');
export const adminSetAiRolloutApi = (change: { enforce?: boolean; graceUntil?: string | null }) =>
  apiFetch<AiRollout>('/api/admin/ai-keys/rollout', { method: 'PUT', body: JSON.stringify(change) });
export const adminSetAiFallbackApi = (id: string, on: boolean) =>
  apiFetch<{ ok: true; aiOwnerFallback: boolean }>(`/api/admin/users/${id}/ai-fallback`, { method: 'POST', body: JSON.stringify({ on }) });

// ── Action Center (the floating button) ──────────────────────────────────────
export interface ActionCenterSummary {
  followUpDue: number;
  ready: number;
  pending: number;
  failed: number;
  newLeads: number;
  readyProspects: number;
  lastMailboxCheckAt: string | null;
  gmailConnected: boolean;
}
export type ActionCenterIdKind = 'followup' | 'ready' | 'pending' | 'leads' | 'prospects';
export const actionCenterSummaryApi = () => apiFetch<ActionCenterSummary>('/api/action-center/summary');
export const actionCenterIdsApi = (kind: ActionCenterIdKind) =>
  apiFetch<{ ids: string[] }>(`/api/action-center/ids?kind=${kind}`);

