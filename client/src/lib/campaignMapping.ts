// Turning an arbitrary spreadsheet into our four contact fields.
//
// Pure functions only — no React, no network — so the whole mapping pipeline is
// testable on its own, and the wizard can recompute validation synchronously on
// every <select> change.

export type Field = 'name' | 'email' | 'company' | 'role';

export interface FieldSpec { key: Field; label: string; required: boolean }

export const FIELDS: FieldSpec[] = [
  { key: 'name',    label: 'Name',    required: false },
  { key: 'email',   label: 'Email',   required: true  },
  { key: 'company', label: 'Company', required: false },
  { key: 'role',    label: 'Role',    required: false },
];

// Column index per field, or null when unmapped. `name` may hold TWO indices so
// a "First Name" + "Last Name" sheet — the single most common export shape —
// maps without the user having to pre-combine them in Excel.
export interface Mapping {
  name: number[] | null;
  email: number | null;
  company: number | null;
  role: number | null;
}

export const EMPTY_MAPPING: Mapping = { name: null, email: null, company: null, role: null };

// The first entries of each list are exactly lib/csv.ts's aliases; the rest are
// additive. csv.ts itself is untouched.
const FIELD_ALIASES: Record<Field, string[]> = {
  email:   ['email', 'email address', 'e-mail', 'mail', 'work email', 'business email',
            'primary email', 'email id', 'contact email'],
  company: ['company', 'organisation', 'organization', 'company name', 'employer',
            'account', 'org', 'business'],
  role:    ['role', 'designation', 'title', 'job title', 'position', 'jobtitle'],
  name:    ['name', 'full name', 'fullname', 'contact name', 'contact', 'person',
            'full_name', 'display name'],
};

const FIRST_NAME_ALIASES = ['first name', 'firstname', 'given name', 'first'];
const LAST_NAME_ALIASES = ['last name', 'lastname', 'surname', 'family name', 'last'];

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS_SET = new Set(
  [...Object.values(FIELD_ALIASES).flat(), ...FIRST_NAME_ALIASES, ...LAST_NAME_ALIASES].map(norm),
);

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Two or more alphabetic words: what a person's name looks like and a company
// name often also looks like — which is why this only ever sniffs `name`.
const NAME_RE = /^\p{L}[\p{L}'.-]*(\s+\p{L}[\p{L}'.-]*)+$/u;

/** A → Z, AA → AZ, … for sheets with no header row. */
export const colLetter = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : colLetter(Math.floor(i / 26) - 1) + colLetter(i % 26);

// ── Header row detection ────────────────────────────────────────────────────

function headerScore(row: string[], next?: string[]): number {
  const cells = row.map((c) => (c || '').trim());
  const filled = cells.filter(Boolean);
  // A merged title banner ("Q3 Outreach List") occupies one cell on its own row.
  if (filled.length < 2) return -Infinity;
  // A real email address in the row settles it: this is data. Decisive rather
  // than a weighted penalty, because the base score for any well-filled row is
  // high enough that a soft penalty still reads the first data row of a
  // headerless export as a header.
  if (cells.some((c) => EMAIL_RE.test(c.toLowerCase()))) return -Infinity;

  let s = (filled.length / Math.max(1, cells.length)) * 2;
  // Headers are unique; a data row repeats values freely.
  if (new Set(filled.map((c) => c.toLowerCase())).size === filled.length) s += 1;
  // Bare numbers are data, never header text.
  s -= cells.filter((c) => /^-?\d+([.,]\d+)?$/.test(c)).length * 0.6;
  s += cells.filter((c) => ALIAS_SET.has(norm(c))).length * 2.5;
  // Data immediately below is what a header row looks like from the outside.
  if (next && next.some((c) => EMAIL_RE.test((c || '').trim().toLowerCase()))) s += 1;
  return s;
}

/** Index of the most header-like row, or -1 for "this sheet has no header row". */
export function detectHeaderRow(grid: string[][], maxScan = 10): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < Math.min(maxScan, grid.length); i++) {
    const s = headerScore(grid[i], grid[i + 1]);
    if (s > bestScore) { bestScore = s; best = i; }   // ties resolve to the earliest row
  }
  return bestScore <= 0 ? -1 : best;
}

export function splitGrid(grid: string[][], headerRow: number): { headers: string[]; rows: string[][] } {
  if (grid.length === 0) return { headers: [], rows: [] };
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (headerRow < 0) {
    return {
      headers: Array.from({ length: width }, (_, i) => `Column ${colLetter(i)}`),
      rows: grid,
    };
  }
  const header = grid[headerRow] || [];
  return {
    headers: Array.from({ length: width }, (_, i) => (header[i] || '').trim() || `Column ${colLetter(i)}`),
    rows: grid.slice(headerRow + 1),
  };
}

// ── Auto-detection ──────────────────────────────────────────────────────────

