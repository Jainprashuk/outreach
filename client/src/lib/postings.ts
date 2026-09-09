import type {
  BoardSource, BoardSyncStatus, JobBoard, Lead, Posting, SourceKind, TrackStatus,
} from './api';

// ── Why postings are not leads ──────────────────────────────────────────────
// A Lead is a PERSON you found and might email. A Posting is a ROLE a company
// currently lists. One lead maps to zero or many postings; most postings map to
// no lead at all. There is no join key: postings carry no email, and Lever and
// Ashby expose no company name to match against a Lead's email-domain-inferred
// company. Reconciling them would need fuzzy company-name matching, which
// produces wrong merges and destroys the one property tracking must have —
// trustworthiness. Same vocabulary, same UI grammar, no shared rows.
// Please don't "fix" this by merging them.

export const TRACK_STATUS_ORDER: TrackStatus[] = [
  'not-applied', 'saved', 'applied', 'in-review', 'interviewing', 'offer', 'rejected', 'skipped',
];

export const TRACK_STATUS_LABELS: Record<TrackStatus, string> = {
  'not-applied':  'Not applied',
  'saved':        'Saved',
  'applied':      'Applied',
  'in-review':    'In review',
  'interviewing': 'Interviewing',
  'offer':        'Offer',
  'rejected':     'Rejected',
  'skipped':      'Skipped',
};

// Copied from APPLY_BADGE_CLASS in lib/leads.ts rather than shared: badge
// classes are plain strings, and TrackStatus has one extra member.
export const TRACK_BADGE_CLASS: Record<TrackStatus, string> = {
  'not-applied':  'badge-queued',
  'saved':        'badge-seen',
  'applied':      'badge-sent',
  'in-review':    'badge-inreview',
  'interviewing': 'badge-followup',
  'offer':        'badge-replied',
  'rejected':     'badge-rejected',
  'skipped':      'badge-closed',
};

export const SOURCE_LABELS: Record<BoardSource, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  muse: 'The Muse',
  jobicy: 'Jobicy',
};

/**
 * 'board' — one company's ATS page. Complete and authoritative, so a posting
 *           vanishing genuinely means it closed.
 * 'search' — a query across many employers. We read the first few pages of
 *           something that can run to 1400+, so it is a partial slice and never
 *           closes anything. This distinction is enforced server-side.
 */
export const SOURCE_KIND: Record<BoardSource, SourceKind> = {
  greenhouse: 'board',
  lever: 'board',
  ashby: 'board',
  muse: 'search',
  jobicy: 'search',
};

export const isSearchSource = (s: BoardSource) => SOURCE_KIND[s] === 'search';

export const SOURCE_BOARD_URL: Record<BoardSource, (token: string) => string> = {
  greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  // Searches have no per-token page of their own.
  muse: () => 'https://www.themuse.com/search/',
  jobicy: () => 'https://jobicy.com/',
};

export const SOURCE_TOKEN_HINT: Record<BoardSource, string> = {
  greenhouse: 'the slug in boards.greenhouse.io/<token>',
  lever: 'the slug in jobs.lever.co/<token>',
  ashby: 'the slug in jobs.ashbyhq.com/<token>',
  muse: 'a short name for this saved search',
  jobicy: 'a short name for this saved search',
};

export const BOARD_STATUS_LABELS: Record<BoardSyncStatus, string> = {
  never: 'Never synced',
  ok: 'OK',
  empty: 'Nothing listed',
  'not-found': 'Not found',
  error: 'Error',
  skipped: 'Skipped',
};

export const BOARD_STATUS_BADGE: Record<BoardSyncStatus, string> = {
  never: 'badge-new',
  ok: 'badge-approved',
  empty: 'badge-queued',
  'not-found': 'badge-rejected',
  error: 'badge-bounced',
  skipped: 'badge-pending',
};

export const EMPLOYMENT_LABELS: Record<string, string> = {
  'full-time': 'Full-time',
  'part-time': 'Part-time',
  contract: 'Contract',
  intern: 'Intern',
  temporary: 'Temporary',
};

export const WORKPLACE_LABELS: Record<string, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

/** Anything past 'not-applied' means you actually did something with it. */
export const isTracked = (p: Pick<Posting, 'applyStatus'>) =>
  !!p.applyStatus && p.applyStatus !== 'not-applied';

/**
 * New to YOU since the given moment. Derived, never stored — a stored boolean
 * would have to be reset every run and would drift.
 *
 * `boardFirstSync` is what stops day-one noise: adding a board with 619 open
 * roles makes all 619 "first seen" right now, which is true but useless, and it
 * would drown the New tab on the exact run you most want to read. A posting
 * first seen on its board's very first successful sync was imported WITH the
 * board, not newly posted.
 */
