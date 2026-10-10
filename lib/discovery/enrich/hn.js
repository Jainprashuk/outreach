// Hacker News "Who is hiring?" — the monthly thread where companies post their own
// openings. A post there in the last two months is a company actively hiring and
// willing to talk to people directly. Free, no key (Algolia's HN API).
//
// The thread list is the same for every company, so it is fetched once per run.

const { fetchJson } = require('../../http');
const { matchName, mentions, plain } = require('./match');

const POINTS = 2;
const WINDOW_MS = 62 * 24 * 3600 * 1000;
const API = 'https://hn.algolia.com/api/v1';

let threadCache = { at: 0, threads: null };

/** The "Ask HN: Who is hiring?" threads of the last two months. */
async function hiringThreads({ signal, now = new Date() } = {}) {
  if (threadCache.threads && now - threadCache.at < 3600 * 1000) return threadCache.threads;
  const res = await fetchJson(`${API}/search_by_date?tags=story,author_whoishiring&hitsPerPage=6`, { timeoutMs: 8_000, retries: 1, signal });
  if (!res.ok || !res.data || !Array.isArray(res.data.hits)) return null;
  const threads = res.data.hits
    .filter(h => /who is hiring/i.test(h.title || '') && now - (h.created_at_i || 0) * 1000 <= WINDOW_MS)
    .map(h => ({ id: String(h.objectID), title: h.title }));
  threadCache = { at: now.getTime(), threads };
  return threads;
}

/** Pure: is one of these comments the company's own job post? Posts start "Company | Role | …". */
function findPost(hits, name, domain = null) {
  for (const h of hits || []) {
    // A post is "Company | Role | …": the company is the short first field. A comment
    // without that shape is someone talking ABOUT the company, not hiring for it.
    const text = plain(h.comment_text || '');
    if (!text.slice(0, 200).includes('|')) continue;
    const head = text.split('|')[0];
    if (head.length <= 80 && (mentions(head, name) || (domain && head.toLowerCase().includes(domain)))) return h;
  }
  return null;
}

async function checkHn(c, { signal, now = new Date() } = {}) {
  const name = matchName(c.company);
  if (!name) return { status: 'skipped', points: 0, reasons: [], note: 'HN check skipped: name too common to search' };
  const threads = await hiringThreads({ signal, now });
  if (!threads) return { status: 'error', points: 0, reasons: [], note: 'HN check unavailable' };
  for (const t of threads) {
    const res = await fetchJson(`${API}/search?query=${encodeURIComponent(name)}&tags=comment,story_${t.id}&hitsPerPage=10`, { timeoutMs: 8_000, retries: 1, signal });
    if (!res.ok) return { status: 'error', points: 0, reasons: [], note: 'HN check unavailable' };
    const post = findPost(res.data && res.data.hits, name, c.domain);
    if (post) {
      const month = (t.title.match(/\(([^)]+)\)/) || [])[1] || 'recently';
      return { status: 'ok', points: POINTS, reasons: [{ text: `Posted in HN "Who is hiring" (${month})`, url: `https://news.ycombinator.com/item?id=${post.objectID}` }] };
    }
  }
  return { status: 'none', points: 0, reasons: [], note: 'Not in HN Who is hiring' };
}

module.exports = { checkHn, findPost, POINTS, _resetCache: () => { threadCache = { at: 0, threads: null }; } };
