'use strict';

// A browser driver for a job site, built from its `meta` (worker/platforms/<id>/meta.js).
//
// It implements the driver contract (worker/naukri/stub.js: connect,
// disconnect, loggedIn, refresh, harvest, apply, track, Checkpoint) the same
// way the Naukri driver does, read-only first:
//
//   harvest — opens the site's own pages (matched feed, your searches) and
//             reads the job JSON those pages fetch; scrolls only to paginate.
//   track   — opens "my applications" and reads its JSON the same way.
//   apply   — DRY RUN ONLY until the platform's real apply is proven on the
//             live site (lib/platforms.js capabilities.apply). The dry run opens
//             each listing, finds the Apply button and reports what it would
//             click, and clicks nothing. A real apply request throws.
//
// Every navigation is followed by the guard. Hard caps on pages and searches
// are module constants, not settings: the number of pages walked is a safety
// property.

const { connect, disconnect, makeLoggedIn, newPage } = require('./session');
const { Checkpoint, NotSupported, makeGuard, jitter } = require('./guard');
const { collectFeed, statusTimeline } = require('./feed');

const MAX_SEARCHES = 5;
const MAX_PAGES = 5;          // scrolls per page (each fetches the next batch)
const PAGE_DELAY = [2000, 4500];
const JOB_TIMEOUT_MS = 60 * 1000;

const capped = (v, max) => Math.max(1, Math.min(max, Number(v) || max));

