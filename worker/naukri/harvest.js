'use strict';

// Collecting listings off Naukri's search results.
//
// Read-only by construction: it opens result pages, reads cards, and closes
// them. It never clicks a job, never opens a listing, never applies. That is
// what makes it the safe half of this feature — the worst a broken harvest can
// do is put nothing in your review queue.
//
// SELECTORS: everything Naukri-shaped lives in this file. When a harvest starts
// returning zero, fix the selector here. Do not add retries — a retry loop
// against a changed DOM is how you get rate-limited for nothing.
//
// Verified against the live site on 2026-09-24:
//   card       div.srp-jobtuple-wrapper          (20 per page)
//   title      a.title            -> "Backend Developer", href carries the id
//   company    a.comp-name        -> "Photon"
//   experience span.expwdth       -> "3-6 Yrs"
//   location   span.locWdth       -> "Bengaluru, Hyderabad, Mumbai, ..."
//   salary     span.sal-wrap      -> usually ABSENT; most listings hide pay
//   posted     span.job-post-day  -> "6 days ago" / "3+ weeks ago"
//   tags       ul.tags-gt li

const { check, jitter } = require('./guard');
const { newPage } = require('./session');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hard caps, module constants rather than config — the same doctrine the
// LinkedIn harvester states in TRACK-SCROLL.md. The number of pages you walk is
// a safety property, not a preference.
const MAX_PAGES = 8;
const MAX_SEARCHES = 10;
const PAGE_DELAY = [1800, 4200];   // between page loads, randomised
const CARDS_PER_PAGE = 20;         // Naukri's own page size; used to stop early

const CARD = 'div.srp-jobtuple-wrapper';

// Naukri's "Recommended jobs" — the listings it picks for your profile.
//
// Verified against the live page on 2026-10-17. Its cards are NOT links (no
// href anywhere on article.jobTuple), so they are not read off the page at all.
// The page fetches its jobs as JSON from /jobapi/v2/search/recom-jobs — one
// POST per tab, {"clusterId": null | "profile" | "preference" |
// "similar_jobs"} — and the harvest listens to those responses as the page
// makes them. No request is added; it reads what the page already asked for.
//
// The feed is richer than any card: it carries the listing URL (jdURL), and
// `companyApplyJob`, Naukri's own word on whether Apply leaves for the
// employer's site — a fact, where the search harvest can only predict.
//
//   tabs   .tab-wrapper#apply (default) · #profile · #preference · #similar_jobs
//   cards  article.jobTuple[data-job-id]  (only used to see that the page painted)
const RECOMMENDED_URL = 'https://www.naukri.com/mnjuser/recommendedjobs';
const RECOMMENDED_FEED = /\/jobapi\/v\d+\/search\/recom-jobs/;
const RECOMMENDED_CARD = 'article.jobTuple';
const RECOMMENDED_TABS = [
  ['apply', 'Applies'],          // shown first; similar to jobs you applied to
  ['profile', 'Profile'],
  ['preference', 'Preferences'],
  ['similar_jobs', 'You might like'],
];
const RECOMMENDED_LABEL = 'Recommended for you';

// "backend developer" + "bangalore" -> /backend-developer-jobs-in-bangalore
//
// Built as a slug rather than ?k=/&l=: Naukri 301s the query form onto the slug
// anyway, and doing it ourselves avoids the encoding trap that turned
// "backend%20developer" into "backend-20developer" — a URL that silently
// returns a different, empty search rather than failing.
const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

function searchUrl(search, page) {
  // A pasted URL wins: it is the one way to express a filter combination the
  // form does not model, and rewriting it would throw that away.
  if (search.url) {
    const u = new URL(search.url);
    if (page > 1) u.pathname = u.pathname.replace(/\/?$/, '') + `-${page}`;
    return u.toString();
  }

  const kw = slugify(search.keywords);
  const loc = slugify(search.location);
  if (!kw) return null;

  let path = loc ? `${kw}-jobs-in-${loc}` : `${kw}-jobs`;
  if (page > 1) path += `-${page}`;          // page 2 = the slug with -2 appended

  const u = new URL(`https://www.naukri.com/${path}`);
  if (Number.isFinite(search.experienceYears) && search.experienceYears !== null) {
    u.searchParams.set('experience', String(search.experienceYears));
  }
  // Naukri's own freshness filter. Applying it server-side is far better than
  // harvesting a month of listings and dropping them locally.
  if (Number.isFinite(search.jobAge) && search.jobAge) {
    u.searchParams.set('jobAge', String(search.jobAge));
  }
  return u.toString();
}

