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
  status: LeadStatus;
  contactId: string | null;
  promotedAt: string | null;
  batchUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadImportResult {
  created: Lead[];
  skipped: number;          // already in the lead store
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

export const loadLeadsApi = () => apiFetch<Lead[]>('/api/leads');

export const importLeadsApi = (payload: LeadFile | SourceLead[]) =>
  apiFetch<LeadImportResult>('/api/leads/import', { method: 'POST', body: JSON.stringify(payload) });

export const moveLeadsToOutreachApi = (template: string, leads: MoveToOutreachRow[]) =>
  apiFetch<MoveToOutreachResult>('/api/leads/move-to-outreach', {
    method: 'POST', body: JSON.stringify({ template, leads }),
  });

export const updateLeadApi = (id: string, patch: Partial<Lead>) =>
  apiFetch<Lead>(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteLeadApi = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/leads/${id}`, { method: 'DELETE' });

export const deleteLeadsApi = (ids: string[]) =>
  apiFetch<{ ok: boolean; deleted: number }>('/api/leads/bulk-delete', {
    method: 'POST', body: JSON.stringify({ ids }),
  });
