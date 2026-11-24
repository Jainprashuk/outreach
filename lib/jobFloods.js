// One employer flooding the inbox.
//
// Some companies post the same handful of roles once per city, or dozens of
// roles at once (a Benovymed harvest put 61 of 158 new jobs in the inbox, 17
// distinct titles across a dozen cities). They match your keywords, so they
// score well and crowd out everything else. A company is a FLOOD when, among
// the jobs waiting for review, it has
//   - at least minJobs listings, or
//   - one role posted as at least minCities separate listings, in as
//     many different cities. Separate listings: a single one naming "Pune,
//     Noida, Bengaluru" is an ordinary multi-city opening, not a flood.
//
// Both numbers are yours to change (Configuration → Filters, config.floodRules);
// the constants below are the defaults.
//
// Computed on READ from the inbox, never stored: the worker ingests a run in
// batches, so a per-batch count would miss a flood split across two of them,
// and the inbox already holds exactly the rows you would otherwise wade through.
// Nothing is rejected automatically — the review screen groups the company into
// one card and asks you once.

const { keyOf } = require('./discovery/hiringCompanies');
const { normTitle } = require('./jobDupes');

const FLOOD_MIN_JOBS = 8;
const FLOOD_MIN_CITIES = 3;

// keyOf, plus the legal suffixes it leaves behind: "Benovymed Healthcare
// Private Ltd" and "… Private Limited" are one employer.
const companyKey = (name) => keyOf(name || '').replace(/(private|pvt)$/, '');

// "Hybrid - Gurugram", "Noida(Sector 2)", "Pune, Mumbai" → each city once.
function citiesOf(location) {
  return String(location || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(hybrid|remote|work from home)\s*-?\s*/g, ' ')
    .split(/[,/|]/).map(s => s.trim()).filter(Boolean);
}

// rows: { _id, company, title, location, platform } — the pending inbox.
// ignore: company keys you said are not a flood. minJobs / minCities: the rules.
// → [{ key, company, names, platforms, count, roles, cities, repeatedRole, ids }], biggest first.
function findFloods(rows, { ignore = [], minJobs = FLOOD_MIN_JOBS, minCities = FLOOD_MIN_CITIES } = {}) {
  const skip = new Set(ignore);
  const groups = new Map();
  for (const r of rows) {
    const key = companyKey(r.company);
    if (!key || skip.has(key)) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, names: new Map(), platforms: new Set(), ids: [], roles: new Map(), cities: new Set() });
    g.names.set(r.company, (g.names.get(r.company) || 0) + 1);
    g.platforms.add(r.platform || 'naukri');
    g.ids.push(String(r._id));
    const role = normTitle(r.title);
    if (!g.roles.has(role)) g.roles.set(role, { title: r.title, listings: 0, cities: new Set() });
    g.roles.get(role).listings++;
    for (const c of citiesOf(r.location)) { g.roles.get(role).cities.add(c); g.cities.add(c); }
  }

  const out = [];
  for (const g of groups.values()) {
    const spread = (r) => Math.min(r.listings, r.cities.size);
    const widest = [...g.roles.values()].sort((a, b) => spread(b) - spread(a))[0];
    const repeated = widest && spread(widest) >= minCities;
    if (g.ids.length < minJobs && !repeated) continue;
    out.push({
      key: g.key,
      // The spelling seen most often, for the card's heading.
      company: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      names: [...g.names.keys()],
      platforms: [...g.platforms],
      count: g.ids.length,
      roles: g.roles.size,
      cities: g.cities.size,
      repeatedRole: repeated ? { title: widest.title, cities: widest.cities.size } : null,
      ids: g.ids,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// What to add to the company blocklist so every spelling is caught. The
// blocklist matches on a substring, so the shortest spelling usually covers the
// rest ("Benovymed Healthcare" ⊂ "Benovymed Healthcare Private Ltd").
function blockTermsFor(names) {
  const terms = [];
  for (const n of [...names].sort((a, b) => a.length - b.length)) {
    const low = n.toLowerCase().trim();
    if (low && !terms.some(t => low.includes(t))) terms.push(low);
  }
  return terms;
}

module.exports = { findFloods, blockTermsFor, companyKey, citiesOf, FLOOD_MIN_JOBS, FLOOD_MIN_CITIES };