// One page of cards -> plain objects. Runs inside the page, so it must not
// reference anything from this module's scope.
async function readCards(page) {
  return page.evaluate((CARD_SEL) => {
    const text = (root, sel) => {
      const el = root.querySelector(sel);
      return el ? el.innerText.trim() : '';
    };

    // "3-6 Yrs" / "5+ Yrs" / "0-1 Yrs" -> [min, max]. Null rather than 0 when
    // absent: 0 means fresher, which is a real answer and a different one.
    const parseExp = (s) => {
      if (!s) return [null, null];
      const m = s.match(/(\d+)\s*-\s*(\d+)/);
      if (m) return [Number(m[1]), Number(m[2])];
      const plus = s.match(/(\d+)\s*\+/);
      if (plus) return [Number(plus[1]), null];
      const one = s.match(/(\d+)/);
      return one ? [Number(one[1]), Number(one[1])] : [null, null];
    };

    return [...document.querySelectorAll(CARD_SEL)].map((card) => {
      const titleEl = card.querySelector('a.title');
      const href = titleEl ? titleEl.href : '';
      // The id lives at the end of the listing URL. Read from the href rather
      // than a data- attribute: the attribute is not always populated by the
      // time the card paints, the URL always is.
      const idMatch = href.match(/-(\d{6,})(?:\?|$)/);
      const [experienceMin, experienceMax] = parseExp(text(card, 'span.expwdth'));

      return {
        sourceId: idMatch ? idMatch[1] : '',
        title: titleEl ? titleEl.innerText.trim() : '',
        company: text(card, 'a.comp-name'),
        location: text(card, 'span.locWdth'),
        experienceMin, experienceMax,
        // Left as Naukri's own words. Most listings hide pay entirely, and
        // inventing a number for "Not disclosed" would make the salary filter
        // lie.
        salaryText: text(card, 'span.sal-wrap') || text(card, 'span.sal'),
        description: text(card, 'span.job-desc').slice(0, 2000),
        postedText: text(card, 'span.job-post-day'),
        tags: [...card.querySelectorAll('ul.tags-gt li')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 12),
        url: href,
        // Naukri marks these on the card. The filter uses it to avoid putting
        // something back in your queue that you already applied to by hand.
        // The card's own "Applied" marker — read with the title taken out, or
        // "Applied Scientist" would be dropped as already applied to.
        alreadyApplied: /(^|[^a-z])applied(?![a-z])/i.test((card.innerText || '').replace(titleEl ? titleEl.innerText : '', '')),
      };
    }).filter(j => j.sourceId && j.title);
  }, CARD);
}

// A configured limit, never above the hard cap: Settings can only lower these.
const capped = (v, cap) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, cap) : cap;
};

// One recom-jobs entry -> the same shape readCards returns. Pure.
const stripHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();

function fromFeed(d, tabLabel) {
  const ph = (type) => ((d.placeholders || []).find(p => p && p.type === type) || {}).label || '';
  const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    sourceId: String(d.jobId || ''),
    title: String(d.title || '').trim(),
    company: String(d.companyName || '').trim(),
    location: ph('location'),
    experienceMin: n(d.minimumExperience),
    experienceMax: n(d.maximumExperience),
    salaryText: ph('salary'),
    description: stripHtml(d.jobDescription).slice(0, 2000),
    postedText: String(d.footerPlaceholderLabel || ''),
    postedAt: Number.isFinite(Number(d.createdDate)) && d.createdDate ? new Date(Number(d.createdDate)).toISOString() : null,
    tags: String(d.tagsAndSkills || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 12),
    url: d.jdURL ? new URL(d.jdURL, 'https://www.naukri.com').toString() : '',
    // Naukri says so outright here; no guessing from the employer's history.
    companySite: d.companyApplyJob === true,
    // Only if Naukri's own feed names who posted it (field names unverified —
    // nothing is stored when they are absent). No extra page is opened for this.
    ...(() => {
      const o = d.recruiter && typeof d.recruiter === 'object' ? d.recruiter : {};
      const name = String(d.recruiterName || o.name || o.recruiterName || '').trim();
      const email = String(d.recruiterEmail || o.email || '').trim();
      return name || email ? { recruiters: [{ name, email, title: String(o.designation || o.title || '').trim() }] } : {};
    })(),
    alreadyApplied: false,
    recommendedTab: tabLabel,
  };
}

