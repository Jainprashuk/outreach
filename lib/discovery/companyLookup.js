// Turns what you type — a company's name or its website — into the email domain the
// rest of the Discover tab works on. Nobody should need to know that Tata
// Consultancy Services is tcs.com.
//
// Candidates, strongest first:
// 1. Your own contacts whose company matches: the domain their addresses are on.
// 2. A free public company directory (Clearbit's autocomplete, no key). It returns
//    look-alikes too ("Zerodha" → 12400wilshire.com), so only domains that resemble
//    the name are kept. Undocumented and free — if it disappears, 1 and 3 still work.
// 3. Plain guesses (name.com, .in, .co.in, .io), only when nothing else answered.
// Every candidate must have a mail server; one that can't receive email is dropped.

const Contact = require('../../models/Contact');
const { fetchJson, mapLimit } = require('../http');
const { checkMx } = require('../mx');
const { normalizeDomain, domainOfEmail, isFreeMail, stripAccents } = require('../emailPatterns');
const { normCompany } = require('./linkedinResult');

const MAX = 6;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Tata Consultancy Services" → "tcs". */
function acronym(raw) {
  const words = stripAccents(raw).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && w !== 'and' && w !== 'of' && w !== 'the');
  return words.length >= 2 ? words.map(w => w[0]).join('') : '';
}

/** Does this domain plausibly belong to a company with this name? */
function resembles(domain, query) {
  const stem = domain.split('.')[0].replace(/-/g, '');
  const name = normCompany(query).replace(/ /g, '');
  if (!stem || !name) return false;
  if (stem.includes(name) || (name.includes(stem) && stem.length >= 3)) return true;
  const ac = acronym(query);
  return !!ac && ac.length >= 2 && (stem === ac || stem.startsWith(ac));
}

/** A domain typed directly ("acme.in", "https://www.acme.in/careers"). */
function typedDomain(q) {
  const s = String(q || '').trim();
  if (/\s/.test(s) || !s.includes('.')) return null;
  return normalizeDomain(s);
}

async function fromContacts(userId, query) {
  const rows = await Contact.find(
    { userId, deleted: { $ne: true }, company: { $regex: escapeRe(query.trim()), $options: 'i' } },
    { company: 1, email: 1 },
  ).limit(2000).lean();
  const want = normCompany(query);
  const by = new Map();
  for (const r of rows) {
    if (!normCompany(r.company).includes(want)) continue;
    const d = domainOfEmail(r.email);
    if (!d || isFreeMail(d)) continue;
    const e = by.get(d) || { domain: d, name: r.company.trim(), source: 'contacts', contacts: 0 };
    e.contacts++;
    by.set(d, e);
  }
  return [...by.values()].sort((a, b) => b.contacts - a.contacts).slice(0, 3);
}

async function fromDirectory(query, signal) {
  const res = await fetchJson(
    `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query.trim())}`,
    { timeoutMs: 5_000, retries: 0, signal },
  );
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data
    .map(r => ({ domain: normalizeDomain(r.domain), name: String(r.name || '').trim(), source: 'directory', contacts: 0 }))
    .filter(r => r.domain && !isFreeMail(r.domain) && resembles(r.domain, query));
}

function guesses(query) {
  const name = normCompany(query).replace(/ /g, '');
  if (!/^[a-z0-9]{2,40}$/.test(name)) return [];
  return ['com', 'in', 'co.in', 'io'].map(tld => ({ domain: `${name}.${tld}`, name: query.trim(), source: 'guess', contacts: 0 }));
}

/**
 * @returns {Promise<{ candidates: {domain: string, name: string, source: string, contacts: number, exact: boolean}[] }>}
 */
async function lookupCompany(userId, q) {
  const query = String(q || '').trim().slice(0, 80);
  if (query.length < 2) return { candidates: [] };

  const typed = typedDomain(query);
  if (typed) {
    return { candidates: isFreeMail(typed) ? [] : [{ domain: typed, name: '', source: 'typed', contacts: 0, exact: true }] };
  }

  const [own, directory] = await Promise.all([
    fromContacts(userId, query).catch(() => []),
    fromDirectory(query).catch(() => []),
  ]);

  let list = [];
  const seen = new Set();
  for (const c of [...own, ...directory]) {
    if (seen.has(c.domain)) continue;
    seen.add(c.domain);
    list.push(c);
  }
  if (!list.length) list = guesses(query);

  // Only companies that can actually receive email. A DNS answer of "unknown"
  // (a timeout) keeps the candidate — it isn't proof of anything.
  const mx = await mapLimit(list.slice(0, MAX + 2), 4, c => checkMx(c.domain, { timeoutMs: 3000 }));
  const want = normCompany(query);
  const candidates = list.slice(0, MAX + 2)
    .filter((c, i) => mx[i] !== false)
    .slice(0, MAX)
    .map(c => ({
      ...c,
      // Safe to pick without asking: you've emailed this company before, or the
      // directory has a company of exactly this name on a domain that matches it.
      exact: c.source === 'contacts' || (c.source === 'directory' && normCompany(c.name) === want),
    }));
  return { candidates };
}

module.exports = { lookupCompany, resembles, acronym, typedDomain };
