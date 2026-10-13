// HN "Ask HN: Who is hiring?" → Leads. The monthly thread where companies post
// their own openings, often with a founder's or hiring manager's email.
//
// No AI and no key: Algolia's HN API returns the whole thread in one request, and
// posts follow a "Company | Role | Location | REMOTE | …" first line that plain
// rules read well. Most posts are US-only, so an automatic import is strict about
// place: only posts that name one of your locations or say remote (anywhere) are
// imported. Rejected posts are counted, not stored — 400 rejects would bury the board.

const { fetchJson } = require('../http');
const { hiringThreads, API } = require('../discovery/enrich/hn');
const { extractEmails, extractLinks } = require('./emails');
const { toSourceLead } = require('./toSourceLeads');
const { placeOf, roleHit, REJECT } = require('./sourceFit');

const ROLE_WORDS = /engineer|developer|programmer|sde|swe|scientist|architect|devops|sre|designer|manager|lead|intern|analyst|full[\s-]?stack|front[\s-]?end|back[\s-]?end|ml|ai\b/i;
const PLACE_WORDS = /remote|onsite|on-site|hybrid|in[\s-]office|\b[A-Z][a-z]+,\s*[A-Z]{2}\b|india|bangalore|bengaluru|london|berlin|new york|nyc|sf|san francisco|europe|usa|\bus\b|uk|canada|global|worldwide|anywhere/i;

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&#x2F;/g, '/')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

/** Pure: HN comment HTML → { text (paragraphs kept), hrefs } */
function hnText(html) {
  const hrefs = [...String(html || '').matchAll(/href="([^"]+)"/g)].map(m => decode(m[1]));
  const text = decode(String(html || '')
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').trim();
  return { text, hrefs };
}

/** Pure: read the "Company | Role | Location | …" first line. Fields missing → ''. */
function parseHeader(text) {
  const first = String(text || '').split('\n')[0].trim();
  if (!first.includes('|')) return { company: '', role: '', location: '' };
  const fields = first.split('|').map(f => f.trim()).filter(Boolean);
  let company = fields[0] && fields[0].length <= 80 ? fields[0].replace(/\s*\(.*?\)\s*$/, '') : '';
  const rest = fields.slice(1);
  let role = rest.find(f => ROLE_WORDS.test(f) && f.length <= 120) || '';
  // "Senior Python Backend Engineer | Remote | …": the title came first, no company.
  if (!role && ROLE_WORDS.test(company) && /\b(?:engineer|developer|scientist|designer|manager)s?\b/i.test(company)) {
    role = company;
    company = '';
  }
  const location = rest.filter(f => f !== role && PLACE_WORDS.test(f)).join(' · ').slice(0, 120);
  return { company, role, location };
}

/** The newest "Who is hiring?" thread, or null. */
async function latestThread({ signal } = {}) {
  const threads = await hiringThreads({ signal });
  return threads && threads.length ? threads[0] : null;
}

/** Every top-level post in a thread, newest-first as HN shows them. */
async function threadPosts(threadId, { signal } = {}) {
  const res = await fetchJson(`${API}/items/${encodeURIComponent(threadId)}`, { timeoutMs: 25_000, retries: 1, signal });
  if (!res.ok || !res.data) return { ok: false, error: res.error || 'HN unavailable', posts: [] };
  const posts = (res.data.children || [])
    .filter(c => c && c.text && c.type === 'comment')
    .map(c => ({ id: String(c.id), author: c.author || '', html: c.text, createdAt: c.created_at || null }));
  return { ok: true, posts };
}

/**
 * Pure: posts → leads worth importing, plus counts. Strict on place (see top).
 * @returns {{ leads: object[], read: number, withEmail: number, rejected: number }}
 */
function postsToLeads(posts, target, now = new Date()) {
  const roles = (target.roles || []).filter(r => String(r).trim());
  const locations = (target.locations || []).map(l => String(l).toLowerCase().trim()).filter(Boolean);
  const leads = [];
  let withEmail = 0;
  let rejected = 0;
  for (const p of posts) {
    const { text, hrefs } = hnText(p.html);
    const head = parseHeader(text);
    const emails = extractEmails(`${text} ${hrefs.filter(h => h.startsWith('mailto:')).join(' ')}`);
    if (emails.length) withEmail++;
    const links = [...new Set([...hrefs.filter(h => /^https?:/i.test(h)), ...extractLinks(text)])];

    const place = placeOf(`${head.location} ${text.slice(0, 600)}`, { locations });
    // On HN a bare "Remote" nearly always means remote within the US, so only an
    // explicit "anywhere" counts as remote here.
    const placeOk = !locations.length || place === 'wanted' || (place === 'global' && locations.includes('remote'));
    const roleOk = !roles.length || !!roleHit(text, roles);
    if (!placeOk || !roleOk || (!emails.length && !links.length)) { rejected++; continue; }

    const lead = toSourceLead({
      source: 'hn',
      text,
      url: `https://news.ycombinator.com/item?id=${p.id}`,
      author: head.company || p.author,
      company: head.company,
      role: head.role,
      location: head.location,
      emails,
      links,
      postedAt: p.createdAt,
      hiring: true, // every top-level post in the thread is a job post
    }, target, now);
    if (lead.fit_score === REJECT) { rejected++; continue; }
    leads.push(lead);
  }
  return { leads, read: posts.length, withEmail, rejected };
}

module.exports = { latestThread, threadPosts, postsToLeads, parseHeader, hnText };
