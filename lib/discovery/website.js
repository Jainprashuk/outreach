// Reads a fixed, small set of pages on the company's own website for addresses on its
// domain and for team/leadership text. Never crawls: these paths and nothing else,
// each with a timeout and a size cap, and never off to another host.

const { fetchText, mapLimit } = require('../http');
const { isRoleAddress } = require('../emailPatterns');

const PATHS = ['/', '/about', '/about-us', '/team', '/our-team', '/leadership', '/contact', '/contact-us', '/careers'];
// Pages likely to list people by name — the only ones worth an AI call.
const TEAM_PATHS = new Set(['/team', '/our-team', '/leadership', '/about', '/about-us']);

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'" };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
      }
      return ' ';
    })
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function pageTitle(html) {
  const og = String(html || '').match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (og) return og[1].trim();
  const t = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!t) return '';
  // "Acme | Payments for India" → "Acme"
  return htmlToText(t[1]).split(/\s+[|\-–—:·]\s+|:\s+/)[0].trim();
}

function emailsOn(html, domain) {
  const re = new RegExp(`[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)*${domain.replace(/\./g, '\\.')}\\b`, 'gi');
  return [...new Set((String(html || '').match(re) || []).map(e => e.toLowerCase()))]
    .filter(e => !/\.(png|jpe?g|gif|svg|webp)$/.test(e));
}

const sameSite = (finalUrl, domain) => {
  try { const h = new URL(finalUrl).hostname.toLowerCase(); return h === domain || h.endsWith(`.${domain}`); }
  catch (_) { return false; }
};

/** Why a site couldn't be read, in a word the page can explain. */
function whyNot(res, domain) {
  if (res.ok) return sameSite(res.finalUrl, domain) ? null : 'elsewhere';
  if (res.status === 401 || res.status === 403 || res.status === 429) return 'blocked';
  if (res.status) return 'error';
  if (/timed out/i.test(res.error || '')) return 'timeout';
  if (/exceeded/i.test(res.error || '')) return 'too-large';
  return 'unreachable'; // DNS, TLS or connection failure
}

/** Which of https://domain, https://www.domain or (last) http:// answers with a page. */
async function findBase(domain, signal) {
  let why = 'unreachable';
  for (const base of [`https://${domain}`, `https://www.${domain}`, `http://www.${domain}`]) {
    const res = await fetchText(`${base}/`, { timeoutMs: 6_000, signal });
    const w = whyNot(res, domain);
    if (!w) return { base, home: res.data, why: null };
    if (w !== 'unreachable') why = w;
  }
  return { base: null, home: null, why };
}

/** Just the company's name from its homepage, for searches. '' when unknown. */
async function companyNameFromSite(domain, signal) {
  const { home } = await findBase(domain, signal);
  return home ? pageTitle(home).slice(0, 80) : '';
}

/**
 * @returns {Promise<{ok: boolean, title: string, personal: string[], generic: string[],
 *                    teamPages: {path: string, text: string}[]}>}
 */
async function scanWebsite(domain, signal) {
  const { base, home, why } = await findBase(domain, signal);
  if (!base) return { ok: false, why, title: '', personal: [], generic: [], teamPages: [], pages: 0 };

  const rest = await mapLimit(PATHS.slice(1), 3, (path) => fetchText(`${base}${path}`, { timeoutMs: 6_000, signal }));
  const pages = [{ path: '/', html: home }];
  PATHS.slice(1).forEach((path, i) => {
    const r = rest[i];
    if (r && r.ok && sameSite(r.finalUrl, domain) && /html|text/i.test(r.contentType || 'text/html')) pages.push({ path, html: r.data });
  });

  const all = [...new Set(pages.flatMap(p => emailsOn(p.html, domain)))];
  const teamPages = pages
    .filter(p => TEAM_PATHS.has(p.path))
    .map(p => ({ path: p.path, text: htmlToText(p.html).slice(0, 12_000) }))
    .filter(p => p.text.length > 200);

  return {
    ok: true,
    pages: pages.length,
    title: pageTitle(home),
    personal: all.filter(e => !isRoleAddress(e)),
    generic: all.filter(e => isRoleAddress(e)),
    teamPages,
  };
}

module.exports = { scanWebsite, companyNameFromSite, htmlToText, pageTitle, emailsOn };
