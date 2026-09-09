import type { BoardSource, JobBoard, Posting, TrackStatus } from './api';
import type { TriState } from './leadFilters';
import {
  boardLabel, EMPLOYMENT_LABELS, isNewSince, isTracked,
  SOURCE_LABELS, TRACK_STATUS_LABELS, WORKPLACE_LABELS,
} from './postings';

export type { TriState };

/**
 * The tabs. 'new' leads because it is the headline of the whole feature, and
 * 'tracked' ignores listing status on purpose — a job you applied to that then
 * closed still matters, arguably more than an open one you ignored.
 */
export type PostingTab = 'new' | 'open' | 'tracked' | 'closed' | 'all';

export const TABS: PostingTab[] = ['new', 'open', 'tracked', 'closed', 'all'];

export const TAB_LABELS: Record<PostingTab, string> = {
  new: 'New', open: 'Open', tracked: 'Tracked', closed: 'Closed', all: 'All',
};

export type PostingSortKey =
  | 'posted-desc' | 'posted-asc' | 'first-seen-desc' | 'title' | 'company' | 'board' | 'closed-desc';

export const SORT_LABELS: Record<PostingSortKey, string> = {
  'posted-desc': 'Posted (newest)',
  'posted-asc': 'Posted (oldest)',
  'first-seen-desc': 'Newest to me',
  'title': 'Title A→Z',
  'company': 'Company A→Z',
  'board': 'Board A→Z',
  'closed-desc': 'Recently closed',
};

export interface PostingFilters {
  search: string;
  tab: PostingTab;
  trackStatus: 'any' | TrackStatus | 'tracked';
  sources: BoardSource[];
  boards: string[];              // boardToken values
  remote: TriState;
  postedWithin: 'any' | '1' | '7' | '30';
  firstSeenWithin: 'any' | '1' | '7' | '30';
  hasApplyUrl: TriState;
  departments: string[];
  locations: string[];
  employmentTypes: string[];     // '' is a real value, shown as "Not stated"
  countries: string[];
  workplaceTypes: string[];
  seenMin: string;               // free text so the input can be emptied
  closedWithin: 'any' | '1' | '7' | '30';
  sort: PostingSortKey;
}

export const DEFAULT_FILTERS: PostingFilters = {
  search: '', tab: 'open', trackStatus: 'any', sources: [], boards: [],
  remote: 'any', postedWithin: 'any', firstSeenWithin: 'any', hasApplyUrl: 'any',
  departments: [], locations: [], employmentTypes: [], countries: [],
  workplaceTypes: [], seenMin: '', closedWithin: 'any', sort: 'posted-desc',
};

const tri = (f: TriState, v: boolean) => f === 'any' || (f === 'yes' ? v : !v);

const withinDays = (iso: string | null | undefined, days: 'any' | '1' | '7' | '30') => {
  if (days === 'any') return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t <= Number(days) * 86400 * 1000;
};

/** '' is a legitimate stored value (Greenhouse exposes no workplace type), so it
 *  gets a visible "Not stated" option rather than silently vanishing. */
const NOT_STATED = '__none__';

/** Option lists derived from whatever is actually loaded — nothing hardcoded. */
export function filterOptions(postings: Posting[], boards: JobBoard[]) {
  const tally = (pick: (p: Posting) => string | null) => {
    const m = new Map<string, number>();
    for (const p of postings) {
      const v = pick(p);
      if (v === null) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()]
      .map(([value, n]) => ({ value, n }))
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  };

  const labelled = (rows: Array<{ value: string; n: number }>, labels: Record<string, string>) =>
    rows.map(r => ({
      ...r,
      label: r.value === NOT_STATED ? 'Not stated' : (labels[r.value] || r.value),
    }));

  const boardByToken = new Map(boards.map(b => [b.token, b]));

  return {
    sources: tally(p => p.source).map(r => ({ ...r, label: SOURCE_LABELS[r.value as BoardSource] || r.value })),
    boards: tally(p => p.boardToken).map(r => {
      const b = boardByToken.get(r.value);
      return { ...r, label: b ? boardLabel(b) : r.value };
    }),
    departments: tally(p => p.department || null),
    locations: tally(p => p.location || null),
    employmentTypes: labelled(tally(p => p.employmentType || NOT_STATED), EMPLOYMENT_LABELS),
    countries: tally(p => p.country || null),
    workplaceTypes: labelled(tally(p => p.workplaceType || NOT_STATED), WORKPLACE_LABELS),
  };
}

