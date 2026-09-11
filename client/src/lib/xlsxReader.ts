// The ONLY module in the repo that imports read-excel-file.
//
// spreadsheet.ts reaches it through a dynamic import(), so the ~160 KB parser is
// emitted as its own lazily-fetched chunk (assets/xlsxReader.js) instead of
// landing in app.js — which is committed to git and shipped via vercel.json, so
// bundle growth here is growth in the repo.
//
// Note the entry point: the package publishes NO "." export, only "./browser",
// "./node", "./universal" and "./web-worker". Importing 'read-excel-file' bare
// fails to resolve under Vite.
import readXlsxFile from 'read-excel-file/browser';

/** One worksheet, normalised to a rectangular grid of trimmed strings. */
export interface RawSheet {
  name: string;
  grid: string[][];
}

// v9 returns every cell already typed. Dates become Date objects and numbers
// become numbers, so a phone column or a joined-on date must be flattened back
// to the string the mapping UI and the API both expect. Typed as `unknown`
// rather than a hand-written union so the library's own (stricter) cell types
// flow through without a cast.
const cellToString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
};

/**
 * Read every sheet in one pass.
 *
 * Reading all of them up front (rather than one at a time) means switching the
 * sheet picker costs nothing and never re-parses a multi-megabyte file.
 */
export async function readXlsxSheets(file: File): Promise<RawSheet[]> {
  const sheets = await readXlsxFile(file);

  return sheets.map((s) => {
    const rows: unknown[][] = (s.data as unknown[][]) || [];
    // v9 pads short rows to the widest row, but normalise anyway: this is the
    // one place a ragged grid would turn into undefined reads everywhere
    // downstream, and the cost is negligible.
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const grid = rows
      .map((r) => Array.from({ length: width }, (_, i) => cellToString(r[i] ?? null)))
      .filter((r) => r.some((c) => c !== ''));
    return { name: s.sheet, grid };
  });
}
