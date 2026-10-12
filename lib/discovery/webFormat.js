// More ways to learn a company's email format, for when your own history, GitHub and
// the website are silent. All free:
//
//   1. Gravatar — build each prospect's candidate addresses and ask Gravatar whether
//      that exact address has a profile picture. A hit proves the address is real; a
//      miss proves nothing (most work addresses were never registered there), so a
//      miss is never counted against a format.
//   2. GitHub commit search — the same candidates looked up by commit author, for
//      engineers who commit with their work address outside the company's own org.
//      Only with a GitHub token, and only a handful of calls.
//   3. Real addresses on the web — one search for "@domain"; an address in a result
//      counts only when a name next to it reproduces it exactly (inferPattern).
//   4. Email-format directories — one search for "<company> email format"; RocketReach,
//      LeadIQ, SignalHire and the like state the format in their result snippets. We
//      read the snippets only and never open those sites. One vote per site.
//
// The parsers are pure and proven by scripts/test-email-patterns.js.

const crypto = require('crypto');
const { fetchJson, fetchText } = require('../http');
const ep = require('../emailPatterns');
const { emailsOn } = require('./website');

// ─────────────────────────────────────────────── format templates

// What a placeholder means: F/L a whole first/last name, f/l just its initial.
const SLOTS = {
  first: 'F', firstname: 'F', first_name: 'F', fname: 'F', fn: 'F', given: 'F',
  last: 'L', lastname: 'L', last_name: 'L', lname: 'L', ln: 'L', surname: 'L', family: 'L',
  f: 'f', fi: 'f', first_initial: 'f', firstinitial: 'f', finitial: 'f', first_letter: 'f',
  l: 'l', li: 'l', last_initial: 'l', lastinitial: 'l', linitial: 'l', last_letter: 'l',
};
// Placeholders that may appear without brackets. Single letters never do — "f" in
// running text is not a placeholder.
const BARE = ['first_initial', 'firstinitial', 'last_initial', 'lastinitial', 'first_name', 'firstname', 'last_name', 'lastname', 'first', 'last'];

const SHAPES = {
  'F.L': 'first.last', F: 'first', FL: 'firstlast', fL: 'flast', Fl: 'firstl',
  F_L: 'first_last', 'f.L': 'f.last', 'L.F': 'last.first',
};

/**
 * "[first].[last]", "{f}{last}", "first_initial.last", "first.last" → our format key,
 * or null when it isn't a template or is one we don't build.
 */
function parseTemplate(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/[._-]+$/, '');
  let shape = '';
  let slots = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '[' || ch === '{' || ch === '(' || ch === '<') {
      const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[ch];
      const end = s.indexOf(close, i);
      if (end === -1) return null;
      const inner = s.slice(i + 1, end).trim().replace(/[\s-]+/g, '_');
      const slot = SLOTS[inner];
      if (!slot) return null;
      shape += slot; slots++; i = end + 1;
      continue;
    }
    if (ch === '.' || ch === '_') { shape += ch; i++; continue; }
    if (ch === '-') return null; // first-last: a format we don't build
    const word = BARE.find(w => s.startsWith(w, i));
    if (!word) return null;
    shape += SLOTS[word]; slots++; i += word.length;
  }
  if (!slots) return null;
  return SHAPES[shape] || null;
}

// Names directories use in their made-up examples ("ex. jane.doe@acme.com").
const EXAMPLE_NAMES = ['John Doe', 'Jane Doe', 'John Smith', 'Jane Smith'];

/** "jane.doe" from an example → first.last, when one example name explains it. */
function fromExample(email) {
  const found = new Set(EXAMPLE_NAMES.map(n => ep.inferPattern(n, email)).filter(Boolean));
  return found.size === 1 ? [...found][0] : null;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } };
const shareNear = (text, at) => {
  const m = text.slice(at, at + 140).match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const n = m ? Number(m[1]) : null;
  return n != null && n > 0 && n <= 100 ? n : null;
};

/** Is this search result about this company at all? */
function aboutCompany(r, domain, companyName) {
  const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
  if (text.includes(domain)) return true;
  const name = String(companyName || '').toLowerCase().trim();
  return !!name && name.length >= 3 && String(r.title || '').toLowerCase().includes(name) && /e-?mail/.test(text);
}