export function isNewSince(
  p: Posting,
  since: string | null,
  boardFirstSync?: string | null,
): boolean {
  if (!since) return false;
  const cut = Date.parse(since);
  const first = Date.parse(p.firstSeenAt);
  if (boardFirstSync && Math.abs(first - Date.parse(boardFirstSync)) < 1000) return false;
  if (Number.isFinite(first) && first >= cut) return true;
  // A role that closed and came back is news too.
  return !!p.reopenedAt && Date.parse(p.reopenedAt) >= cut;
}

/** Map board id -> its firstSyncAt, for isNewSince. */
export const boardFirstSyncMap = (boards: JobBoard[]): Record<string, string | null> =>
  Object.fromEntries(boards.map(b => [b.id, b.firstSyncAt]));

export const boardLabel = (b: JobBoard) => b.label || b.token;

/** A short human salary, or '' when the source didn't publish one. */
export function formatSalary(p: Pick<Posting, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>): string {
  const { salaryMin: lo, salaryMax: hi, salaryCurrency: cur, salaryPeriod: per } = p;
  if (!lo && !hi) return '';
  const money = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const range = lo && hi && lo !== hi ? `${money(lo)}–${money(hi)}` : money((hi || lo) as number);
  const unit = per === 'yearly' ? '/yr' : per === 'monthly' ? '/mo' : per === 'hourly' ? '/hr' : '';
  return `${cur ? cur + ' ' : ''}${range}${unit}`;
}

/** A one-line description of a saved search, for the boards table. */
export function describeQuery(b: JobBoard): string {
  const q = b.query || {};
  const bits = [q.category, q.industry, q.level, q.location, q.geo, q.tag]
    .map(x => (x || '').trim()).filter(Boolean);
  return bits.length ? bits.join(' · ') : 'everything (no filters)';
}

/** '2 hours ago' — the sync freshness line. */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(secs)) return 'never';
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** GitHub disables scheduled workflows after 60 days of repo inactivity, and the
 *  sync would then just stop. Surfacing staleness is the only honest way to
 *  notice that. */
export const SYNC_STALE_HOURS = 48;
export const isSyncStale = (iso: string | null) =>
  !!iso && Date.now() - Date.parse(iso) > SYNC_STALE_HOURS * 3600 * 1000;

// ── Bootstrapping boards from your existing leads ───────────────────────────
// classifyLink already tags Greenhouse/Lever/Ashby URLs as 'ats', and those URLs
// contain the board token — so the lead pile you already have can suggest which
// boards to track. Extraction is deliberately conservative: grnh.se shortlinks
// and Greenhouse's /embed/job_app?for=<token> variant are rejected rather than
// guessed at, and every suggestion still goes through previewBoardApi before it
// can be added, so a wrong guess costs a 404 message and not bad data.

const BOARD_URL_PATTERNS: Array<{ source: BoardSource; re: RegExp }> = [
  { source: 'greenhouse', re: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9._-]*)(?:\/|$|\?)/i },
  { source: 'lever',      re: /^https?:\/\/jobs\.lever\.co\/([a-z0-9][a-z0-9._-]*)(?:\/|$|\?)/i },
  { source: 'ashby',      re: /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9._-]*)(?:\/|$|\?)/i },
];

// Path segments that are part of the product, not a company slug.
const NOT_A_TOKEN = new Set(['embed', 'jobs', 'job', 'apply', 'search', 'api', 'www']);

export function boardFromUrl(url: string): { source: BoardSource; token: string } | null {
  for (const { source, re } of BOARD_URL_PATTERNS) {
    const m = re.exec(url.trim());
    if (!m) continue;
    const token = m[1].toLowerCase();
    if (NOT_A_TOKEN.has(token)) return null;
    return { source, token };
  }
  return null;
}

/** Board (source, token) pairs implied by your leads' links, minus ones already tracked. */
export function suggestedBoardsFromLeads(
  leads: Lead[],
  boards: JobBoard[],
): Array<{ source: BoardSource; token: string; n: number }> {
  const tracked = new Set(boards.map(b => `${b.source}:${b.token}`));
  const counts = new Map<string, { source: BoardSource; token: string; n: number }>();

  for (const lead of leads) {
    const urls = [...(lead.links || []), lead.applyUrl, lead.postUrl].filter(Boolean) as string[];
    const seenForLead = new Set<string>();
    for (const url of urls) {
      const hit = boardFromUrl(url);
      if (!hit) continue;
      const key = `${hit.source}:${hit.token}`;
      if (tracked.has(key) || seenForLead.has(key)) continue;
      seenForLead.add(key);
      const prev = counts.get(key);
      if (prev) prev.n++;
      else counts.set(key, { ...hit, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}
