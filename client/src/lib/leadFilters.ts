import type { Lead, LeadStatus } from './api';
import { deriveCompany, HARD_REJECT, isFreemail } from './leads';
import { identityOf } from './leadAnalytics';

export type TriState = 'any' | 'yes' | 'no';
export type SortKey = 'fit-desc' | 'fit-asc' | 'newest' | 'oldest' | 'name' | 'email';

export interface LeadFilters {
  search: string;
  status: 'all' | LeadStatus;
  hasEmail: TriState;
  emailKind: 'any' | 'corporate' | 'freemail';
  domains: string[];
  sources: string[];
  queries: string[];
  runs: string[];              // batchUpdatedAt ISO strings
  fitMin: string;              // free text so the input can be emptied
  fitMax: string;
  hideRejects: boolean;
  hiring: TriState;
  company: 'any' | 'known' | 'unknown';
  role: 'any' | 'set' | 'unset';
  hasProfile: TriState;
  hasPost: TriState;
  hasLinks: TriState;
  contact: 'any' | 'created' | 'existing';
  addresses: 'any' | 'single' | 'multi';
  importedWithin: 'any' | '1' | '7' | '30';
  sort: SortKey;
}

export const DEFAULT_FILTERS: LeadFilters = {
  search: '', status: 'all', hasEmail: 'any', emailKind: 'any',
  domains: [], sources: [], queries: [], runs: [],
  fitMin: '', fitMax: '', hideRejects: false,
  hiring: 'any', company: 'any', role: 'any',
  hasProfile: 'any', hasPost: 'any', hasLinks: 'any',
  contact: 'any', addresses: 'any', importedWithin: 'any',
  sort: 'fit-desc',
};

const tri = (f: TriState, v: boolean) => f === 'any' || (f === 'yes' ? v : !v);

