// Is the company's engineering team active right now? Recent pushes to its public
// GitHub repos are a small but real hint for technical roles. Uses your GitHub
// token when you've added one (5,000 requests an hour), else the keyless 60.
//
// Only an org that is provably theirs counts: one whose profile points at the
// company's domain, or the org a Discover search already settled on. A same-named
// stranger's org must never add points, so the looser name-only guess the people
// search allows is not used here.

const { fetchJson } = require('../../http');
const { orgCandidates, orgBelongsTo } = require('../github');

const POINTS = 1;
const ACTIVE_MS = 30 * 24 * 3600 * 1000;
const API = 'https://api.github.com';

const headers = (token) => ({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** Pure: the most recent push among public, non-fork repos. */
function lastPush(repos) {
  const ts = (repos || []).filter(r => r && !r.fork && !r.archived && r.pushed_at).map(r => new Date(r.pushed_at).getTime()).filter(Number.isFinite);
  return ts.length ? new Date(Math.max(...ts)) : null;
}

/**
 * @param {{company: string, domain: string|null}} c
 * @param {{token?: string, knownOrg?: string|null, signal?: AbortSignal, now?: Date}} ctx
 */
async function checkGithub(c, { token, knownOrg, signal, now = new Date() } = {}) {
  if (!c.domain) return { status: 'skipped', points: 0, reasons: [], note: 'GitHub check needs the company’s domain' };
  const opts = { headers: headers(token), timeoutMs: 8_000, retries: 0, signal };
  let org = knownOrg || null;
  if (!org) {
    for (const slug of orgCandidates(c.domain, c.company)) {
      const res = await fetchJson(`${API}/orgs/${slug}`, opts);
      if (res.status === 403 || res.status === 429) return { status: 'error', points: 0, reasons: [], note: 'GitHub rate limit reached' };
      if (res.ok && res.data && orgBelongsTo(res.data, c.domain)) { org = res.data.login; break; }
    }
  }
  if (!org) return { status: 'none', points: 0, reasons: [], note: 'No GitHub organisation found' };

  const res = await fetchJson(`${API}/orgs/${encodeURIComponent(org)}/repos?type=public&sort=pushed&per_page=10`, opts);
  if (!res.ok || !Array.isArray(res.data)) return { status: 'error', points: 0, reasons: [], note: 'GitHub check unavailable' };
  const at = lastPush(res.data);
  if (!at || now - at > ACTIVE_MS) return { status: 'none', points: 0, reasons: [], note: 'No recent GitHub activity' };
  const days = Math.max(0, Math.round((now - at) / (24 * 3600 * 1000)));
  return { status: 'ok', points: POINTS, reasons: [{ text: `Active on GitHub (last push ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`})`, url: `https://github.com/${org}` }] };
}

module.exports = { checkGithub, lastPush, POINTS };