function makeDriver(meta) {
  const check = makeGuard(meta);
  const loggedIn = makeLoggedIn(meta);
  const sameSite = (url) => meta.apiHosts.some(h => url.includes(h));

  // Open `url`, collect the jobs its feed responses carry, scrolling to load
  // more until nothing new arrives twice or the cap is reached.
  async function readListing(session, { url, label, origin, maxPages, onProgress, found }) {
    const page = await newPage(session);
    const feed = collectFeed(page, (u) => sameSite(u) && (!meta.feedTest || meta.feedTest(u)), {
      fields: meta.fields, baseUrl: meta.origin, urlFor: meta.jobUrl,
    });
    try {
      await page.bringToFront().catch(() => {});
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      await check(page, label);
      let idle = 0;
      for (let i = 0; i < maxPages && idle < 2; i++) {
        const before = feed.jobs.size;
        onProgress({ phase: 'searching', label, page: i + 1, pagesTotal: maxPages, found: found() + feed.jobs.size });
        await page.mouse.wheel(0, 4000).catch(() => {});
        await jitter(...PAGE_DELAY);
        // A "Load more" / "Show more" button, if the page uses one instead of
        // infinite scroll. Clicking it is pagination, nothing else.
        const more = page.getByRole('button', { name: /^(load|show|view) more/i }).first();
        if (await more.count().catch(() => 0)) await more.click({ timeout: 3000 }).catch(() => {});
        await check(page, label);
        idle = feed.jobs.size === before ? idle + 1 : 0;
      }
    } finally {
      feed.stop();
      await page.close().catch(() => {});
    }
    return [...feed.jobs.values()].map(({ recruiter, ...j }) => ({
      ...j, queries: [label], origins: recruiter ? [origin, 'recruiter'] : [origin],
    }));
  }

  async function harvest(session, { config = {}, onProgress = () => {} } = {}) {
    const s = config.sources || {};
    const sources = {
      searches: s.searches !== false && !!meta.searchUrl,
      recommended: s.recommended !== false && meta.feeds.length > 0,
    };
    const limits = config.searchLimits || {};
    const maxSearches = capped(limits.maxSearches, MAX_SEARCHES);
    const maxPages = capped(limits.maxPages, MAX_PAGES);
    const searches = !sources.searches ? [] : (config.searches || [])
      .filter(x => x && x.enabled !== false && (x.keywords || x.url)).slice(0, maxSearches);
    if (!searches.length && !sources.recommended) {
      throw new Error(meta.feeds.length
        ? `Nothing to harvest on ${meta.label}: add a search, or harvest ${meta.feeds[0].label}.`
        : `No searches configured for ${meta.label}. Add one in Configuration → Searches.`);
    }

    const byId = new Map();
    const add = (list) => {
      for (const j of list) {
        const had = byId.get(j.sourceId);
        if (had) {
          had.queries = [...new Set([...had.queries, ...j.queries])];
          had.origins = [...new Set([...had.origins, ...j.origins])];
        } else byId.set(j.sourceId, j);
      }
    };
    let recommended = 0;

    if (sources.recommended) {
      for (const f of meta.feeds) {
        const got = await readListing(session, { url: f.url, label: f.label, origin: f.origin || 'recommended', maxPages, onProgress, found: () => byId.size });
        recommended += got.length;
        add(got);
        await jitter(...PAGE_DELAY);
      }
    }
    for (const search of searches) {
      const label = search.label || search.keywords || search.url;
      const url = search.url || meta.searchUrl(search);
      add(await readListing(session, { url, label, origin: 'search', maxPages, onProgress, found: () => byId.size }));
      await jitter(...PAGE_DELAY);
    }

    // Filtered here, before anything is stored — same as Naukri.
    const { applyFilters } = require('../../../lib/naukriFilters');
    const all = [...byId.values()];
    const { kept, counts } = applyFilters(all, config.filters || {});
    return { jobs: kept, searches: searches.length, recommended, seen: counts.total, dropped: counts.dropped };
  }

  async function track(session, { onProgress = () => {} } = {}) {
    if (!meta.applications) throw new NotSupported(`${meta.label} has no check replies step`);
    const page = await newPage(session);
    const rows = new Map();
    const onResponse = async (res) => {
      try {
        const url = res.url();
        if (!sameSite(url) || (meta.applications.test && !meta.applications.test(url))) return;
        if (!/json/i.test(res.headers()['content-type'] || '')) return;
        const body = await res.json();
        for (const r of meta.applications.rowsFrom(body)) {
          if (r && r.jobId) rows.set(String(r.jobId), { jobId: String(r.jobId), status: statusTimeline(r.statuses, r.at || null), isOpen: r.isOpen });
        }
      } catch (_) { /* unreadable response */ }
    };
    page.on('response', onResponse);
    try {
      onProgress({ phase: 'tracking', label: 'Opening my applications', page: 0, pagesTotal: 1, found: 0 });
      await page.goto(meta.applications.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      await check(page, 'your applications');
      let idle = 0;
      for (let i = 0; i < 15 && idle < 2; i++) {
        const before = rows.size;
        await page.mouse.wheel(0, 3000).catch(() => {});
        await jitter(1500, 2500);
        idle = rows.size === before ? idle + 1 : 0;
        onProgress({ phase: 'tracking', label: 'Reading application statuses', page: i + 1, pagesTotal: 15, found: rows.size });
      }
      await check(page, 'your applications');
    } finally {
      page.off('response', onResponse);
      await page.close().catch(() => {});
    }
    return { rows: [...rows.values()], expected: null, sawFeed: rows.size > 0 };
  }

  // Dry run: look, report, click nothing.
  async function rehearse(page, job) {
    await page.bringToFront().catch(() => {});
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await check(page, `the listing for "${job.title}"`);
    const body = (await page.innerText('body', { timeout: 5000 }).catch(() => '') || '').toLowerCase();
    const a = meta.applyFlow;
    if (a.alreadyText.some(t => body.includes(t))) return { outcome: 'dry-run', reason: `would have skipped: ${meta.label} says you have already applied` };
    for (const rx of a.externalButtons) {
      if (await page.getByRole('button', { name: rx }).first().count().catch(() => 0)
        || await page.getByRole('link', { name: rx }).first().count().catch(() => 0)) {
        return { outcome: 'dry-run', reason: 'would have skipped: applies on the company site' };
      }
    }
    for (const rx of a.applyButtons) {
      const btn = page.getByRole('button', { name: rx }).first();
      if (await btn.count().catch(() => 0)) {
        const text = (await btn.innerText().catch(() => '')).trim();
        return { outcome: 'dry-run', reason: `Would have clicked "${text || rx.source}" (stopped here — nothing was sent)` };
      }
    }
    return { outcome: 'dry-run', reason: 'would have failed: no Apply button found on the listing' };
  }

  async function apply(session, { jobs = [], dryRun = false, onProgress = () => {}, onResult = async () => {}, config = {} } = {}) {
    // The server never hands a real apply to a platform whose apply is not
    // proven; this is the second lock on the same door.
    if (!dryRun || !meta.capabilities.dryRun) {
      throw new NotSupported(`Real apply on ${meta.label} is not built yet — only a dry run is. Nothing was sent.`);
    }
    const stats = { applied: 0, skipped: 0, failed: 0, rehearsed: 0 };
    const page = await newPage(session);
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        onProgress({ phase: 'rehearsing', label: `${job.title} · ${job.company}`, page: i + 1, pagesTotal: jobs.length, ...stats });
        let result;
        try {
          result = await Promise.race([
            rehearse(page, job),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`did not finish within ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)),
          ]);
        } catch (err) {
          if (err && err.name === 'Checkpoint') throw err;
          result = { outcome: 'dry-run', reason: `would have failed: ${String(err.message).slice(0, 200)}` };
        }
        await onResult({ jobId: job.id, ...result });
        stats.rehearsed++;
        const ap = config.apply || {};
        await jitter(Number(ap.delayMinMs) || 2000, Number(ap.delayMaxMs) || 5000);
      }
    } finally {
      await page.close().catch(() => {});
    }
    onProgress({ phase: 'rehearsing', label: 'done', page: jobs.length, pagesTotal: jobs.length, ...stats });
    return stats;
  }

  async function refresh() {
    throw new NotSupported(`${meta.label} has no refresh profile step`);
  }

  const emptyHarvestHint = (config) => `Zero jobs read from ${meta.label}. Either the Chrome window was not visible `
    + '(dark wake / minimised), the page changed, or its feed URL differs from worker/platforms/'
    + `${meta.id}/meta.js — open ${meta.feeds[0] ? meta.feeds[0].url : meta.origin} in the debug Chrome, check DevTools → `
    + `Network, and update RECON.md. Do not retry blindly.${config && config.sources && config.sources.searches !== false && !(config.searches || []).length ? ' (You also have no searches set.)' : ''}`;

  return {
    meta, connect, disconnect, loggedIn, refresh, harvest, apply, track, Checkpoint, NotSupported,
    emptyHarvestHint, JOB_TIMEOUT_MS, JOB_TIMEOUT_AI_MS: JOB_TIMEOUT_MS,
  };
}

module.exports = { makeDriver, MAX_SEARCHES, MAX_PAGES };
