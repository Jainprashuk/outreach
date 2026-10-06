// Finds people at a company through a web-search API, reading names and titles from
// the results for LinkedIn profiles. LinkedIn itself is never opened — only what the
// search engine shows. Tavily first (1,000 free credits a month), SerpApi as the
// backup (250 a month). Each query spends one credit of the user's own key.

const { postJson, fetchJson } = require('../http');
const { parseLinkedInResult, matchesRoles } = require('./linkedinResult');
const { nameKey } = require('../emailPatterns');
const usage = require('./usage');

const MAX_ROLES = 5;

const quote = (s) => `"${String(s).replace(/["]/g, '').trim()}"`;

/** The queries for one search. Roles are optional; without them, anyone at the company. */
function buildQueries(companyName, roles) {
  const co = quote(companyName);
  const clean = (roles || []).map(r => String(r || '').trim()).filter(Boolean).slice(0, MAX_ROLES);
  if (clean.length) return clean.map(r => `${co} ${quote(r)}`);
  return [co, `${co} (manager OR head OR director OR recruiter OR lead)`];
}

async function tavily(key, query, signal) {
  const res = await postJson('https://api.tavily.com/search', {
    timeoutMs: 15_000,
    signal,
    headers: { authorization: `Bearer ${key}` },
    body: { query: `${query} linkedin`, search_depth: 'basic', max_results: 20, include_domains: ['linkedin.com'] },
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const rows = (res.data && res.data.results) || [];
  return { ok: true, results: rows.map(r => ({ title: r.title, url: r.url, snippet: r.content })) };
}

async function serpapi(key, query, signal) {
  const q = encodeURIComponent(`site:linkedin.com/in ${query}`);
  const res = await fetchJson(`https://serpapi.com/search.json?engine=google&num=20&q=${q}&api_key=${encodeURIComponent(key)}`, {
    timeoutMs: 20_000, retries: 0, signal,
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const rows = (res.data && res.data.organic_results) || [];
  return { ok: true, results: rows.map(r => ({ title: r.title, url: r.link, snippet: r.snippet })) };
}

const PROVIDERS = { tavily, serpapi };

function describe(provider, res) {
  if (res.status === 401 || res.status === 403) return `${provider} rejected the key — check it in Settings`;
  if (res.status === 429 || res.status === 432) return `${provider} free allowance used up`;
  return `${provider}: ${res.error || 'request failed'}`;
}

/**
 * @returns {Promise<{people: object[], queries: number, provider: string|null, error: string|null}>}
 */
async function searchPeople({ userId, keys, companyName, domain, roles, signal }) {
  const order = ['tavily', 'serpapi'].filter(p => keys[p]);
  if (!order.length) return { people: [], queries: 0, provider: null, error: 'No search key — add a free Tavily key in Settings' };

  const byKey = new Map();
  let queries = 0;
  let provider = null;
  let error = null;
  const available = new Set(order);

  for (const query of buildQueries(companyName, roles)) {
    let done = false;
    for (const p of order) {
      if (!available.has(p)) continue;
      if (!(await usage.take(userId, p))) { available.delete(p); error = `${p} monthly allowance used up`; continue; }
      const res = await PROVIDERS[p](keys[p], query, signal);
      if (!res.ok) {
        error = describe(p, res);
        if ([401, 403, 429, 432].includes(res.status)) available.delete(p);
        continue;
      }
      queries++;
      provider = provider || p;
      for (const r of res.results) {
        const person = parseLinkedInResult(r, { companyName, domain });
        if (!person) continue;
        const key = nameKey(person.name);
        if (!key || byKey.has(key)) continue;
        byKey.set(key, { ...person, roleMatch: matchesRoles(person.title, roles), via: 'search' });
      }
      done = true;
      break;
    }
    if (!done && !available.size) break;
  }

  return { people: [...byKey.values()], queries, provider, error: byKey.size || queries ? null : error };
}

module.exports = { searchPeople, buildQueries };