// Walk Recommended jobs: open it, then each tab in turn, collecting what the
// page's own feed returns. `maxTabs` caps how many tabs (1–4) are opened.
async function harvestRecommended(page, { tabIds = null, onProgress, found }) {
  const byId = new Map();
  let current = RECOMMENDED_TABS[0][1];
  const onResponse = async (res) => {
    if (!RECOMMENDED_FEED.test(res.url())) return;
    try {
      const body = await res.json();
      if (current === RECOMMENDED_TABS[0][1] && !keepFirst) return;
      for (const d of body.jobDetails || []) {
        const job = fromFeed(d, current);
        if (job.sourceId && job.title && job.url && !byId.has(job.sourceId)) byId.set(job.sourceId, job);
      }
    } catch (_) { /* a response we cannot read adds nothing */ }
  };
  page.on('response', onResponse);
  // The first tab always loads with the page; the others only when clicked,
  // so an unselected first tab is loaded but its jobs are not kept.
  const wanted = new Set(Array.isArray(tabIds) && tabIds.length ? tabIds : RECOMMENDED_TABS.map(t => t[0]));
  const tabs = RECOMMENDED_TABS.filter(([id], i) => i === 0 || wanted.has(id));
  const keepFirst = wanted.has(RECOMMENDED_TABS[0][0]);
  try {
    onProgress({ phase: 'recommended', label: `Recommended · ${current}`, page: 0, pagesTotal: tabs.length, found: found() });
    const first = page.waitForResponse(r => RECOMMENDED_FEED.test(r.url()), { timeout: 25000 }).catch(() => null);
    await page.goto(RECOMMENDED_URL, { waitUntil: 'domcontentloaded' });
    const [feed, painted] = await Promise.all([
      first,
      page.waitForSelector(RECOMMENDED_CARD, { timeout: 25000 }).catch(() => null),
    ]);
    await check(page, 'your recommended jobs');
    if (!painted && !feed) return [];
    if (painted && !feed) {
      // Cards on screen but no feed seen: the page has changed how it loads.
      // Loud, because silently returning nothing would read as "no jobs".
      throw new Error('Recommended jobs painted, but its jobs feed (/jobapi/…/recom-jobs) was not seen — '
        + 'Naukri changed the page. Fix RECOMMENDED_FEED in worker/naukri/harvest.js.');
    }
    await sleep(800);   // let the first response's body be read
    onProgress({ phase: 'recommended', label: `Recommended · ${current}`, page: 1, pagesTotal: tabs.length, found: found() + byId.size });

    for (let i = 1; i < tabs.length; i++) {
      const [id, label] = tabs[i];
      const tab = page.locator(`.tab-wrapper#${id}`);
      if (!await tab.count().catch(() => 0)) continue;     // tab not offered to this account
      await jitter(PAGE_DELAY[0], PAGE_DELAY[1]);
      current = label;
      const next = page.waitForResponse(r => RECOMMENDED_FEED.test(r.url()), { timeout: 15000 }).catch(() => null);
      await tab.click().catch(() => {});
      await next;
      await sleep(800);
      await check(page, 'your recommended jobs');
      onProgress({ phase: 'recommended', label: `Recommended · ${label}`, page: i + 1, pagesTotal: tabs.length, found: found() + byId.size });
    }
  } finally {
    page.off('response', onResponse);
  }
  return [...byId.values()];
}

// Which sources this harvest walks. A run can carry its own choice (the
// Harvest button's menu); otherwise the config's default. Older configs with
// neither mean searches only — what harvesting always did.
function sourcesOf(config) {
  const s = config.sources || {};
  return { searches: s.searches !== false, recommended: s.recommended === true };
}

