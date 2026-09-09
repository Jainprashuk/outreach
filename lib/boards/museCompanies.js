// The Muse is the only source here that publishes a company directory
// (~980 employers). Greenhouse, Lever and Ashby all refuse: /v1/boards is a 404,
// /v0/postings is a 404, and Ashby's board root is a 401 — none of them will
// tell you who their customers are. That asymmetry is why the UI can offer a
// real dropdown for Muse and only a curated starter list for the others.

const { fetchJson, mapLimit } = require('../http');
const { normText } = require('./normalise');

const BASE = 'https://www.themuse.com/api/public/companies';
const CONCURRENCY = 4;
const MAX_PAGES = 60;          // ~49 pages today; the cap is a guard, not a target
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Process-local cache. On Vercel the instance may not survive between requests,
// so this is a nicety rather than a guarantee — the client also caches, and the
// full fetch is only ~13s at CONCURRENCY 4.
let _cache = null;   // { at: number, companies: [] }

/**
 * Every Muse employer, as {name, token}. `token` is Muse's short_name and is
 * what `jobs?company=` expects.
 *
 * @param {{force?: boolean, signal?: AbortSignal}} [opts]
 * @returns {Promise<{companies: Array<{name,token,size,industries}>, cached: boolean, pages: number, error: string|null}>}
 */
async function listCompanies({ force = false, signal } = {}) {
  if (!force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return { companies: _cache.companies, cached: true, pages: 0, error: null };
  }

  // Page 1 first, purely to learn page_count.
  const first = await fetchJson(`${BASE}?page=1`, { signal, retries: 1 });
  if (!first.ok) {
    return { companies: _cache ? _cache.companies : [], cached: !!_cache, pages: 0, error: first.error };
  }
  const pageCount = Math.min(Number(first.data.page_count) || 1, MAX_PAGES);

  const rest = await mapLimit(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) => i + 2),
    CONCURRENCY,
    async (page) => {
      const r = await fetchJson(`${BASE}?page=${page}`, { signal, retries: 0 });
      return r.ok && r.data && Array.isArray(r.data.results) ? r.data.results : [];
    }
  );

  const rows = [...(first.data.results || []), ...rest.flat().filter(Boolean)];

  const seen = new Set();
  const companies = [];
  for (const c of rows) {
    const token = normText(c && c.short_name).toLowerCase();
    const name = normText(c && c.name);
    if (!token || !name || seen.has(token)) continue;
    seen.add(token);
    companies.push({
      name,
      token,
      size: normText(c.size && c.size.name),
      industries: (c.industries || []).map(i => normText(i && i.name)).filter(Boolean).slice(0, 3),
    });
  }
  companies.sort((a, b) => a.name.localeCompare(b.name));

  _cache = { at: Date.now(), companies };
  return { companies, cached: false, pages: pageCount, error: null };
}

module.exports = { listCompanies, CACHE_TTL_MS };
