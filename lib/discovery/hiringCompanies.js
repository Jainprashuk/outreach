
// Discover → Hiring now: companies you already know are hiring, gathered from what
// the app has collected — LinkedIn hiring posts (Leads) and Naukri jobs — so you can
// find people there in one click. Job-board postings are deliberately left out.
//
// Read-only, per user, and nothing is copied: the list is rebuilt from those two
// stores on each request.
//
// The two sources know different things. A LinkedIn post carries an email, so its
// company's domain is known for certain. Naukri gives only a company NAME; it is matched to a LinkedIn domain when the names agree, and otherwise
// resolved by the company lookup when you click "Find people".

const Lead = require('../../models/Lead');
const NaukriJob = require('../../models/NaukriJob');
const ProspectSearch = require('../../models/ProspectSearch');
const Prospect = require('../../models/Prospect');
const { domainOfEmail, isFreeMail } = require('../emailPatterns');
const { normCompany } = require('./linkedinResult');

const DAY = 24 * 3600 * 1000;
const MAX_ROLES = 4;

/** acme.in → "Acme" — a readable name when a post gave only an address. */
function nameFromDomain(domain) {
  const stem = String(domain || '').split('.')[0];
  return stem.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// "Acesoft Labs", "Acesoft Labs.com" and "ACESOFT" are one company.
const keyOf = (name) => normCompany(name).replace(/( (com|in|io|co|net|org|ai|tech))+$/, '').replace(/ /g, '');

/**
 * @param {object} [opts]
 * @param {number|null} [opts.days=30]  only activity this recent; null = all time
 * @param {string} [opts.q]              name or domain contains this
 * @param {string} [opts.source]         'linkedin' | 'naukri'
 * @param {boolean} [opts.hideSearched]  leave out companies you've already searched
 * @returns {Promise<{companies: object[], total: number, page: number, pages: number, counts: object}>}
 */
async function hiringCompanies(userId, { days = 30, q = '', source = '', hideSearched = false, page = 1, limit = 50, now = new Date() } = {}) {
  const since = days ? new Date(now.getTime() - days * DAY) : null;
  const when = (field) => (since ? { [field]: { $gte: since } } : {});

  const [leads, naukri, searches, prospectCounts] = await Promise.all([
    Lead.find({ userId, deleted: { $ne: true }, email: { $ne: null }, ...when('createdAt') },
      { email: 1, company: 1, createdAt: 1, postUrl: 1 }).lean(),
    NaukriJob.find({ userId, deleted: { $ne: true }, company: { $nin: ['', null] }, ...when('createdAt') },
      { company: 1, title: 1, createdAt: 1, postedAt: 1 }).lean(),
    ProspectSearch.aggregate([
      { $match: { userId } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$domain', lastSearchAt: { $first: '$createdAt' } } },
    ]),
    Prospect.aggregate([
      { $match: { userId, deleted: { $ne: true } } },
      { $group: { _id: '$domain', n: { $sum: 1 } } },
    ]),
  ]);

  const rows = new Map();          // key → row
  const domainByName = new Map();  // normalised name → domain, learned from LinkedIn posts

  const touch = (key, init) => {
    let r = rows.get(key);
    if (!r) {
      r = { key, company: '', domain: null, linkedin: 0, naukri: 0, roles: [], lastSeenAt: null, ...init };
      rows.set(key, r);
    }
    return r;
  };
  const seen = (r, at) => { if (at && (!r.lastSeenAt || at > r.lastSeenAt)) r.lastSeenAt = at; };
  const addRole = (r, title) => {
    const t = String(title || '').trim();
    if (t && r.roles.length < MAX_ROLES && !r.roles.some(x => x.toLowerCase() === t.toLowerCase())) r.roles.push(t.slice(0, 80));
  };

  // LinkedIn posts: the domain is the email's.
  for (const l of leads) {
    const domain = domainOfEmail(l.email);
    if (!domain || isFreeMail(domain)) continue;
    const r = touch(`d:${domain}`, { domain });
    r.linkedin++;
    if (!r.company && l.company && l.company.toLowerCase() !== domain.split('.')[0]) r.company = l.company;
    seen(r, l.createdAt);
    const nk = keyOf(l.company || nameFromDomain(domain));
    if (nk && !domainByName.has(nk)) domainByName.set(nk, domain);
    const stem = domain.split('.')[0].replace(/-/g, '');
    if (stem && !domainByName.has(stem)) domainByName.set(stem, domain);
  }

  // Naukri: a name — joined to a LinkedIn domain when one matches.
  const byName = (name, source, title, at) => {
    const nk = keyOf(name);
    if (!nk) return;
    const domain = domainByName.get(nk);
    const r = domain ? rows.get(`d:${domain}`) : touch(`n:${nk}`, { company: String(name).trim() });
    const clean = String(name).trim();
    // Keep the tidiest spelling: "Acesoft Labs" over "Acesoft Labs.com".
    const dotted = (n) => /\.(com|in|io|co|net|org|ai|tech)\b/i.test(n);
    if (!r.company || (dotted(r.company) && !dotted(clean))) r.company = clean;
    r[source]++;
    addRole(r, title);
    seen(r, at);
  };
  for (const j of naukri) byName(j.company, 'naukri', j.title, j.postedAt || j.createdAt);

  const searchedAt = new Map(searches.map(s => [s._id, s.lastSearchAt]));
  const peopleAt = new Map(prospectCounts.map(p => [p._id, p.n]));

  const companies = [...rows.values()].map(r => ({
    ...r,
    company: r.company || nameFromDomain(r.domain),
    signals: r.linkedin + r.naukri,
    sources: ['linkedin', 'naukri'].filter(s => r[s] > 0),
    searchedAt: r.domain ? searchedAt.get(r.domain) || null : null,
    people: r.domain ? peopleAt.get(r.domain) || 0 : 0,
  }));
  // Most recent activity first, then the busiest.
  companies.sort((a, b) => (new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0)) || (b.signals - a.signals));

  const needle = String(q || '').trim().toLowerCase();
  const shown = companies.filter(c =>
    (!needle || c.company.toLowerCase().includes(needle) || (c.domain || '').includes(needle))
    && (!source || c[source] > 0)
    && (!hideSearched || !c.searchedAt));
  const pages = Math.max(1, Math.ceil(shown.length / limit));
  const p = Math.min(Math.max(1, page), pages);

  return {
    companies: shown.slice((p - 1) * limit, p * limit),
    total: shown.length,
    page: p,
    pages,
    // Across the whole period, before the search box and source filter.
    counts: {
      all: companies.length,
      linkedin: companies.filter(c => c.linkedin).length,
      naukri: companies.filter(c => c.naukri).length,
      searched: companies.filter(c => c.searchedAt).length,
    },
  };
}

module.exports = { hiringCompanies, nameFromDomain };