async function harvest(session, { config = {}, onProgress = () => {} } = {}) {
  const sources = sourcesOf(config);
  const limits = config.searchLimits || {};
  const maxSearches = capped(limits.maxSearches, MAX_SEARCHES);
  const maxPages = capped(limits.maxPages, MAX_PAGES);
  const searches = !sources.searches ? [] : (Array.isArray(config.searches) ? config.searches : [])
    .filter(s => s && s.enabled !== false && (s.keywords || s.url))
    .slice(0, maxSearches);

  if (!searches.length && !sources.recommended) {
    throw new Error(sources.searches
      ? 'No searches configured. Add one in Configuration → Searches, or harvest Recommended jobs instead.'
      : 'Nothing to harvest: neither searches nor recommended jobs are selected.');
  }

  // Ask Naukri to apply the age filter rather than harvesting a month and
  // dropping it locally — fewer pages walked for the same result.
  const jobAge = Number(config.filters && config.filters.maxPostedAgeDays) || null;

  const page = await newPage(session);
  const byKey = new Map();          // sourceId -> job, so the same role found by
                                    // two searches is one row with two queries
  let pagesWalked = 0;

  for (let i = 0; i < searches.length; i++) {
    const search = searches[i];
    const label = search.label || search.keywords || search.url || `search ${i + 1}`;

    for (let n = 1; n <= maxPages; n++) {
      const url = searchUrl({ ...search, jobAge }, n);
      if (!url) break;

      onProgress({
        phase: 'searching', label,
        page: pagesWalked + 1, pagesTotal: searches.length * maxPages,
        found: byKey.size,
      });

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // The results column renders client-side; domcontentloaded fires long
      // before the cards exist. Wait for a card rather than a fixed sleep, but
      // treat "no cards" as the end of the search, not an error — running out of
      // pages is the normal way a search finishes.
      const appeared = await page.waitForSelector(CARD, { timeout: 15000 }).catch(() => null);
      await check(page, `search results for "${label}"`);
      if (!appeared) break;

      const cards = await readCards(page);
      pagesWalked++;
      for (const job of cards) {
        const existing = byKey.get(job.sourceId);
        if (existing) {
          if (!existing.queries.includes(label)) existing.queries.push(label);
        } else {
          byKey.set(job.sourceId, { ...job, queries: [label] });
        }
      }

      onProgress({
        phase: 'searching', label,
        page: pagesWalked, pagesTotal: searches.length * maxPages,
        found: byKey.size,
      });

      // A short page is the last page. Naukri serves 20 per page and keeps
      // serving the final one for any higher number, so without this the walk
      // would re-read the same page until MAX_PAGES.
      if (cards.length < CARDS_PER_PAGE) break;

      await jitter(PAGE_DELAY[0], PAGE_DELAY[1]);
    }
  }

  // Every job found by a search is tagged with where it came from, so the
  // inbox can tell them apart and a job found both ways carries both.
  for (const job of byKey.values()) job.origins = ['search'];

  let recommendedFound = 0;
  if (sources.recommended) {
    const rec = await harvestRecommended(page, {
      tabIds: config.sources && config.sources.recommendedTabs, onProgress, found: () => byKey.size,
    });
    recommendedFound = rec.length;
    for (const job of rec) {
      const existing = byKey.get(job.sourceId);
      if (existing) {
        if (!existing.origins.includes('recommended')) existing.origins.push('recommended');
        if (!existing.queries.includes(RECOMMENDED_LABEL)) existing.queries.push(RECOMMENDED_LABEL);
        // The feed's word beats the search card's silence on where Apply goes.
        if (job.companySite) existing.companySite = true;
      } else {
        byKey.set(job.sourceId, { ...job, origins: ['recommended'], queries: [RECOMMENDED_LABEL] });
      }
    }
    // Asked for recommendations and the page gave none: say so, rather than
    // letting a working search walk hide a broken recommended reader.
    if (!rec.length && !searches.length) {
      await page.close().catch(() => {});
      return { jobs: [], searches: 0, recommended: 0, pagesWalked, seen: 0, dropped: 0 };
    }
  }

  await page.close().catch(() => {});

  // Filtering happens HERE, before anything is stored, so a job you filtered out
  // never reaches the review queue and never has to be rejected by hand. The
  // same lib backs the Filters card's "would keep 18 of 47" preview, so what you
  // saw there is what happens.
  const { applyFilters } = require('../../lib/naukriFilters');
  const all = [...byKey.values()];
  const { kept, counts } = applyFilters(all, config.filters || {});

  return {
    jobs: kept, searches: searches.length, recommended: recommendedFound,
    pagesWalked, seen: counts.total, dropped: counts.dropped,
  };
}

module.exports = { harvest, searchUrl, slugify, sourcesOf, fromFeed, MAX_PAGES, MAX_SEARCHES, RECOMMENDED_URL, RECOMMENDED_TABS };