/** Options for the multi-selects, derived from whatever is actually stored. */
export function filterOptions(leads: Lead[]) {
  const count = <T extends string>(pick: (l: Lead) => T | null) => {
    const m = new Map<T, number>();
    leads.forEach(l => { const k = pick(l); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
  };
  return {
    domains: count(l => ((l.email || '').split('@')[1] || null)),
    sources: count(l => l.source || null),
    queries: (() => {
      // A lead can be credited to several queries, so it counts once per query.
      const m = new Map<string, number>();
      leads.forEach(l => (l.queries || []).forEach(q => m.set(q, (m.get(q) || 0) + 1)));
      return [...m.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
    })(),
    runs: count(l => l.batchUpdatedAt),
  };
}

export function applyLeadFilters(leads: Lead[], f: LeadFilters): Lead[] {
  // Multi-address is a property of the person, not the row, so it needs the
  // whole set before any per-row test.
  const groupSize = new Map<string, number>();
  leads.forEach(l => groupSize.set(identityOf(l), (groupSize.get(identityOf(l)) || 0) + 1));

  const min = f.fitMin.trim() === '' ? null : Number(f.fitMin);
  const max = f.fitMax.trim() === '' ? null : Number(f.fitMax);
  const withinMs = f.importedWithin === 'any' ? null : Number(f.importedWithin) * 86_400_000;
  const now = Date.now();
  const q = f.search.trim().toLowerCase();

  const out = leads.filter(l => {
    if (f.status !== 'all' && l.status !== f.status) return false;

    if (!tri(f.hasEmail, !!l.email)) return false;
    if (f.emailKind !== 'any') {
      if (!l.email) return false;
      if ((f.emailKind === 'freemail') !== isFreemail(l.email)) return false;
    }
    if (f.domains.length && !f.domains.includes((l.email || '').split('@')[1] || '')) return false;

    if (f.sources.length && !f.sources.includes(l.source)) return false;
    // Matches if ANY of the lead's queries is selected.
    if (f.queries.length && !(l.queries || []).some(q => f.queries.includes(q))) return false;
    if (f.runs.length && !f.runs.includes(l.batchUpdatedAt || '')) return false;

    if (f.hideRejects && l.fitScore === HARD_REJECT) return false;
    if (min !== null && Number.isFinite(min) && l.fitScore < min) return false;
    if (max !== null && Number.isFinite(max) && l.fitScore > max) return false;

    if (!tri(f.hiring, l.hiring)) return false;
    if (!tri(f.hasProfile, !!l.authorUrl)) return false;
    if (!tri(f.hasPost, !!l.postUrl)) return false;
    if (!tri(f.hasLinks, l.links.length > 0)) return false;

    if (f.company !== 'any' && (f.company === 'known') !== !!deriveCompany(l)) return false;
    if (f.role !== 'any' && (f.role === 'set') !== !!l.role) return false;

    // "created" vs "existing" only distinguishes leads that were actually moved.
    if (f.contact !== 'any') {
      if (l.status !== 'added-to-outreach') return false;
      if ((f.contact === 'created') !== !!l.contactId) return false;
    }

    if (f.addresses !== 'any') {
      const n = groupSize.get(identityOf(l)) || 1;
      if ((f.addresses === 'multi') !== (n > 1)) return false;
    }

    if (withinMs !== null && now - new Date(l.createdAt).getTime() > withinMs) return false;

    if (q) {
      const hay = [l.authorName, l.email || '', deriveCompany(l), l.role, l.source,
        l.authorUrl || '', l.postUrl || '', ...(l.queries || []), ...l.links].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sorters: Record<SortKey, (a: Lead, b: Lead) => number> = {
    'fit-desc': (a, b) => b.fitScore - a.fitScore,
    'fit-asc':  (a, b) => a.fitScore - b.fitScore,
    'newest':   (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    'oldest':   (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
    'name':     (a, b) => a.authorName.localeCompare(b.authorName),
    'email':    (a, b) => (a.email || '￿').localeCompare(b.email || '￿'),
  };
  return [...out].sort(sorters[f.sort]);
}

export interface Chip { key: keyof LeadFilters; label: string }

const TRI_LABEL: Record<string, string> = { yes: 'yes', no: 'no' };

/** Active filters, for the removable chips row. `sort` is not a filter. */
export function activeChips(f: LeadFilters): Chip[] {
  const c: Chip[] = [];
  if (f.search.trim()) c.push({ key: 'search', label: `“${f.search.trim()}”` });
  if (f.status !== 'all') c.push({ key: 'status', label: f.status === 'new' ? 'New' : 'Added to outreach' });
  if (f.hasEmail !== 'any') c.push({ key: 'hasEmail', label: `Has email: ${TRI_LABEL[f.hasEmail]}` });
  if (f.emailKind !== 'any') c.push({ key: 'emailKind', label: f.emailKind === 'freemail' ? 'Personal email' : 'Work email' });
  if (f.domains.length) c.push({ key: 'domains', label: `Domain: ${f.domains.length === 1 ? f.domains[0] : `${f.domains.length} selected`}` });
  if (f.sources.length) c.push({ key: 'sources', label: `Source: ${f.sources.join(', ')}` });
  if (f.queries.length) c.push({ key: 'queries', label: f.queries.length === 1 ? `Query: ${f.queries[0]}` : `${f.queries.length} queries` });
  if (f.runs.length) c.push({ key: 'runs', label: `${f.runs.length} harvest run${f.runs.length > 1 ? 's' : ''}` });
  if (f.hideRejects) c.push({ key: 'hideRejects', label: 'Hard rejects hidden' });
  if (f.fitMin.trim()) c.push({ key: 'fitMin', label: `Fit ≥ ${f.fitMin}` });
  if (f.fitMax.trim()) c.push({ key: 'fitMax', label: `Fit ≤ ${f.fitMax}` });
  if (f.hiring !== 'any') c.push({ key: 'hiring', label: `Hiring: ${TRI_LABEL[f.hiring]}` });
  if (f.company !== 'any') c.push({ key: 'company', label: `Company ${f.company}` });
  if (f.role !== 'any') c.push({ key: 'role', label: `Role ${f.role}` });
  if (f.hasProfile !== 'any') c.push({ key: 'hasProfile', label: `Profile: ${TRI_LABEL[f.hasProfile]}` });
  if (f.hasPost !== 'any') c.push({ key: 'hasPost', label: `Post: ${TRI_LABEL[f.hasPost]}` });
  if (f.hasLinks !== 'any') c.push({ key: 'hasLinks', label: `Links: ${TRI_LABEL[f.hasLinks]}` });
  if (f.contact !== 'any') c.push({ key: 'contact', label: f.contact === 'created' ? 'New contact created' : 'Contact already existed' });
  if (f.addresses !== 'any') c.push({ key: 'addresses', label: f.addresses === 'multi' ? 'Several addresses' : 'Single address' });
  if (f.importedWithin !== 'any') c.push({ key: 'importedWithin', label: `Imported ≤ ${f.importedWithin}d ago` });
  return c;
}

export const countActive = (f: LeadFilters) => activeChips(f).length;
