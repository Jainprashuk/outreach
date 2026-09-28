import { CATEGORY_LABELS, STATUS_LABELS } from './format';
import { isFreemail } from './leads';
import type { TriState } from './leadFilters';

/**
 * The shape GET /api/share/contacts returns. Deliberately narrower than Contact:
 * no reply text, no bounce reasons, and the dates are null unless the viewer is
 * the account's own signed-in owner (`withDates` in the response says which).
 */
export interface ShareContact {
  name: string;
  email: string;
  company: string;
  role: string;
  status: string;
  approvalStatus: string;
  template: string;
  source: 'outreach' | 'lead';
  replyCategory: string | null;
  replied: boolean;
  delivered: boolean;
  followedUp: boolean;
  createdAt: string | null;
  lastSentAt: string | null;
  repliedAt: string | null;
}

/** The tab strip. Each is a quick, common cut; everything finer is in Filters. */
export type ContactPreset =
  | 'all' | 'replied' | 'delivered' | 'no-reply' | 'bounced' | 'no-openings' | 'from-linkedin';

export const PRESETS: Array<{ key: ContactPreset; label: string; fn: (c: ShareContact) => boolean }> = [
  { key: 'all', label: 'All contacts', fn: () => true },
  { key: 'replied', label: 'Ever replied', fn: c => c.replied },
  { key: 'delivered', label: 'Delivered', fn: c => c.delivered },
  { key: 'no-reply', label: 'Emailed, no reply', fn: c => c.delivered && !c.replied },
  { key: 'bounced', label: 'Bounced / failed', fn: c => c.status === 'bounced' || c.status === 'failed' },
  { key: 'no-openings', label: 'No Openings', fn: c => c.status === 'no-openings' },
  { key: 'from-linkedin', label: 'From LinkedIn leads', fn: c => c.source === 'lead' },
];

export type ContactSortKey = 'newest' | 'oldest' | 'name' | 'company' | 'email' | 'last-sent';

export interface ContactFilters {
  search: string;
  statuses: string[];
  categories: string[];          // reply categories; 'none' means not classified
  templates: string[];
  domains: string[];
  approval: 'any' | 'pending' | 'approved' | 'rejected';
  source: 'any' | 'outreach' | 'lead';
  emailKind: 'any' | 'corporate' | 'freemail';
  company: 'any' | 'known' | 'unknown';
  role: 'any' | 'set' | 'unset';
  replied: TriState;
  delivered: TriState;
  followedUp: TriState;
  createdFrom: string; createdTo: string;
  sentFrom: string; sentTo: string;
  repliedFrom: string; repliedTo: string;
  sort: ContactSortKey;
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  search: '', statuses: [], categories: [], templates: [], domains: [],
  approval: 'any', source: 'any', emailKind: 'any', company: 'any', role: 'any',
  replied: 'any', delivered: 'any', followedUp: 'any',
  createdFrom: '', createdTo: '', sentFrom: '', sentTo: '', repliedFrom: '', repliedTo: '',
  sort: 'newest',
};

const tri = (f: TriState, v: boolean) => f === 'any' || (f === 'yes' ? v : !v);
const domainOf = (email: string) => (email.split('@')[1] || '').toLowerCase();

// Same semantics as the Contacts page: `to` covers the whole of that day.
const inDateRange = (iso: string | null, from: string, to: string) => {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
};

