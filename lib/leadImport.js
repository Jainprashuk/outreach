const Lead = require('../models/Lead');

// Extracted from routes/leads.js POST /import so the scrape worker's
// /api/scrapes/ingest shares one implementation of the explode + dedupe rules,
// the same way lib/contactImport.js is shared by the contacts and
// move-to-outreach routes. HTTP-level concerns (parsing the request body,
// status codes) stay in the route.

const BASE_FILTER = { deleted: { $ne: true } };

const normEmail = (e) => String(e || '').trim().toLowerCase();
const normText  = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const normUrl   = (u) => normText(u).toLowerCase().replace(/\/+$/, '');

// Emails are the primary identity. Email-less rows fall back to author_url and
// then author_name, so re-uploading the same dump doesn't pile up copies of the
// same person (the harvester repeats email-less authors with different links).
const dedupeKeyFor = (r) =>
  r.email     ? `e:${r.email}` :
  r.authorUrl ? `a:${normUrl(r.authorUrl)}` :
                `n:${normText(r.authorName).toLowerCase()}`;

// One source lead -> one row per distinct email, or a single row with email: null.
const explodeLead = (l) => {
  const emails = Array.isArray(l.emails)
    ? [...new Set(l.emails.map(normEmail).filter(Boolean))]
    : [];
  const base = {
    authorName: normText(l.author_name) || '(unknown)',
    authorUrl:  l.author_url ? normText(l.author_url) : null,
    company:    l.company ? normText(l.company) : '',
    role:       '',
    fitScore:   Number.isFinite(l.fit_score) ? l.fit_score : 0,
    hiring:     !!l.hiring,
    links:      Array.isArray(l.links) ? l.links.filter(x => typeof x === 'string') : [],
    postUrl:    l.post_url || null,
    source:     typeof l.source === 'string' ? l.source : '',
    // Older dumps have no `query`; those rows simply carry an empty list.
    queries:    typeof l.query === 'string' && l.query.trim() ? [normText(l.query)] : [],
  };
  return emails.length === 0
    ? [{ ...base, email: null }]
    : emails.map(email => ({ ...base, email }));
};

const isUsableSourceLead = (l) =>
  !!l && typeof l === 'object' &&
  (!!normText(l.author_name) || (Array.isArray(l.emails) && l.emails.length > 0));

// Pulls the union of last_run_leads + all_leads out of a harvester file, or
// accepts a bare array of leads. Returns the usable rows plus the count of rows
// that were dropped, so the caller can report them.
function readSourceLeads(body) {
  const raw = Array.isArray(body)
    ? body
    : [
        ...(Array.isArray(body && body.last_run_leads) ? body.last_run_leads : []),
        ...(Array.isArray(body && body.all_leads) ? body.all_leads : []),
      ];
  const source = raw.filter(isUsableSourceLead);
  return { source, ignoredRows: raw.length - source.length };
}

// `source` is already filtered by isUsableSourceLead. `batchUpdatedAt` is the
// harvester file's updated_at, stamped on every inserted row.
async function importLeads(source, { ignoredRows = 0, batchUpdatedAt = null } = {}) {
  // 1. explode by email
  const exploded = source.flatMap(explodeLead)
    .map(r => ({ ...r, dedupeKey: dedupeKeyFor(r), batchUpdatedAt }));

  // 2. dedupe within the batch BEFORE touching the DB. Sort by fitScore desc
  //    first so "first occurrence wins" deterministically keeps the best-fit
  //    copy — last_run_leads is a subset of all_leads, so every row arrives at
  //    least twice, and the same email can appear under two author names.
  //    Array#sort is stable, so ties keep the file's own best-fit-first order.
  const byKey = new Map();
  for (const r of [...exploded].sort((a, b) => b.fitScore - a.fitScore)) {
    const kept = byKey.get(r.dedupeKey);
    if (!kept) { byKey.set(r.dedupeKey, r); continue; }
    // Keep the best-fit copy, but credit every query that surfaced this lead.
    for (const q of r.queries) if (!kept.queries.includes(q)) kept.queries.push(q);
  }
  const unique = [...byKey.values()];

  // 3. dedupe against what's already stored (non-deleted only, matching
  //    contacts). No .collation() needed — dedupeKey is already normalised.
  const stored = await Lead.find(
    { dedupeKey: { $in: unique.map(r => r.dedupeKey) }, ...BASE_FILTER },
    { dedupeKey: 1, queries: 1 }
  ).lean();
  const storedByKey = new Map(stored.map(d => [d.dedupeKey, d]));
  const toInsert = unique.filter(r => !storedByKey.has(r.dedupeKey));

  // 4. Backfill: a lead already in the store still learns any query it didn't
  //    have (older imports predate the field). Only `queries` is touched —
  //    company/role/authorName may have been edited on promote and must not be
  //    clobbered by a re-import.
  const backfill = [];
  for (const r of unique) {
    const existing = storedByKey.get(r.dedupeKey);
    if (!existing || r.queries.length === 0) continue;
    const merged = [...new Set([...(existing.queries || []), ...r.queries])];
    if (merged.length !== (existing.queries || []).length) {
      backfill.push({ updateOne: { filter: { _id: existing._id }, update: { $set: { queries: merged } } } });
    }
  }
  if (backfill.length) await Lead.bulkWrite(backfill, { ordered: false });

  const created = toInsert.length ? await Lead.insertMany(toInsert, { ordered: false }) : [];

  return {
    created,
    skipped: unique.length - toInsert.length,        // already in the lead store
    updated: backfill.length,                        // existing rows that gained queries
    skippedInBatch: exploded.length - unique.length, // duplicate rows inside the file
    ignoredRows,
    totalSourceLeads: source.length,
    explodedRows: exploded.length,
  };
}

module.exports = {
  importLeads,
  readSourceLeads,
  explodeLead,
  isUsableSourceLead,
  dedupeKeyFor,
  normEmail,
  normText,
  normUrl,
};
