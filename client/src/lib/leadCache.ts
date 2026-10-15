// A browser copy of every lead and every lead outcome, kept in step by hash.
//
// GET /api/leads and /api/leads/outcomes download everything on every visit — ~36 s
// for 4,880 leads while the database is throttled. Instead the server sends the
// current order with a hash of each document (GET …/sync), and the browser fetches
// only the documents whose hash it doesn't hold (POST …/sync, in chunks). The
// result is exactly what the full endpoints return — same objects, same order —
// so nothing that reads it changes (scripts/parity/lead-cache.js).
//
// One account's data at a time, in IndexedDB; signing out clears it. Without
// IndexedDB (a private window, blocked storage) every visit simply fetches it all.
import { apiFetch } from './api';

const DB = 'outreach-cache';
const STORE = 'sync';
const CHUNK = 500; // = the server's SYNC_CHUNK

type Entry<T> = { h: string; v: T };
interface Snapshot<T> { user: string; entries: Record<string, Entry<T>> }

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function read<T>(key: string): Promise<Snapshot<T> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Snapshot<T>) || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function write(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      if (value === undefined) tx.objectStore(STORE).clear(); else tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

/** Forget every cached account's data (sign-out). */
export const clearLeadCache = () => write('', undefined);

/**
 * The full list behind `path`, in the server's order: cached documents whose hash
 * still matches, plus a fetch of the rest.
 */
async function synced<T>(path: string): Promise<T[]> {
  const { user, order } = await apiFetch<{ user: string; order: Array<[string, string]> }>(`${path}/sync`);
  const cached = await read<T>(path);
  // Another account's copy is never reused (or kept).
  const entries: Record<string, Entry<T>> = cached && cached.user === user ? cached.entries : {};

  const missing = order.filter(([id, h]) => entries[id]?.h !== h).map(([id]) => id);
  for (let i = 0; i < missing.length; i += CHUNK) {
    const rows = await apiFetch<Array<{ id: string; h: string; v: T }>>(`${path}/sync`, {
      method: 'POST', body: JSON.stringify({ ids: missing.slice(i, i + CHUNK) }),
    });
    rows.forEach(r => { entries[r.id] = { h: r.h, v: r.v }; });
  }

  // A document deleted between the two calls is simply not in the list.
  const kept: Record<string, Entry<T>> = {};
  const out: T[] = [];
  for (const [id] of order) {
    const e = entries[id];
    if (!e) continue;
    kept[id] = e;
    out.push(e.v);
  }
  write(path, { user, entries: kept }).catch(() => {});
  return out;
}

/** Same result as GET /api/leads. */
export const loadLeadsSynced = <T>() => synced<T>('/api/leads');

/** Same result as GET /api/leads/outcomes: later contacts win a shared address. */
export async function loadLeadOutcomesSynced<O>(): Promise<{ outcomes: Record<string, O>; count: number }> {
  const rows = await synced<{ key: string; outcome: O }>('/api/leads/outcomes');
  const outcomes: Record<string, O> = {};
  rows.forEach(r => { outcomes[r.key] = r.outcome; });
  return { outcomes, count: Object.keys(outcomes).length };
}