/** Options for the multi-selects, derived from whatever is actually stored. */
export function contactFilterOptions(contacts: ShareContact[]) {
  const count = (pick: (c: ShareContact) => string | null, label?: (v: string) => string) => {
    const m = new Map<string, number>();
    contacts.forEach(c => { const k = pick(c); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()]
      .map(([value, n]) => ({ value, n, label: label ? label(value) : undefined }))
      .sort((a, b) => b.n - a.n);
  };
  return {
    statuses: count(c => c.status, v => STATUS_LABELS[v] || v),
    categories: count(c => c.replied ? (c.replyCategory || 'none') : null,
      v => (v === 'none' ? 'Not classified' : CATEGORY_LABELS[v] || v)),
    templates: count(c => c.template || null),
    domains: count(c => domainOf(c.email) || null),
  };
}

export function applyContactFilters(contacts: ShareContact[], preset: ContactPreset, f: ContactFilters) {
  const presetFn = (PRESETS.find(p => p.key === preset) || PRESETS[0]).fn;
  const q = f.search.trim().toLowerCase();

  const out = contacts.filter(c => {
    if (!presetFn(c)) return false;
    if (f.statuses.length && !f.statuses.includes(c.status)) return false;
    if (f.categories.length) {
      if (!c.replied) return false;
      if (!f.categories.includes(c.replyCategory || 'none')) return false;
    }
    if (f.templates.length && !f.templates.includes(c.template)) return false;
    if (f.domains.length && !f.domains.includes(domainOf(c.email))) return false;
    if (f.approval !== 'any' && c.approvalStatus !== f.approval) return false;
    if (f.source !== 'any' && c.source !== f.source) return false;
    if (f.emailKind !== 'any' && (f.emailKind === 'freemail') !== isFreemail(c.email.toLowerCase())) return false;
    if (f.company !== 'any' && (f.company === 'known') !== !!c.company.trim()) return false;
    if (f.role !== 'any' && (f.role === 'set') !== !!c.role.trim()) return false;
    if (!tri(f.replied, c.replied)) return false;
    if (!tri(f.delivered, c.delivered)) return false;
    if (!tri(f.followedUp, c.followedUp)) return false;
    if (!inDateRange(c.createdAt, f.createdFrom, f.createdTo)) return false;
    if (!inDateRange(c.lastSentAt, f.sentFrom, f.sentTo)) return false;
    if (!inDateRange(c.repliedAt, f.repliedFrom, f.repliedTo)) return false;
    if (q) {
      const hay = [c.name, c.email, c.company, c.role, c.template].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // The server sends newest first, so that order stands in for createdAt when a
  // share viewer is not sent the dates themselves.
  switch (f.sort) {
    case 'oldest': return out.reverse();
    case 'name': return out.sort((a, b) => a.name.localeCompare(b.name));
    case 'company': return out.sort((a, b) => (a.company || '￿').localeCompare(b.company || '￿'));
    case 'email': return out.sort((a, b) => a.email.localeCompare(b.email));
    case 'last-sent': return out.sort((a, b) => +new Date(b.lastSentAt || 0) - +new Date(a.lastSentAt || 0));
    default: return out;
  }
}

export interface ContactChip { keys: Array<keyof ContactFilters>; label: string }

const TRI_LABEL: Record<string, string> = { yes: 'yes', no: 'no' };
const range = (from: string, to: string) => (from && to ? `${from} → ${to}` : from ? `from ${from}` : `until ${to}`);
const listLabel = (name: string, v: string[], label: (x: string) => string = x => x) =>
  `${name}: ${v.length === 1 ? label(v[0]) : `${v.length} selected`}`;

/** Active filters, for the removable chips row. `sort` is not a filter. */
export function contactChips(f: ContactFilters): ContactChip[] {
  const c: ContactChip[] = [];
  if (f.search.trim()) c.push({ keys: ['search'], label: `“${f.search.trim()}”` });
  if (f.statuses.length) c.push({ keys: ['statuses'], label: listLabel('Status', f.statuses, v => STATUS_LABELS[v] || v) });
  if (f.categories.length) c.push({ keys: ['categories'], label: listLabel('Reply', f.categories, v => (v === 'none' ? 'Not classified' : CATEGORY_LABELS[v] || v)) });
  if (f.templates.length) c.push({ keys: ['templates'], label: listLabel('Template', f.templates) });
  if (f.domains.length) c.push({ keys: ['domains'], label: listLabel('Domain', f.domains) });
  if (f.approval !== 'any') c.push({ keys: ['approval'], label: `Approval: ${f.approval}` });
  if (f.source !== 'any') c.push({ keys: ['source'], label: f.source === 'lead' ? 'From LinkedIn leads' : 'Added directly' });
  if (f.emailKind !== 'any') c.push({ keys: ['emailKind'], label: f.emailKind === 'freemail' ? 'Personal email' : 'Work email' });
  if (f.company !== 'any') c.push({ keys: ['company'], label: `Company ${f.company}` });
  if (f.role !== 'any') c.push({ keys: ['role'], label: `Role ${f.role}` });
  if (f.replied !== 'any') c.push({ keys: ['replied'], label: `Replied: ${TRI_LABEL[f.replied]}` });
  if (f.delivered !== 'any') c.push({ keys: ['delivered'], label: `Delivered: ${TRI_LABEL[f.delivered]}` });
  if (f.followedUp !== 'any') c.push({ keys: ['followedUp'], label: `Followed up: ${TRI_LABEL[f.followedUp]}` });
  if (f.createdFrom || f.createdTo) c.push({ keys: ['createdFrom', 'createdTo'], label: `Added ${range(f.createdFrom, f.createdTo)}` });
  if (f.sentFrom || f.sentTo) c.push({ keys: ['sentFrom', 'sentTo'], label: `Sent ${range(f.sentFrom, f.sentTo)}` });
  if (f.repliedFrom || f.repliedTo) c.push({ keys: ['repliedFrom', 'repliedTo'], label: `Replied ${range(f.repliedFrom, f.repliedTo)}` });
  return c;
}
