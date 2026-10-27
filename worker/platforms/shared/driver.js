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
//   apply   — a dry run opens each listing, finds the Apply button and
//             reports what it would click, clicking nothing. A real apply
//             (only once lib/platforms.js capabilities.apply is true for the
//             site) clicks the listing's own Apply button and counts it as
//             applied ONLY when the site answers the one request that is the
//             application (meta.applyFlow.applyRequest) — for this job's id —
//             with success. Anything else is a skip or a failure, never a
//             guess. "Apply to similar jobs too" requests are blocked at the
//             network (applyFlow.blockRequests) and their modals dismissed.
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
// How long past the first 3.5s a listing page may take to deliver its feed.
const FEED_WAIT_MS = 20 * 1000;

const capped = (v, max) => Math.max(1, Math.min(max, Number(v) || max));

function makeDriver(meta) {
  const check = makeGuard(meta);
  const loggedIn = makeLoggedIn(meta);
  const sameSite = (url) => meta.apiHosts.some(h => url.includes(h));
  // A page that means "finish your profile first" (Instahyre's setup wizard).
  // Not a challenge — no block — but nothing can be read until you do it.
  const needsSetup = (page) => {
    let url = '';
    try { url = page.url(); } catch (_) { return; }
    const hit = (meta.setupUrls || []).find(m => url.includes(m));
    if (hit) throw new Error(meta.setupMessage || `${meta.label} sent the page to ${hit} — finish your profile on ${meta.label} first.`);
  };

  // After a navigation: give the page its usual 3.5s, then keep waiting (up to
  // FEED_WAIT_MS) until a feed response has actually arrived. A fixed 3.5s was
  // enough on a laptop, but on a 1-CPU cloud VM Hirist's feed answered after
  // ~10s, so a page with jobs on it was read as empty and the harvest failed
  // with "zero jobs". Once a response lands, a short settle lets the rest of
  // that page's responses in.
  async function waitForFeed(page, feed, since) {
    await page.waitForTimeout(3500);
    const deadline = Date.now() + FEED_WAIT_MS;
    while (feed.lastAt() <= since && Date.now() < deadline) await page.waitForTimeout(500);
    if (feed.lastAt() > since) await page.waitForTimeout(1500);
  }

  // Open `url`, collect the jobs its feed responses carry, scrolling to load
  // more until nothing new arrives twice or the cap is reached.
  // True once any listing's feed actually ANSWERED this harvest, even with an
  // empty list: the site spoke and had nothing, which is not a broken page.
  let feedAnswered = false;

  async function readListing(session, { url, label, origin, maxPages, onProgress, found }) {
    const page = await newPage(session);
    const feed = collectFeed(page, (u) => sameSite(u) && (!meta.feedTest || meta.feedTest(u)), {
      fields: meta.fields, baseUrl: meta.origin, urlFor: meta.jobUrl,
    });
    try {
      await page.bringToFront().catch(() => {});
      // A site with numbered pages (meta.pageUrl): load page 1, 2, 3… as URLs,
      // the way you would click Next, and stop at the first page that adds
      // nothing new.
      if (meta.pageUrl) {
        for (let i = 0; i < maxPages; i++) {
          const before = feed.jobs.size;
          onProgress({ phase: 'searching', label, page: i + 1, pagesTotal: maxPages, found: found() + feed.jobs.size });
          const since = Date.now();
          await page.goto(i === 0 ? url : meta.pageUrl(url, i + 1), { waitUntil: 'domcontentloaded' });
          await waitForFeed(page, feed, since);
          await check(page, label);
          needsSetup(page);
          if (feed.jobs.size === before) break;
          if (i + 1 < maxPages) await jitter(...PAGE_DELAY);
        }
        return [...feed.jobs.values()].map(({ recruiter, ...j }) => ({
          ...j, queries: [label], origins: recruiter ? [origin, 'recruiter'] : [origin],
        }));
      }
      const since = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForFeed(page, feed, since);
      await check(page, label);
      needsSetup(page);
      let idle = 0;
      for (let i = 0; i < maxPages && idle < 2; i++) {
        const before = feed.jobs.size;
        onProgress({ phase: 'searching', label, page: i + 1, pagesTotal: maxPages, found: found() + feed.jobs.size });
        // A site whose pages are a "Next »" link (meta.nextText): click it, wait
        // for that page's feed response. Pagination, nothing else.
        if (meta.nextText) {
          const next = page.getByText(meta.nextText).first();
          if (!(await next.count().catch(() => 0))) break;
          const since = Date.now();
          await next.click({ timeout: 3000 }).catch(() => {});
          await waitForFeed(page, feed, since);
          await check(page, label);
          idle = feed.jobs.size === before ? idle + 1 : 0;
          continue;
        }
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
      if (feed.lastAt() > 0) feedAnswered = true;
      feed.stop();
      await page.close().catch(() => {});
    }
    return [...feed.jobs.values()].map(({ recruiter, ...j }) => ({
      ...j, queries: [label], origins: recruiter ? [origin, 'recruiter'] : [origin],
    }));
  }

  async function harvest(session, { config = {}, onProgress = () => {}, loggedOut = false } = {}) {
    const s = config.sources || {};
    feedAnswered = false;
    // Logged out (a site whose search is public), feeds that need a login are
    // left out: opening one would land on the login wall and the guard would
    // pause the platform for a week over nothing.
    const feeds = meta.feeds.filter(f => !(loggedOut && f.loginOnly));
    const sources = {
      searches: s.searches !== false && !!meta.searchUrl,
      recommended: s.recommended !== false && feeds.length > 0,
    };
    const limits = config.searchLimits || {};
    const maxSearches = capped(limits.maxSearches, MAX_SEARCHES);
    const maxPages = capped(limits.maxPages, MAX_PAGES);
    const searches = !sources.searches ? [] : (config.searches || [])
      .filter(x => x && x.enabled !== false && (x.keywords || x.url)).slice(0, maxSearches);
    if (!searches.length && !sources.recommended) {
      if (loggedOut && meta.feeds.length && s.recommended !== false) {
        throw new Error(`Not logged into ${meta.label}, so ${meta.feeds[0].label} can't be read. Log in inside the debug Chrome window, or add a search (searches work logged out).`);
      }
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
      for (const f of feeds) {
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
    return { jobs: kept, searches: searches.length, recommended, seen: counts.total, dropped: counts.dropped, answeredEmpty: feedAnswered && counts.total === 0 };
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
        for (const r of meta.applications.rowsFrom(body, url)) {
          if (!r || !r.jobId) continue;
          // The same application can appear under two status filters
          // (viewed, then not shortlisted): keep every status seen.
          const id = String(r.jobId);
          const had = rows.get(id);
          const status = statusTimeline(r.statuses, r.at || null);
          rows.set(id, had
            ? { ...had, status: [...had.status, ...status.filter(x => !had.status.some(y => y.statusId === x.statusId))] }
            : { jobId: id, status, isOpen: r.isOpen });
        }
      } catch (_) { /* unreadable response */ }
    };
    page.on('response', onResponse);
    try {
      onProgress({ phase: 'tracking', label: 'Opening my applications', page: 0, pagesTotal: 1, found: 0 });
      await page.goto(meta.applications.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      await check(page, 'your applications');
      // Status filters the page only loads when clicked (Instahyre: Contacted,
      // Not shortlisted). Filter clicks read; they change nothing.
      for (const rx of meta.applications.tabs || []) {
        const tab = page.getByText(rx).first();
        if (await tab.count().catch(() => 0)) {
          await tab.click({ timeout: 5000 }).catch(() => {});
          await jitter(1800, 3000);
          await check(page, 'your applications');
        }
      }
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
    const body = (await page.innerText('body', { timeout: 5000 }).catch(() => '') || '').toLowerCase().replace(/\s+/g, ' ');
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

  // The listing's own Apply button: the exact selector when the site has one
  // (verified per site), else the first visible button with an Apply name.
  async function findApply(page) {
    const a = meta.applyFlow;
    const tries = [];
    if (a.applySelector) tries.push(page.locator(a.applySelector));
    for (const rx of a.applyButtons) tries.push(page.getByRole('button', { name: rx }));
    for (const loc of tries) {
      const n = Math.min(await loc.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    return null;
  }

  // Close whatever the site opens after an application ("apply to 5 more at
  // this company", "are you active?", upsells). Only buttons that close.
  const DISMISS = [/^cancel$/i, /^close$/i, /^not now$/i, /^skip$/i, /^maybe later$/i, /^no,? thanks$/i, /^×$/];
  async function dismissModals(page) {
    for (let round = 0; round < 3; round++) {
      await page.waitForTimeout(1200);
      let clicked = false;
      for (const rx of DISMISS) {
        const btn = page.getByRole('button', { name: rx });
        const n = Math.min(await btn.count().catch(() => 0), 3);
        for (let i = 0; i < n; i++) {
          if (await btn.nth(i).isVisible().catch(() => false)) {
            await btn.nth(i).click({ timeout: 3000 }).catch(() => {});
            clicked = true;
          }
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
      if (!clicked) return;
    }
  }

  // A real mouse click on the centre of the Apply button — and only after
  // checking that the element at that exact point IS the button (or inside
  // it). Playwright's own click refuses Instahyre's, whose <a> wrapper it
  // reads as covering it (verified 2026-10-21), though the button is on top.
  // `state.clicked` is set at the moment the click is sent, not before.
  async function pressButton(page, btn, label, state) {
    await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await btn.boundingBox();
    if (!box) throw new Error(`the "${label || 'Apply'}" button has no position on the page`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const onTop = await btn.evaluate((el, [px, py]) => {
      const hit = document.elementFromPoint(px, py);
      return !!hit && (hit === el || el.contains(hit));
    }, [x, y]);
    if (!onTop) throw new Error(`something covers the "${label || 'Apply'}" button (a pop-up?) — nothing was clicked`);
    state.clicked = true;
    await page.mouse.click(x, y);
  }

  // A site answer that says no, even with HTTP 200.
  const refused = (b) => !!(b && typeof b === 'object' && (b.success === false || b.error
    || (b.status && typeof b.status === 'object' && Number(b.status.code) >= 400)));
  const siteMessage = (b) => (b && typeof b === 'object' && String(b.message || b.error
    || (b.status && typeof b.status === 'object' && b.status.message) || '').slice(0, 160)) || '';

  // One real application. `state.clicked` tells the caller whether the Apply
  // button was pressed, so a crash after the click is never retried blind.
  async function applyOne(page, job, state) {
    const a = meta.applyFlow;
    const want = job.sourceId != null ? String(job.sourceId) : null;
    let detail = null, sent = null, otherJob = null;
    const onResponse = async (res) => {
      try {
        const u = res.url();
        const m = res.request().method();
        if (a.detailTest && a.detailTest(u)) { detail = await res.json().catch(() => null); return; }
        if (!a.applyRequest || !a.applyRequest(u, m)) return;
        let post = null;
        try { post = res.request().postDataJSON(); } catch (_) {}
        const id = a.jobIdOf ? a.jobIdOf(u, post) : null;
        if (want && id && id !== want) { otherJob = id; return; }
        let body = null;
        try { body = await res.json(); } catch (_) {}
        sent = { status: res.status(), ok: res.ok(), body };
      } catch (_) { /* unreadable */ }
    };
    page.on('response', onResponse);
    const popups = [];
    const onPopup = (p) => popups.push(p);
    page.on('popup', onPopup);
    try {
      await page.bringToFront().catch(() => {});
      await page.goto(job.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await check(page, `the listing for "${job.title}"`);
      needsSetup(page);

      // Whitespace folded: "Application sent!\n on October 21" is one phrase.
      const body = (await page.innerText('body', { timeout: 5000 }).catch(() => '') || '').toLowerCase().replace(/\s+/g, ' ');
      if (a.alreadyText.some(t => body.includes(t))) {
        return { outcome: 'skipped', terminal: true, reason: `${meta.label} says you have already applied to this job` };
      }
      if (a.preCheck) {
        for (let i = 0; i < 6 && !detail; i++) await page.waitForTimeout(500);
        const why = detail && a.preCheck(detail);
        if (why) return { outcome: 'skipped', terminal: !/screening test/i.test(why), reason: why };
      }
      for (const rx of a.externalButtons) {
        if (await page.getByRole('button', { name: rx }).first().count().catch(() => 0)
          || await page.getByRole('link', { name: rx }).first().count().catch(() => 0)) {
          return { outcome: 'skipped', terminal: true, reason: 'Applies on the company site — apply there yourself' };
        }
      }
      const btn = await findApply(page);
      if (!btn) return { outcome: 'failed', reason: `No Apply button on the ${meta.label} listing (closed, or the page changed)` };
      const label = (await btn.innerText().catch(() => '')).trim();
      if (a.appliedLabel && a.appliedLabel.test(label)) {
        return { outcome: 'skipped', terminal: true, reason: `${meta.label} says you have already applied to this job` };
      }

      const urlBefore = page.url();
      await pressButton(page, btn, label, state);

      // The site's answer, or where the click took us instead.
      let redirect = null;
      for (let i = 0; i < 30 && !sent && !otherJob; i++) {
        await page.waitForTimeout(500);
        const u = page.url();
        redirect = (a.redirects || []).find(r => u.includes(r.test) && !urlBefore.includes(r.test)) || null;
        if (redirect) break;
      }
      for (const p of popups) await p.close().catch(() => {});

      if (otherJob) {
        // Should be impossible with the exact selector; if it ever happens it
        // must stop the run loudly, not be counted.
        const err = new Error(`${meta.label} sent an application for job ${otherJob}, not ${want} ("${job.title}"). Stopped — check your ${meta.label} applications.`);
        err.fatal = true;
        throw err;
      }
      if (sent) {
        if (sent.ok && !refused(sent.body)) {
          await dismissModals(page);
          const msg = siteMessage(sent.body);
          return { outcome: 'applied', reason: `Applied on ${meta.label}${msg ? ` — "${msg}"` : ''}` };
        }
        return { outcome: 'failed', terminal: true, reason: `${meta.label} refused the application (HTTP ${sent.status})${siteMessage(sent.body) ? `: ${siteMessage(sent.body)}` : ''}` };
      }
      if (redirect) return { outcome: 'skipped', terminal: true, reason: redirect.reason };
      await check(page, `the listing for "${job.title}" after clicking Apply`);
      // No request seen: a form or dialog opened instead. Nothing was sent;
      // it is left to you rather than filled in blind.
      await page.keyboard.press('Escape').catch(() => {});
      return { outcome: 'skipped', terminal: true,
        reason: `${meta.label} asked for more before applying (a form opened after "${label || 'Apply'}"). Nothing was sent — apply on the site yourself.` };
    } finally {
      page.off('response', onResponse);
      page.off('popup', onPopup);
    }
  }

  async function apply(session, { jobs = [], dryRun = false, onProgress = () => {}, onResult = async () => {}, config = {} } = {}) {
    // The server never hands a real apply to a platform whose apply is not
    // proven; this is the second lock on the same door.
    if (dryRun ? !meta.capabilities.dryRun : !meta.capabilities.apply) {
      throw new NotSupported(dryRun
        ? `${meta.label} has no apply step yet.`
        : `Real apply on ${meta.label} is not switched on (lib/platforms.js capabilities.apply). Nothing was sent.`);
    }
    const stats = { applied: 0, skipped: 0, failed: 0, rehearsed: 0 };
    let page = await newPage(session);
    // "Apply to these similar jobs too" never leaves this browser tab.
    const blocks = (meta.applyFlow.blockRequests || []);
    const guardBulkApply = async () => {
      if (blocks.length) await page.route((url) => blocks.some(rx => rx.test(String(url))), (route) => route.abort()).catch(() => {});
    };
    await guardBulkApply();
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        onProgress({ phase: dryRun ? 'rehearsing' : 'applying', label: `${job.title} · ${job.company}`, page: i + 1, pagesTotal: jobs.length, ...stats });
        let result, pageCrashed = false;
        const state = { clicked: false };
        try {
          result = await Promise.race([
            dryRun ? rehearse(page, job) : applyOne(page, job, state),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`did not finish within ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)),
          ]);
        } catch (err) {
          if (err && (err.name === 'Checkpoint' || err.fatal)) throw err;
          const why = String(err && err.message || err).slice(0, 200);
          pageCrashed = /page crashed|target page, context or browser has been closed|browser has been closed/i.test(why);
          result = dryRun
            ? { outcome: 'dry-run', reason: `would have failed: ${why}` }
            // After the click we cannot know whether it went through, so it is
            // never retried automatically (terminal) — check it on the site.
            : { outcome: 'failed', terminal: state.clicked, reason: state.clicked
              ? `Clicked Apply but got no answer from ${meta.label} (${why}) — check the listing before re-approving`
              : why };
        }
        await onResult({ jobId: job.id, ...result });
        if (dryRun) stats.rehearsed++;
        else stats[result.outcome === 'applied' ? 'applied' : result.outcome === 'skipped' ? 'skipped' : 'failed']++;
        if (pageCrashed) {
          const err = new Error(`${meta.label} browser page crashed; stopped this batch after recording the current job. Remaining jobs were not attempted.`);
          err.fatal = true;
          err.stats = { ...stats };
          throw err;
        }
        // A fresh renderer per listing limits memory retained across long apply
        // batches. Session cookies remain in the shared browser context.
        await page.close().catch(() => {});
        if (i + 1 < jobs.length) {
          page = await newPage(session);
          await guardBulkApply();
        }
        const ap = config.apply || {};
        await jitter(Number(ap.delayMinMs) || 2000, Number(ap.delayMaxMs) || 5000);
      }
    } finally {
      await page.close().catch(() => {});
    }
    onProgress({ phase: dryRun ? 'rehearsing' : 'applying', label: 'done', page: jobs.length, pagesTotal: jobs.length, ...stats });
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
