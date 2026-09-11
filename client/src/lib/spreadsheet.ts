// A real spreadsheet reader.
//
// Deliberately a NEW file rather than an extension of lib/csv.ts: parseCsvText
// there is a naive split(',') that AddContacts and send/Step1 depend on, and
// this module's whole job is to get the cases it gets wrong right. Nothing in
// csv.ts changes.

import type { RawSheet } from './xlsxReader';

export type { RawSheet } from './xlsxReader';

// Compound File Binary — legacy .xls (and .doc). NOT a zip, so not an .xlsx.
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
// .xlsx is a zip archive.
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Anything larger will exhaust the parser long before it reaches the network. */
export const MAX_FILE_BYTES = 15_000_000;

const startsWith = (bytes: number[], sig: number[]) => sig.every((b, i) => bytes[i] === b);

async function magicBytes(file: File): Promise<number[]> {
  return [...new Uint8Array(await file.slice(0, 4).arrayBuffer())];
}

/**
 * RFC-4180 delimited text: quoted fields containing the delimiter or a newline,
 * doubled quotes as an escape, CRLF line endings, and a leading BOM.
 *
 * All four are things parseCsvText mishandles, and none of them could be fixed
 * there without changing the behaviour of the existing import screens.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch !== '"') { field += ch; continue; }
      // A doubled quote inside a quoted field is a literal quote.
      if (t[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); out.push(row); }

  const width = out.reduce((w, r) => Math.max(w, r.length), 0);
  return out
    .map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim()))
    .filter((r) => r.some((c) => c !== ''));
}

/** Thrown for a file we can identify but deliberately refuse to guess at. */
export class UnsupportedSpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSpreadsheetError';
  }
}

/**
 * Read a spreadsheet into one grid per sheet.
 *
 * Dispatch is by magic bytes, not by file extension, because the extension is
 * routinely wrong — a "CSV export" saved from Excel is often a real .xlsx, and
 * an .xls is frequently just a renamed .xlsx.
 */
export async function readSpreadsheet(file: File): Promise<RawSheet[]> {
  if (file.size > MAX_FILE_BYTES) {
    throw new UnsupportedSpreadsheetError(
      `That file is ${(file.size / 1_000_000).toFixed(1)} MB. Split it into smaller sheets and upload them as separate campaigns.`,
    );
  }

  const head = await magicBytes(file);

  if (startsWith(head, OLE2)) {
    // Say so out loud rather than reading a binary container as text. The
    // existing importers accept .xls and then run readAsText() + split(','),
    // which silently produces garbage rows — that failure mode is the reason
    // this check exists.
    throw new UnsupportedSpreadsheetError(
      'That looks like a legacy .xls file. Open it in Excel or Google Sheets and '
      + 're-save it as .xlsx (or export CSV), then upload again.',
    );
  }

  if (startsWith(head, ZIP)) {
    // Lazy chunk — the parser is only fetched once someone actually uploads.
    const { readXlsxSheets } = await import('./xlsxReader');
    const sheets = await readXlsxSheets(file);
    if (sheets.length === 0) throw new UnsupportedSpreadsheetError('That workbook has no sheets.');
    return sheets;
  }

  const text = await file.text();
  const probe = text.slice(0, 4000);
  const delimiter =
    /\.tsv$/i.test(file.name) || probe.split('\t').length > probe.split(',').length ? '\t' : ',';
  const grid = parseDelimited(text, delimiter);
  if (grid.length === 0) throw new UnsupportedSpreadsheetError('That file has no rows in it.');
  return [{ name: file.name, grid }];
}
