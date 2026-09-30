import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { loadContactListApi, type ContactListPage } from '../lib/api';

/** The filter state Dashboard / Contacts hold, as they always have. */
export interface ContactListQuery {
  tab: string;
  search?: string;
  status?: string;
  approval?: string;
  template?: string;
  category?: string;
  source?: string;
  /** Local yyyy-mm-dd from <input type="date">, as ContactDateFilterPanel gives them. */
  createdFrom?: string; createdTo?: string;
  sentFrom?: string; sentTo?: string;
  repliedFrom?: string; repliedTo?: string;
  /** Dashboard only — Contacts shows the unsorted base order. */
  sort?: string;
  dir?: 'asc' | 'desc';
}

// A day picked in the browser becomes an exact instant here, in the browser's
// own timezone — the same bounds the old in-memory filter used — so the server
// never has to guess which "day" was meant.
const dayStart = (d?: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : '');
const dayEnd = (d?: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : '');

export function toListParams(q: ContactListQuery): Record<string, string> {
  const raw: Record<string, string | undefined> = {
    tab: q.tab, q: q.search, status: q.status, approval: q.approval, template: q.template,
    category: q.category, source: q.source,
    createdFrom: dayStart(q.createdFrom), createdTo: dayEnd(q.createdTo),
    sentFrom: dayStart(q.sentFrom), sentTo: dayEnd(q.sentTo),
    repliedFrom: dayStart(q.repliedFrom), repliedTo: dayEnd(q.repliedTo),
    sort: q.sort, dir: q.sort ? q.dir : undefined,
  };
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v)) as Record<string, string>;
}

/** Every id the query matches, in table order — for "select all / first N". */
export async function loadContactListIds(q: ContactListQuery): Promise<string[]> {
  const res = await loadContactListApi({ ...toListParams(q), ids: '1', limit: '1' });
  return res.ids || [];
}

/**
 * One page of the contact table from the server. Refetches when the query or
 * page changes, and whenever any contact is changed through the app store
 * (inline status edits, reclassification, deletes, imports, mailbox checks),
 * which is when the in-memory table used to re-render. The previous page stays
 * on screen while the next one loads.
 */
export function useContactList(query: ContactListQuery, page: number, opts: { withIds?: boolean; pageSize?: number } = {}) {
  const { contactsVersion } = useApp();
  const [data, setData] = useState<ContactListPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Typing in the search box shouldn't fire a request per keystroke; tabs,
  // dropdowns and sorts still apply immediately.
  const [search, setSearch] = useState(query.search || '');
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.search || ''), 200);
    return () => clearTimeout(t);
  }, [query.search]);
  const debouncedKey = JSON.stringify(toListParams({ ...query, search }));

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const params: Record<string, string> = {
      ...JSON.parse(debouncedKey), page: String(page), limit: String(opts.pageSize || 25),
      ...(opts.withIds ? { ids: '1' } : {}),
    };
    loadContactListApi(params, ac.signal)
      .then(res => { if (!ac.signal.aborted) { setData(res); setError(''); } })
      .catch(err => { if (!ac.signal.aborted) setError(err.message || 'Could not load contacts'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [debouncedKey, page, opts.withIds, opts.pageSize, contactsVersion, reloadTick]);

  const reload = useCallback(() => setReloadTick(t => t + 1), []);
  return { data, error, loading, reload };
}
