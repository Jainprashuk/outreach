// Port of the API layer from js/app.js — same endpoints, same semantics.

// Always same-origin: Express serves the SPA at /app in prod, and the Vite dev
// server proxies /api → localhost:3000 in dev. Relative URLs work in both.
export const API_BASE = '';

export type ContactStatus =
  | 'queued' | 'sent' | 'follow-up-sent' | 'failed' | 'bounced'
  | 'replied' | 'follow-up-replied' | 'closed' | 'no-openings' | 'in-review';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface StatusHistoryEntry {
  status: string;
  changedAt: string;
  note?: string;
}

export interface Contact {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
  template: string;
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
  lastSentAt: string | null;
  followUpSentAt: string | null;
  statusHistory?: StatusHistoryEntry[];
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
  createdAt: string;
  items: JobItem[];
}

export async function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Request to ${path} failed`);
  return data as T;
}

// ── Endpoint wrappers (1:1 with window._app) ─────────────────────────────────
export const loadContactsApi = () => apiFetch<Contact[]>('/api/contacts');
export const loadTemplatesApi = () => apiFetch<Template[]>('/api/templates');
export const loadSettingsApi = () => apiFetch<any>('/api/settings');

export const createContactsApi = (rows: Partial<Contact>[]) =>
  apiFetch<{ created: Contact[]; skipped: number }>('/api/contacts', {
    method: 'POST', body: JSON.stringify(rows),
  });

export const updateContactApi = (id: string, patch: Partial<Contact>) =>
  apiFetch<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const bulkUpdateContactsApi = (updates: Array<{ id: string } & Partial<Contact>>) =>
  apiFetch<{ ok: boolean; count: number }>('/api/contacts', { method: 'PATCH', body: JSON.stringify(updates) });

export const deleteContactApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/contacts/${id}`, { method: 'DELETE' });

export const checkMailboxApi = () =>
  apiFetch<any>('/api/check-mailbox', { method: 'POST' });

export const saveSettingsApi = (patch: any) =>
  apiFetch<any>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });

export const createTemplateApi = (data: Partial<Template>) =>
  apiFetch<Template>('/api/templates', { method: 'POST', body: JSON.stringify(data) });

export const updateTemplateApi = (key: string, patch: Partial<Template>) =>
  apiFetch<Template>(`/api/templates/${key}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteTemplateApi = (key: string) =>
  apiFetch<void>(`/api/templates/${key}`, { method: 'DELETE' });

export interface CooldownSkip {
  id: string; name: string; email: string; status: ContactStatus;
  lastSentAt: string | null; remainingMs: number;
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

export const loadLeadsApi = () => apiFetch<Lead[]>('/api/leads');

export const loadLeadOutcomesApi = () =>
  apiFetch<{ outcomes: LeadOutcomeMap; count: number }>('/api/leads/outcomes');

export const importLeadsApi = (payload: LeadFile | SourceLead[]) =>
  apiFetch<LeadImportResult>('/api/leads/import', { method: 'POST', body: JSON.stringify(payload) });

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
  | 'initial-discussion' | 'asked-to-schedule' | 'scheduled'
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
  | 'removed_by_user' | 'queue_failed' | 'render_empty';

export interface CampaignStats {
  total: number; pending: number; released: number; skipped: number; removed: number;
  queued?: number;
}

/** One day the runner actually released. Embedded on the campaign, newest last. */
export interface CampaignRelease {
  releasedOn: string;              // 'YYYY-MM-DD' in IST
  trigger: 'cron' | 'manual';
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
}

export const loadCampaignsApi = () => apiFetch<Campaign[]>('/api/campaigns');

export const loadCampaignApi = (id: string) => apiFetch<CampaignDetail>(`/api/campaigns/${id}`);

export const loadCampaignMetaApi = () => apiFetch<CampaignMeta>('/api/campaigns/meta');

/** Phase 1 of creation: config + mapping metadata, no rows. Returns a draft. */
export const createCampaignApi = (body: {
  name: string; templateKey: string; contactsPerDay: number; ratePerHour: number;
  runHourIst: number; attachResume: boolean;
  columnMap: CampaignColumnMap; sourceColumns: string[]; headerRow: number; fileName: string;
}) => apiFetch<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify(body) });

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

export const restoreCampaignRowsApi = (id: string, ids: string[]) =>
  apiFetch<{ ok: boolean; restored: number }>(`/api/campaigns/${id}/rows/restore`, {
    method: 'POST', body: JSON.stringify({ ids }),
  });

export const deleteCampaignApi = (id: string, purgeRows = false) =>
  apiFetch<{ ok: boolean; purgedRows: number }>(
    `/api/campaigns/${id}${purgeRows ? '?purgeRows=1' : ''}`, { method: 'DELETE' });
