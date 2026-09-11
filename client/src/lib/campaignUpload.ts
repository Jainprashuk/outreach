import type { ProjectedRow } from './campaignMapping';

// Vercel rejects request bodies over ~4.5 MB at the edge with a PLAIN-TEXT 413,
// and apiFetch calls res.json() unconditionally — so an oversized upload
// surfaces as an opaque SyntaxError rather than anything actionable. The same
// hazard is already documented at the top of pages/Leads.tsx.
//
// Budget well under the cap and measure BYTES, not string length: names and
// company names carry non-ASCII, where one character can be three bytes.
const MAX_CHUNK_BYTES = 3_000_000;
// Independently cap the row count so a single request stays inside
// vercel.json maxDuration: 60 even when the rows are tiny.
const MAX_CHUNK_ROWS = 2_000;

const byteLength = (s: string) =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

/** Split rows into request-sized batches, bounded by bytes AND row count. */
export function chunkRows(rows: ProjectedRow[]): ProjectedRow[][] {
  const chunks: ProjectedRow[][] = [];
  let cur: ProjectedRow[] = [];
  let bytes = 2;   // the enclosing []

  for (const r of rows) {
    const size = byteLength(JSON.stringify(r)) + 1;
    // A single row larger than a whole chunk can never be sent; dropping it
    // beats failing the entire upload over one pathological cell.
    if (size > MAX_CHUNK_BYTES) continue;
    if (cur.length > 0 && (bytes + size > MAX_CHUNK_BYTES || cur.length >= MAX_CHUNK_ROWS)) {
      chunks.push(cur); cur = []; bytes = 2;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Retry only what is worth retrying. A validation error fails identically three times. */
const isRetryable = (err: unknown) => {
  const m = String((err as Error)?.message || '').toLowerCase();
  return m.includes('fetch') || m.includes('network') || m.includes('timeout')
      || m.includes('failed') || m.includes('502') || m.includes('503') || m.includes('504');
};

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, i === 0 ? 500 : 1500));
    }
  }
  throw lastErr;
}

export interface UploadHandlers<C> {
  create: () => Promise<C>;
  idOf: (campaign: C) => string;
  append: (id: string, payload: { startIndex: number; rows: ProjectedRow[]; last: boolean }) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Create the campaign, then stream its rows up in sequential chunks.
 *
 * Sequential rather than parallel: parallel chunks would contend on the same
 * campaign document for the row counters and need server-side reordering, and at
 * 3 MB a chunk even a 40k-row sheet is only a handful of requests.
 */
export async function uploadCampaign<C>(rows: ProjectedRow[], h: UploadHandlers<C>): Promise<C> {
  const chunks = chunkRows(rows);
  const campaign = await h.create();
  const id = h.idOf(campaign);

  let done = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      await withRetry(() => h.append(id, {
        startIndex: done,
        rows: chunks[i],
        last: i === chunks.length - 1,
      }));
      done += chunks[i].length;
      h.onProgress?.(done, rows.length);
    }
  } catch (err) {
    // Never leave a half-filled campaign behind. A draft has no batches and no
    // Contacts yet, so discarding it is genuinely free.
    await h.remove(id).catch(() => {});
    throw err;
  }
  return campaign;
}