/** The formats one result states, in order of appearance: [{ pattern, share, at }]. */
function formatsIn(r, domain) {
  const text = `${r.title}\n${r.snippet}`.toLowerCase();
  const out = [];
  // 1. "<template or example>@domain"
  const atRe = new RegExp(`([a-z0-9_.\\[\\]{}<>()-]{1,60})@${escapeRe(domain)}\\b`, 'g');
  for (const m of text.matchAll(atRe)) {
    const local = m[1].replace(/^[^a-z0-9[{<(]+/, '');
    const pattern = /first|last|[[{<]/.test(local) ? parseTemplate(local) : fromExample(`${local}@${domain}`);
    if (pattern) out.push({ pattern, share: shareNear(text, m.index), at: m.index });
  }
  // 2. A bracketed template on its own: "is [first].[last] (ex. …)".
  for (const m of text.matchAll(/((?:[[{][a-z _-]{1,16}[\]}][._]?){1,3})/g)) {
    const pattern = parseTemplate(m[1]);
    if (pattern && !out.some(o => Math.abs(o.at - m.index) < 3)) out.push({ pattern, share: shareNear(text, m.index), at: m.index });
  }
  // 3. Plain words: "email format is first.last", "format: first_initial.last".
  for (const m of text.matchAll(/format\s*(?:is|:|of|-)?\s*(?:the\s+)?([a-z_.]{4,40})/g)) {
    const pattern = parseTemplate(m[1]);
    if (pattern) out.push({ pattern, share: shareNear(text, m.index), at: m.index });
  }
  return out;
}

/**
 * What the directory sites say, one vote per site (its most-used format, else the
 * first it states).
 *
 * @returns {{ site: string, pattern: string, share: number|null }[]}
 */
function directoryFormats(results, domain, companyName) {
  const bySite = new Map();
  for (const r of results || []) {
    if (!aboutCompany(r, domain, companyName)) continue;
    const site = hostOf(r.url);
    if (!site || site === domain || site.endsWith(`.${domain}`)) continue;
    const found = formatsIn(r, domain);
    if (!found.length) continue;
    const best = found.slice().sort((a, b) => ((b.share || 0) - (a.share || 0)) || (a.at - b.at))[0];
    const prev = bySite.get(site);
    if (!prev || (best.share || 0) > (prev.share || 0)) bySite.set(site, { site, pattern: best.pattern, share: best.share });
  }
  return [...bySite.values()];
}

// ─────────────────────────────────────────────── real addresses in search results

const NAME_RUN = /\b[A-Z][a-zA-Z'’-]+(?:[ \t]+(?:[A-Z]\.|[A-Z][a-zA-Z'’-]+))+/g;

/** Every 2–3 word stretch of a capitalised run: "Speakers Priya Kapoor" → … "Priya Kapoor". */
function nameCandidates(text) {
  const out = new Set();
  for (const m of text.matchAll(NAME_RUN)) {
    const words = m[0].split(/[ \t]+/);
    for (let i = 0; i < words.length; i++) {
      for (let n = 2; n <= 3 && i + n <= words.length; n++) out.add(words.slice(i, i + n).join(' '));
    }
  }
  return [...out].filter(ep.isPlausibleName);
}

/**
 * Real (name, email) pairs from search results. An address counts only when exactly
 * one format explains it from a name: one of your prospects at the company, else a
 * capitalised name within a few words of it.
 *
 * @returns {{ name: string, email: string }[]}
 */
function webAddresses(results, domain, prospectNames = []) {
  const byEmail = new Map();
  for (const r of results || []) {
    const text = `${r.title || ''}\n${r.snippet || ''}`;
    const lower = text.toLowerCase();
    for (const email of emailsOn(text, domain)) {
      if (byEmail.has(email) || ep.domainOfEmail(email) !== domain || ep.isRoleAddress(email)) continue;
      const owners = prospectNames.filter(n => ep.inferPattern(n, email));
      if (owners.length === 1) { byEmail.set(email, { name: owners[0], email }); continue; }

      const at = lower.indexOf(email);
      if (at === -1) continue;
      const near = text.slice(Math.max(0, at - 150), at + email.length + 150);
      const hits = nameCandidates(near).map(n => ({ name: n, pattern: ep.inferPattern(n, email) })).filter(h => h.pattern);
      if (hits.length && new Set(hits.map(h => h.pattern)).size === 1) byEmail.set(email, { name: hits[0].name, email });
    }
  }
  return [...byEmail.values()];
}

// ─────────────────────────────────────────────── Gravatar and GitHub

/** People whose names can fill every format: a full first and last name. */
function fullNames(names) {
  return names.filter(n => {
    const p = ep.splitName(n);
    return p && p.last && !p.initialOnly && !p.lastInitialOnly && ep.isPlausibleName(n);
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

/**
 * Ask Gravatar about each person's candidate addresses. Stops once two addresses
 * agree on a format, or after three hits, or when Gravatar stops answering.
 *
 * @returns {Promise<{ hits: {name: string, email: string}[], checked: number, failed: boolean }>}
 */
async function gravatarHits(names, domain, { signal, maxPeople = 8, patterns = ep.PATTERN_KEYS } = {}) {
  const hits = [];
  let checked = 0;
  let errors = 0;
  for (const name of fullNames(names).slice(0, maxPeople)) {
    if (signal && signal.aborted) break;
    const emails = [...new Set(patterns.map(p => ep.generateEmail(name, p, domain)).filter(Boolean))];
    const results = await Promise.all(emails.map(email => fetchText(
      `https://gravatar.com/avatar/${sha256(email)}?d=404&s=1`,
      { timeoutMs: 5_000, maxBytes: 64 * 1024, signal, headers: { accept: 'image/*' } },
    ).then(res => ({ email, res }))));
    for (const { email, res } of results) {
      checked++;
      if (res.ok) hits.push({ name, email });
      else if (res.status !== 404) errors++;
    }
    if (errors >= 6) return { hits, checked, failed: !hits.length };
    // Stop early only on full-name proof: first-name-only hits (rahul@) are weak signs
    // (see NAME_ONLY in lib/patternScore.js), so keep looking past them.
    const counts = new Map();
    for (const h of hits) {
      const p = ep.inferPattern(h.name, h.email);
      if (p && p !== 'first') counts.set(p, (counts.get(p) || 0) + 1);
    }
    if ([...counts.values()].some(n => n >= 2) || hits.length >= 5) break;
  }
  return { hits, checked, failed: false };
}

/**
 * Look up a few candidate addresses as GitHub commit authors.
 *
 * @returns {Promise<{ hits: {name: string, email: string}[], checked: number, error: string|null }>}
 */
async function githubAuthorHits(names, domain, { token, patterns, signal, maxCalls = 6 } = {}) {
  const hits = [];
  let checked = 0;
  if (!token) return { hits, checked, error: null };
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` };
  outer:
  for (const name of fullNames(names).slice(0, 3)) {
    for (const p of patterns.slice(0, 2)) {
      if (checked >= maxCalls || (signal && signal.aborted)) break outer;
      const email = ep.generateEmail(name, p, domain);
      if (!email) continue;
      checked++;
      const res = await fetchJson(`https://api.github.com/search/commits?q=${encodeURIComponent(`author-email:${email}`)}&per_page=1`,
        { headers, timeoutMs: 8_000, retries: 0, signal });
      if (res.status === 401) return { hits, checked, error: 'GitHub rejected the token' };
      if (res.status === 403 || res.status === 422 || res.status === 429) break outer;
      if (res.ok && res.data && res.data.total_count > 0) { hits.push({ name, email }); break; }
    }
  }
  return { hits, checked, error: null };
}

/** The two search queries the web lookups spend. */
function webQueries(companyName, domain) {
  const name = String(companyName || '').replace(/["]/g, '').trim();
  return {
    addresses: `"@${domain}"`,
    directory: `"${name || domain}" email format ${domain}`,
  };
}

module.exports = {
  parseTemplate, fromExample, formatsIn, directoryFormats, webAddresses, aboutCompany,
  gravatarHits, githubAuthorHits, fullNames, webQueries, sha256,
};
