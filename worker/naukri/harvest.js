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

// Hard caps, module constants rather than config — the same doctrine the
// LinkedIn harvester states in TRACK-SCROLL.md. The number of pages you walk is
// a safety property, not a preference.
const MAX_PAGES = 8;
const MAX_SEARCHES = 10;
const PAGE_DELAY = [1800, 4200];   // between page loads, randomised
const CARDS_PER_PAGE = 20;         // Naukri's own page size; used to stop early

const CARD = 'div.srp-jobtuple-wrapper';

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
        alreadyApplied: /\bapplied\b/i.test(card.innerText || ''),
      };
    }).filter(j => j.sourceId && j.title);
  }, CARD);
}

async function harvest(session, { config = {}, onProgress = () => {} } = {}) {
  const searches = (Array.isArray(config.searches) ? config.searches : [])
    .filter(s => s && s.enabled !== false && (s.keywords || s.url))
    .slice(0, MAX_SEARCHES);

  if (!searches.length) {
    throw new Error('No searches configured. Add one in Configuration → Searches before harvesting.');
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

    for (let n = 1; n <= MAX_PAGES; n++) {
      const url = searchUrl({ ...search, jobAge }, n);
      if (!url) break;

      onProgress({
        phase: 'searching', label,
        page: pagesWalked + 1, pagesTotal: searches.length * MAX_PAGES,
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
        page: pagesWalked, pagesTotal: searches.length * MAX_PAGES,
        found: byKey.size,
      });

      // A short page is the last page. Naukri serves 20 per page and keeps
      // serving the final one for any higher number, so without this the walk
      // would re-read the same page until MAX_PAGES.
      if (cards.length < CARDS_PER_PAGE) break;

      await jitter(PAGE_DELAY[0], PAGE_DELAY[1]);
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

  return { jobs: kept, searches: searches.length, pagesWalked, seen: counts.total, dropped: counts.dropped };
}

module.exports = { harvest, searchUrl, slugify, MAX_PAGES, MAX_SEARCHES };