const ratio = (rows: string[][], col: number, test: (v: string) => boolean, sample = 200) => {
  let seen = 0;
  let hit = 0;
  for (let i = 0; i < Math.min(sample, rows.length); i++) {
    const v = (rows[i][col] || '').trim();
    if (!v) continue;
    seen++;
    if (test(v)) hit++;
  }
  return seen === 0 ? 0 : hit / seen;
};

/**
 * Guess the mapping. Three passes, first hit wins, and a column already claimed
 * by an earlier field is never reused.
 */
export function autoDetect(headers: string[], rows: string[][]): Mapping {
  const map: Mapping = { ...EMPTY_MAPPING };
  const claimed = new Set<number>();
  const normed = headers.map(norm);

  const claim = (field: Exclude<Field, 'name'>, col: number) => {
    map[field] = col;
    claimed.add(col);
  };

  // Pass 1 — exact normalised alias match.
  // `company` and `role` run BEFORE `name` throughout, so "Company Name" and
  // "Job Title" are claimed by the right field instead of being stolen by the
  // `name` aliases that are substrings of them.
  for (const field of ['email', 'company', 'role'] as const) {
    if (map[field] !== null) continue;
    const i = normed.findIndex((h, idx) => !claimed.has(idx) && FIELD_ALIASES[field].some((a) => norm(a) === h));
    if (i >= 0) claim(field, i);
  }

  // Name: prefer an explicit First + Last pair over a single "Name" column.
  const firstIdx = normed.findIndex((h, i) => !claimed.has(i) && FIRST_NAME_ALIASES.some((a) => norm(a) === h));
  const lastIdx = normed.findIndex((h, i) => !claimed.has(i) && LAST_NAME_ALIASES.some((a) => norm(a) === h));
  if (firstIdx >= 0 && lastIdx >= 0) {
    map.name = [firstIdx, lastIdx];
    claimed.add(firstIdx); claimed.add(lastIdx);
  } else {
    const i = normed.findIndex((h, idx) => !claimed.has(idx) && FIELD_ALIASES.name.some((a) => norm(a) === h));
    if (i >= 0) { map.name = [i]; claimed.add(i); }
    else if (firstIdx >= 0) { map.name = [firstIdx]; claimed.add(firstIdx); }
  }

  // Pass 2 — substring match on the normalised header.
  for (const field of ['email', 'company', 'role'] as const) {
    if (map[field] !== null) continue;
    const i = normed.findIndex((h, idx) => !claimed.has(idx) && FIELD_ALIASES[field].some((a) => h.includes(norm(a))));
    if (i >= 0) claim(field, i);
  }
  if (map.name === null) {
    const i = normed.findIndex((h, idx) => !claimed.has(idx) && FIELD_ALIASES.name.some((a) => h.includes(norm(a))));
    if (i >= 0) { map.name = [i]; claimed.add(i); }
  }

  // Pass 3 — content sniffing, for headerless exports and "Column1/Column2"
  // sheets. Only email and name: guessing company or role wrong is WORSE than
  // leaving them blank, because they land in template variables that go out in
  // an email nobody re-reads before sending.
  if (map.email === null) {
    let best = -1;
    let bestR = 0.3;   // floor: below this it isn't an email column
    headers.forEach((_, i) => {
      if (claimed.has(i)) return;
      const r = ratio(rows, i, (v) => EMAIL_RE.test(v));
      if (r > bestR) { bestR = r; best = i; }
    });
    if (best >= 0) claim('email', best);
  }
  if (map.name === null) {
    let best = -1;
    let bestR = 0.5;
    headers.forEach((_, i) => {
      if (claimed.has(i)) return;
      const r = ratio(rows, i, (v) => !v.includes('@') && !/\d/.test(v) && NAME_RE.test(v));
      if (r > bestR) { bestR = r; best = i; }
    });
    if (best >= 0) { map.name = [best]; claimed.add(best); }
  }

  return map;
}

// ── Projection ──────────────────────────────────────────────────────────────

const cell = (row: string[], i: number | null) => (i === null ? '' : (row[i] || '').trim());

export interface ProjectedRow {
  name: string;
  email: string;
  company: string;
  role: string;
  extras: { k: string; v: string }[];
  row: number;   // 1-based line in the original sheet, for "fix and re-upload"
}

export const MAX_EXTRAS = 20;
export const MAX_EXTRA_LEN = 500;

/**
 * Apply the mapping client-side. The server stores `columnMap` as metadata only
 * — it receives these normalised rows, which keeps the payload to four fields
 * plus the capped extras rather than every column of every row.
 */
