import type { Lead } from './api';
import { deriveCompany, HARD_REJECT } from './leads';

/** Rows are exploded per email, so "people" means rows regrouped by identity. */
export const identityOf = (l: Lead) => l.authorUrl || l.authorName;

export interface LeadMetrics {
  total: number;
  fresh: number;            // status 'new'
  moved: number;            // status 'added-to-outreach'
  withEmail: number;
  withoutEmail: number;
  rejects: number;
  usable: number;           // has an email and isn't a hard reject
  people: number;           // distinct authors behind the rows
  multiAddress: number;     // people holding more than one address
  contactsCreated: number;  // moved AND a new contact was made (contactId set)
  alreadyExisted: number;   // moved but the email was already a contact
  conversion: number;       // % of contactable rows moved to outreach
  withProfile: number;
  withPost: number;
  withLinks: number;
  hiring: number;
  companyKnown: number;     // company stored or inferable
  avgFit: number;
  medianFit: number;
}

export function computeLeadMetrics(leads: Lead[]): LeadMetrics {
  const total = leads.length;
  const withEmail = leads.filter(l => l.email).length;
  const rejects = leads.filter(l => l.fitScore === HARD_REJECT).length;
  const moved = leads.filter(l => l.status === 'added-to-outreach').length;

  const byIdentity = new Map<string, number>();
  leads.forEach(l => byIdentity.set(identityOf(l), (byIdentity.get(identityOf(l)) || 0) + 1));

  // Hard rejects skew the mean hard (-999), so report the median alongside it.
  const scored = leads.filter(l => l.fitScore !== HARD_REJECT).map(l => l.fitScore).sort((a, b) => a - b);
  const avgFit = scored.length ? Math.round((scored.reduce((s, v) => s + v, 0) / scored.length) * 10) / 10 : 0;
  const medianFit = scored.length ? scored[Math.floor(scored.length / 2)] : 0;

  return {
    total,
    fresh: leads.filter(l => l.status === 'new').length,
    moved,
    withEmail,
    withoutEmail: total - withEmail,
    rejects,
    usable: leads.filter(l => l.email && l.fitScore !== HARD_REJECT).length,
    people: byIdentity.size,
    multiAddress: [...byIdentity.values()].filter(n => n > 1).length,
    contactsCreated: leads.filter(l => l.status === 'added-to-outreach' && l.contactId).length,
    alreadyExisted: leads.filter(l => l.status === 'added-to-outreach' && !l.contactId).length,
    conversion: withEmail > 0 ? Math.round((moved / withEmail) * 1000) / 10 : 0,
    withProfile: leads.filter(l => l.authorUrl).length,
    withPost: leads.filter(l => l.postUrl).length,
    withLinks: leads.filter(l => l.links.length > 0).length,
    hiring: leads.filter(l => l.hiring).length,
    companyKnown: leads.filter(l => deriveCompany(l)).length,
    avgFit,
    medianFit,
  };
}

export const FIT_BUCKETS = [
  { label: '15+',          test: (f: number) => f >= 15 },
  { label: '10 – 14',      test: (f: number) => f >= 10 && f < 15 },
  { label: '5 – 9',        test: (f: number) => f >= 5 && f < 10 },
  { label: '0 – 4',        test: (f: number) => f >= 0 && f < 5 },
  { label: 'Negative',     test: (f: number) => f < 0 && f !== HARD_REJECT },
  { label: 'Hard reject',  test: (f: number) => f === HARD_REJECT },
];

export const fitBuckets = (leads: Lead[]) =>
  FIT_BUCKETS.map(b => ({ label: b.label, n: leads.filter(l => b.test(l.fitScore)).length }));

/** Top email domains — a rough read on which orgs dominate the harvest. */
export function topDomains(leads: Lead[], limit = 8) {
  const counts = new Map<string, { n: number; moved: number }>();
  leads.forEach(l => {
    const d = (l.email || '').split('@')[1];
    if (!d) return;
    const cur = counts.get(d) || { n: 0, moved: 0 };
    cur.n++;
    if (l.status === 'added-to-outreach') cur.moved++;
    counts.set(d, cur);
  });
  return [...counts.entries()]
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/** People split across several addresses — an artefact of the per-email explode. */
export function topMultiAddress(leads: Lead[], limit = 6) {
  const groups = new Map<string, { name: string; n: number; moved: number }>();
  leads.forEach(l => {
    const k = identityOf(l);
    const cur = groups.get(k) || { name: l.authorName, n: 0, moved: 0 };
    cur.n++;
    if (l.status === 'added-to-outreach') cur.moved++;
    groups.set(k, cur);
  });
  return [...groups.values()].filter(g => g.n > 1).sort((a, b) => b.n - a.n).slice(0, limit);
}

/** One row per harvest run, keyed on the file's own updated_at. */
export function harvestRuns(leads: Lead[], limit = 6) {
  const runs = new Map<string, { at: number | null; n: number; moved: number }>();
  leads.forEach(l => {
    const k = l.batchUpdatedAt || 'unknown';
    const cur = runs.get(k) || { at: l.batchUpdatedAt ? new Date(l.batchUpdatedAt).getTime() : null, n: 0, moved: 0 };
    cur.n++;
    if (l.status === 'added-to-outreach') cur.moved++;
    runs.set(k, cur);
  });
  return [...runs.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/** Rows imported per day, from createdAt. */
export function importsByDay(leads: Lead[], days = 14) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: Array<{ day: number; n: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    out.push({ day: d.getTime(), n: 0 });
  }
  const first = out[0].day;
  leads.forEach(l => {
    const d = new Date(l.createdAt); d.setHours(0, 0, 0, 0);
    const t = d.getTime();
    if (t < first) return;
    const slot = out.find(o => o.day === t);
    if (slot) slot.n++;
  });
  return out;
}

export const sourceBreakdown = (leads: Lead[]) => {
  const m = new Map<string, number>();
  leads.forEach(l => { const k = l.source || 'unknown'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n);
};

export interface QueryStat {
  query: string;
  n: number;          // leads credited to this query
  withEmail: number;
  usable: number;     // has an email and isn't a hard reject
  moved: number;
  medianFit: number;  // rejects excluded, or -999 when everything was rejected
  hitRate: number;    // % of the query's leads that are actually workable
}

/**
 * Per-search-query performance. A lead credited to several queries counts once
 * for each, which is what you want when asking "is this search worth repeating".
 */
export function queryStats(leads: Lead[]): QueryStat[] {
  const groups = new Map<string, Lead[]>();
  leads.forEach(l => (l.queries || []).forEach(q => {
    if (!groups.has(q)) groups.set(q, []);
    groups.get(q)!.push(l);
  }));

  return [...groups.entries()].map(([query, rows]) => {
    const scored = rows.filter(l => l.fitScore !== HARD_REJECT).map(l => l.fitScore).sort((a, b) => a - b);
    const usable = rows.filter(l => l.email && l.fitScore !== HARD_REJECT).length;
    return {
      query,
      n: rows.length,
      withEmail: rows.filter(l => l.email).length,
      usable,
      moved: rows.filter(l => l.status === 'added-to-outreach').length,
      medianFit: scored.length ? scored[Math.floor(scored.length / 2)] : HARD_REJECT,
      hitRate: rows.length ? Math.round((usable / rows.length) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.usable - a.usable || b.n - a.n);
}

/** Leads carrying no query at all — i.e. imported before the field existed. */
export const unattributed = (leads: Lead[]) => leads.filter(l => (l.queries || []).length === 0).length;