/** A multi-select where '' was mapped to NOT_STATED for display. */
const matchesMulti = (selected: string[], value: string) =>
  selected.length === 0 || selected.includes(value || NOT_STATED);

export function applyPostingFilters(
  postings: Posting[],
  f: PostingFilters,
  ctx: { previousSyncAt: string | null; boardFirstSync: Record<string, string | null> },
): Posting[] {
  const q = f.search.trim().toLowerCase();
  const isNew = (p: Posting) =>
    isNewSince(p, ctx.previousSyncAt, p.boardId ? ctx.boardFirstSync[p.boardId] : null);

  const out = postings.filter(p => {
    // tab
    if (f.tab === 'open' && p.listingStatus !== 'open') return false;
    if (f.tab === 'closed' && p.listingStatus !== 'closed') return false;
    if (f.tab === 'tracked' && !isTracked(p)) return false;
    if (f.tab === 'new' && !(p.listingStatus === 'open' && isNew(p))) return false;

    if (q) {
      const hay = [p.title, p.company, p.department, p.team, p.location, ...(p.locations || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }

    if (f.trackStatus === 'tracked') { if (!isTracked(p)) return false; }
    else if (f.trackStatus !== 'any' && p.applyStatus !== f.trackStatus) return false;

    if (f.sources.length && !f.sources.includes(p.source)) return false;
    if (f.boards.length && !f.boards.includes(p.boardToken)) return false;
    if (!tri(f.remote, p.remote)) return false;
    if (!tri(f.hasApplyUrl, !!p.applyUrl)) return false;

    if (!withinDays(p.postedAt, f.postedWithin)) return false;
    if (!withinDays(p.firstSeenAt, f.firstSeenWithin)) return false;
    if (f.closedWithin !== 'any' && !withinDays(p.closedAt, f.closedWithin)) return false;

    if (!matchesMulti(f.departments, p.department)) return false;
    if (!matchesMulti(f.locations, p.location)) return false;
    if (!matchesMulti(f.employmentTypes, p.employmentType)) return false;
    if (!matchesMulti(f.countries, p.country)) return false;
    if (!matchesMulti(f.workplaceTypes, p.workplaceType)) return false;

    const seenMin = parseInt(f.seenMin, 10);
    if (Number.isFinite(seenMin) && (p.seenCount || 0) < seenMin) return false;

    return true;
  });

  // '￿' sorts last, so rows missing the key sink rather than jumping to the top.
  const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);
  const sorters: Record<PostingSortKey, (a: Posting, b: Posting) => number> = {
    'posted-desc': (a, b) => time(b.postedAt) - time(a.postedAt),
    'posted-asc': (a, b) => time(a.postedAt) - time(b.postedAt),
    'first-seen-desc': (a, b) => time(b.firstSeenAt) - time(a.firstSeenAt),
    'title': (a, b) => (a.title || '￿').localeCompare(b.title || '￿'),
    'company': (a, b) => (a.company || '￿').localeCompare(b.company || '￿'),
    'board': (a, b) => (a.boardToken || '￿').localeCompare(b.boardToken || '￿'),
    'closed-desc': (a, b) => time(b.closedAt) - time(a.closedAt),
  };
  return [...out].sort(sorters[f.sort]);
}

export interface Chip { key: keyof PostingFilters; label: string }

const TRI_LABEL: Record<string, string> = { yes: 'yes', no: 'no' };

const multiLabel = (name: string, vals: string[]) =>
  vals.length === 1
    ? `${name}: ${vals[0] === NOT_STATED ? 'Not stated' : vals[0]}`
    : `${vals.length} ${name.toLowerCase()}s`;

/** Active filters, for the removable chips row. `sort` and `tab` are not chips. */
export function activeChips(f: PostingFilters): Chip[] {
  const c: Chip[] = [];
  if (f.search.trim()) c.push({ key: 'search', label: `“${f.search.trim()}”` });
  if (f.trackStatus !== 'any') {
    c.push({
      key: 'trackStatus',
      label: f.trackStatus === 'tracked'
        ? 'Tracked'
        : `Status: ${TRACK_STATUS_LABELS[f.trackStatus as TrackStatus]}`,
    });
  }
  if (f.sources.length) c.push({ key: 'sources', label: `Source: ${f.sources.map(s => SOURCE_LABELS[s]).join(', ')}` });
  if (f.boards.length) c.push({ key: 'boards', label: multiLabel('Board', f.boards) });
  if (f.remote !== 'any') c.push({ key: 'remote', label: `Remote: ${TRI_LABEL[f.remote]}` });
  if (f.hasApplyUrl !== 'any') c.push({ key: 'hasApplyUrl', label: f.hasApplyUrl === 'yes' ? 'Has an apply link' : 'No apply link' });
  if (f.postedWithin !== 'any') c.push({ key: 'postedWithin', label: `Posted ≤ ${f.postedWithin}d ago` });
  if (f.firstSeenWithin !== 'any') c.push({ key: 'firstSeenWithin', label: `First seen ≤ ${f.firstSeenWithin}d ago` });
  if (f.closedWithin !== 'any') c.push({ key: 'closedWithin', label: `Closed ≤ ${f.closedWithin}d ago` });
  if (f.departments.length) c.push({ key: 'departments', label: multiLabel('Department', f.departments) });
  if (f.locations.length) c.push({ key: 'locations', label: multiLabel('Location', f.locations) });
  if (f.employmentTypes.length) c.push({ key: 'employmentTypes', label: multiLabel('Type', f.employmentTypes) });
  if (f.countries.length) c.push({ key: 'countries', label: multiLabel('Country', f.countries) });
  if (f.workplaceTypes.length) c.push({ key: 'workplaceTypes', label: multiLabel('Workplace', f.workplaceTypes) });
  if (f.seenMin.trim()) c.push({ key: 'seenMin', label: `Seen ≥ ${f.seenMin} times` });
  return c;
}

export const countActive = (f: PostingFilters) => activeChips(f).length;

/** Filters kept behind "Advanced": high-cardinality or narrow questions. */
export const ADVANCED_KEYS: Array<keyof PostingFilters> = [
  'departments', 'locations', 'employmentTypes', 'countries',
  'workplaceTypes', 'seenMin', 'closedWithin', 'firstSeenWithin',
];

export const countAdvanced = (f: PostingFilters) =>
  activeChips(f).filter(c => ADVANCED_KEYS.includes(c.key)).length;

/** Row counts for the tab strip, each ignoring the tab constraint itself. */
export function tabCounts(
  postings: Posting[],
  ctx: { previousSyncAt: string | null; boardFirstSync: Record<string, string | null> },
): Record<PostingTab, number> {
  return {
    new: postings.filter(p =>
      p.listingStatus === 'open' &&
      isNewSince(p, ctx.previousSyncAt, p.boardId ? ctx.boardFirstSync[p.boardId] : null)).length,
    open: postings.filter(p => p.listingStatus === 'open').length,
    tracked: postings.filter(isTracked).length,
    closed: postings.filter(p => p.listingStatus === 'closed').length,
    all: postings.length,
  };
}

export { NOT_STATED };
