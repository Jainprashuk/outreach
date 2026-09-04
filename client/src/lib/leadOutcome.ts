import type { Lead, LeadOutcome, LeadOutcomeMap } from './api';
import { BADGE_CLASS, STATUS_LABELS } from './format';

/** Coarse stage, for filtering and for the funnel. Derived, never stored. */
export type OutcomeStage =
  | 'not-in-outreach' | 'awaiting-approval' | 'queued' | 'emailed'
  | 'bounced' | 'replied' | 'failed';

export const STAGE_LABELS: Record<OutcomeStage, string> = {
  'not-in-outreach':   'Not in outreach',
  'awaiting-approval': 'Awaiting approval',
  'queued':            'Queued to send',
  'emailed':           'Emailed, no reply yet',
  'bounced':           'Bounced',
  'replied':           'Replied',
  'failed':            'Send failed',
};

// Most-interesting-first, for the filter dropdown.
export const STAGE_ORDER: OutcomeStage[] = [
  'replied', 'emailed', 'bounced', 'failed', 'queued', 'awaiting-approval', 'not-in-outreach',
];

// Lifecycle order, for reading a distribution top to bottom.
export const STAGE_PIPELINE: OutcomeStage[] = [
  'not-in-outreach', 'awaiting-approval', 'queued', 'emailed', 'replied', 'bounced', 'failed',
];

/** How many leads sit at each stage. */
export function stageCounts(
  leads: Array<Lead>, map: LeadOutcomeMap,
): Record<OutcomeStage, number> {
  const out = Object.fromEntries(STAGE_PIPELINE.map(s => [s, 0])) as Record<OutcomeStage, number>;
  leads.forEach(l => { out[stageOf(outcomeOf(l, map))]++; });
  return out;
}

const REPLIED = new Set(['replied', 'follow-up-replied', 'closed', 'no-openings', 'in-review']);

export function outcomeOf(lead: Lead, map: LeadOutcomeMap): LeadOutcome | null {
  if (!lead.email) return null;
  return map[lead.email.trim().toLowerCase()] || null;
}

export function stageOf(outcome: LeadOutcome | null): OutcomeStage {
  if (!outcome) return 'not-in-outreach';
  // repliedAt is the ground truth — the closed/no-openings/in-review statuses are
  // all things you set *after* someone answered.
  if (outcome.repliedAt || REPLIED.has(outcome.status)) return 'replied';
  if (outcome.status === 'bounced') return 'bounced';
  if (outcome.status === 'failed') return 'failed';
  if (outcome.lastSentAt || outcome.status === 'sent' || outcome.status === 'follow-up-sent') return 'emailed';
  if (outcome.approvalStatus === 'pending') return 'awaiting-approval';
  return 'queued';
}

export const stageStage = (lead: Lead, map: LeadOutcomeMap) => stageOf(outcomeOf(lead, map));

/** Reuse the contact-status maps so a lead's badge matches the Contacts page. */
export const contactStatusLabel = (s: string) => STATUS_LABELS[s] || s;
export const contactBadgeClass = (s: string) => BADGE_CLASS[s] || 'badge-queued';

export const STAGE_BADGE: Record<OutcomeStage, string> = {
  'not-in-outreach':   'badge-queued',
  'awaiting-approval': 'badge-pending',
  'queued':            'badge-approved',
  'emailed':           'badge-sent',
  'bounced':           'badge-bounced',
  'replied':           'badge-replied',
  'failed':            'badge-rejected',
};
