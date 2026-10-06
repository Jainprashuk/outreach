// A company's public GitHub organisation, read for the work addresses its engineers
// commit with. One pass gives both people (name + their real address) and evidence
// of the company's email format. Works without a token (60 requests an hour, shared
// by the server's IP); a free token in Settings raises that to 5,000.

const { fetchJson, mapLimit } = require('../http');
const { normCompany } = require('./linkedinResult');
const { normalizeDomain, domainOfEmail } = require('../emailPatterns');

const API = 'https://api.github.com';
const MAX_REPOS = 10;
const COMMITS_PER_REPO = 50;

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Likely org slugs for a company: acme, acme-in, acmehq, plus the company name. */
function orgCandidates(domain, companyName) {
  const stem = domain.split('.')[0];
  const tld = domain.split('.').slice(1).join('-');
  const name = normCompany(companyName);
  return [...new Set([
    stem,
    name.replace(/ /g, ''),
    name.replace(/ /g, '-'),
    `${stem}-${tld}`,
    `${stem}hq`,
  ].filter(s => s && /^[a-z0-9-]+$/.test(s)))].slice(0, 4);
}

/** Does this org point at the company's own domain? Stops "acme" matching a stranger. */
function orgBelongsTo(org, domain) {
  const blog = normalizeDomain(org.blog || '');
  if (blog && (blog === domain || blog.endsWith(`.${domain}`))) return true;
  return domainOfEmail(org.email || '') === domain;
}

const rateLimited = (res) => (res.status === 403 || res.status === 429) && /rate limit/i.test(res.errorBody || res.error || '');

/**
 * @returns {Promise<{org: string|null, identities: {name: string, email: string}[], error: string|null}>}
 */
async function githubPeople({ token, domain, companyName, orgOverride, signal }) {
  const opts = { headers: headers(token), timeoutMs: 10_000, retries: 0, signal, maxBytes: 4 * 1024 * 1024 };
  let org = null;

  if (orgOverride) {
    org = orgOverride;
  } else {
    // Prefer an org that points at the company's domain. Failing that, accept the org
    // named exactly like the domain (zerodha.com → github.com/zerodha, whose site is
    // zerodha.tech). A wrong guess is harmless: only commit addresses ending in
    // @<domain> are ever kept, so a stranger's org yields nothing.
    let exact = null;
    for (const slug of orgCandidates(domain, companyName)) {
      const res = await fetchJson(`${API}/orgs/${slug}`, opts);
      if (rateLimited(res)) return { org: null, identities: [], error: 'GitHub rate limit reached — add a free GitHub token in Settings' };
      if (!res.ok || !res.data) continue;
      if (orgBelongsTo(res.data, domain)) { org = res.data.login; break; }
      if (!exact && String(res.data.login).toLowerCase() === domain.split('.')[0]) exact = res.data.login;
    }
    org = org || exact;
  }
  if (!org) return { org: null, identities: [], error: null };

  const reposRes = await fetchJson(`${API}/orgs/${org}/repos?type=public&sort=pushed&per_page=30`, opts);
  if (rateLimited(reposRes)) return { org, identities: [], error: 'GitHub rate limit reached — add a free GitHub token in Settings' };
  if (!reposRes.ok || !Array.isArray(reposRes.data)) return { org, identities: [], error: reposRes.error };

  const repos = reposRes.data.filter(r => !r.fork && !r.archived).slice(0, MAX_REPOS);
  const pages = await mapLimit(repos, 3, (r) => fetchJson(`${API}/repos/${org}/${r.name}/commits?per_page=${COMMITS_PER_REPO}`, opts));

  const byEmail = new Map();
  for (const page of pages) {
    if (!page || !page.ok || !Array.isArray(page.data)) continue;
    for (const c of page.data) {
      for (const who of [c.commit && c.commit.author, c.commit && c.commit.committer]) {
        const email = String((who && who.email) || '').trim().toLowerCase();
        if (domainOfEmail(email) !== domain || /noreply|no-reply/.test(email)) continue;
        if (!byEmail.has(email)) byEmail.set(email, { name: String(who.name || '').trim(), email });
      }
    }
  }
  return { org, identities: [...byEmail.values()], error: null };
}

module.exports = { githubPeople, orgCandidates, orgBelongsTo };
