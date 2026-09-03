import type { LeadFile, LeadStatus, SourceLead } from './api';

export const HARD_REJECT = -999;

export const isReject = (l: { fitScore: number }) => l.fitScore === HARD_REJECT;

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  'new': 'New',
  'added-to-outreach': 'Added to outreach',
};

// Lead status has its own maps: format.ts's STATUS_LABELS/BADGE_CLASS are the
// contact-status maps, and StatusBadge takes a Contact for its history popover.
export const LEAD_BADGE_CLASS: Record<LeadStatus, string> = {
  'new': 'badge-queued',
  'added-to-outreach': 'badge-approved',
};

/** The harvester file, or a bare array pasted straight in. */
export const sourceLeadsFromFile = (file: LeadFile | SourceLead[]): SourceLead[] =>
  Array.isArray(file)
    ? file
    : [...(file.last_run_leads ?? []), ...(file.all_leads ?? [])];

export interface PreviewRow {
  authorName: string;
  authorUrl: string | null;
  email: string | null;
  fitScore: number;
  links: string[];
  postUrl: string | null;
  source: string;
  dedupeKey: string;
}

const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const normText  = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normUrl   = (u: unknown) => normText(u).toLowerCase().replace(/\/+$/, '');

const dedupeKeyFor = (r: { email: string | null; authorUrl: string | null; authorName: string }) =>
  r.email     ? `e:${r.email}` :
  r.authorUrl ? `a:${normUrl(r.authorUrl)}` :
                `n:${normText(r.authorName).toLowerCase()}`;

const isUsable = (l: SourceLead) =>
  !!l && typeof l === 'object' &&
  (!!normText(l.author_name) || (Array.isArray(l.emails) && l.emails.length > 0));

/**
 * Mirror of the explode + in-batch dedupe in routes/leads.js — PREVIEW ONLY.
 * The server is authoritative and additionally skips rows already in the store,
 * so the saved count can be lower than what the preview shows.
 */
export function explodeForPreview(source: SourceLead[]): PreviewRow[] {
  const usable = source.filter(isUsable);

  const exploded: PreviewRow[] = usable.flatMap(l => {
    const emails = Array.isArray(l.emails)
      ? [...new Set(l.emails.map(normEmail).filter(Boolean))]
      : [];
    const base = {
      authorName: normText(l.author_name) || '(unknown)',
      authorUrl: l.author_url ? normText(l.author_url) : null,
      fitScore: Number.isFinite(l.fit_score) ? l.fit_score : 0,
      links: Array.isArray(l.links) ? l.links.filter(x => typeof x === 'string') : [],
      postUrl: l.post_url || null,
      source: typeof l.source === 'string' ? l.source : '',
    };
    const rows = emails.length === 0
      ? [{ ...base, email: null as string | null }]
      : emails.map(email => ({ ...base, email: email as string | null }));
    return rows.map(r => ({ ...r, dedupeKey: dedupeKeyFor(r) }));
  });

  // Best fit wins when the same identity appears twice (sort is stable, so ties
  // keep the file's own order).
  const seen = new Set<string>();
  return [...exploded]
    .sort((a, b) => b.fitScore - a.fitScore)
    .filter(r => {
      if (seen.has(r.dedupeKey)) return false;
      seen.add(r.dedupeKey);
      return true;
    });
}

export interface PreviewSummary {
  sourceCount: number;
  ignoredCount: number;
  explodedCount: number;
  uniqueCount: number;
  withEmail: number;
  withoutEmail: number;
  rejects: number;
}

export function summarisePreview(source: SourceLead[], rows: PreviewRow[]): PreviewSummary {
  const usable = source.filter(isUsable).length;
  const exploded = source.filter(isUsable).reduce((n, l) => {
    const emails = Array.isArray(l.emails)
      ? new Set(l.emails.map(normEmail).filter(Boolean)).size
      : 0;
    return n + Math.max(1, emails);
  }, 0);
  return {
    sourceCount: usable,
    ignoredCount: source.length - usable,
    explodedCount: exploded,
    uniqueCount: rows.length,
    withEmail: rows.filter(r => r.email).length,
    withoutEmail: rows.filter(r => !r.email).length,
    rejects: rows.filter(r => r.fitScore === HARD_REJECT).length,
  };
}