export function projectRows(
  headers: string[],
  rows: string[][],
  mapping: Mapping,
  headerRow: number,
  keepUnmapped = true,
): ProjectedRow[] {
  const mapped = new Set<number>(
    [mapping.email, mapping.company, mapping.role, ...(mapping.name || [])]
      .filter((i): i is number => i !== null && i !== undefined),
  );

  return rows.map((r, i) => {
    const email = cell(r, mapping.email).toLowerCase();
    const name = (mapping.name || []).map((idx) => cell(r, idx)).filter(Boolean).join(' ');
    const extras = keepUnmapped
      ? headers
          .map((h, idx) => ({ h, idx }))
          .filter(({ idx }) => !mapped.has(idx))
          .slice(0, MAX_EXTRAS)
          .map(({ h, idx }) => ({ k: h, v: cell(r, idx).slice(0, MAX_EXTRA_LEN) }))
          .filter((e) => e.v)
      : [];
    return {
      // The fallback matches what the server does, so the preview counts and the
      // release agree. Contact.name is required downstream.
      name: name || (email ? email.split('@')[0] : ''),
      email,
      company: cell(r, mapping.company),
      role: cell(r, mapping.role),
      extras,
      row: (headerRow < 0 ? 0 : headerRow + 1) + i + 1,
    };
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface FieldQuality { mapped: boolean; filled: number; blank: number; invalid: number; samples: string[] }

export interface MappingReport {
  blocking: string[];
  warnings: string[];
  stats: {
    total: number; usable: number;
    blankEmail: number; invalidEmail: number; blankName: number;
    dupInFile: number; dupExisting: number;
  };
  perField: Record<Field, FieldQuality>;
}

/**
 * Count over EVERY row, never a sample — these numbers are shown to the user as
 * facts about their file, and "approximately 40 rows will be skipped" is not a
 * useful thing to tell someone about to email two thousand people.
 */
export function validateMapping(
  headers: string[],
  rows: string[][],
  mapping: Mapping,
  headerRow: number,
  existingEmails?: Set<string>,
): MappingReport {
  const projected = projectRows(headers, rows, mapping, headerRow, false);

  let blankEmail = 0, invalidEmail = 0, blankName = 0, dupInFile = 0, dupExisting = 0, usable = 0;
  const seen = new Set<string>();

  for (const p of projected) {
    if (!p.email) { blankEmail++; continue; }
    if (!EMAIL_RE.test(p.email)) { invalidEmail++; continue; }
    if (seen.has(p.email)) { dupInFile++; continue; }
    seen.add(p.email);
    if (existingEmails && existingEmails.has(p.email)) { dupExisting++; continue; }
    if (!p.name) blankName++;
    usable++;
  }

  const perField = {} as Record<Field, FieldQuality>;
  for (const f of FIELDS) {
    const cols: number[] = f.key === 'name'
      ? (mapping.name || [])
      : (mapping[f.key] as number | null) !== null ? [mapping[f.key] as number] : [];
    if (cols.length === 0) {
      perField[f.key] = { mapped: false, filled: 0, blank: rows.length, invalid: 0, samples: [] };
      continue;
    }
    let filled = 0, invalid = 0;
    const samples: string[] = [];
    for (const r of rows) {
      const v = cols.map((c) => (r[c] || '').trim()).filter(Boolean).join(' ');
      if (v) {
        filled++;
        if (samples.length < 3) samples.push(v);
        if (f.key === 'email' && !EMAIL_RE.test(v.toLowerCase())) invalid++;
      }
    }
    perField[f.key] = { mapped: true, filled, blank: rows.length - filled, invalid, samples };
  }

  const blocking: string[] = [];
  const warnings: string[] = [];

  if (mapping.email === null) {
    blocking.push("Pick the column that holds email addresses — a campaign can't send without one.");
  } else if (usable === 0) {
    blocking.push(
      `None of the ${rows.length.toLocaleString()} rows have a usable email address. `
      + 'Check that the header row and the email column are right.',
    );
  }

  if (blankEmail) warnings.push(`${blankEmail.toLocaleString()} rows have no email — they'll be skipped.`);
  if (invalidEmail) warnings.push(`${invalidEmail.toLocaleString()} rows have something that isn't an email address — they'll be skipped.`);
  if (dupInFile) warnings.push(`${dupInFile.toLocaleString()} duplicate addresses inside this file — only the first of each is kept.`);
  if (dupExisting) warnings.push(`${dupExisting.toLocaleString()} are already in your Contacts — they'll be skipped so nobody is emailed twice.`);
  // Not blocking: an email-only list is a real and common export shape, and the
  // local-part fallback handles it. But {{name}} will read oddly, so say so.
  if (mapping.name === null) warnings.push("No name column — we'll use the part of the email before the @ for {{name}}.");
  else if (blankName) warnings.push(`${blankName.toLocaleString()} rows have no name — those will use the email address instead.`);

  return {
    blocking, warnings,
    stats: { total: rows.length, usable, blankEmail, invalidEmail, blankName, dupInFile, dupExisting },
    perField,
  };
}
