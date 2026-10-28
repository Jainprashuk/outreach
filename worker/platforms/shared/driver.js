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
const { resolveAnswer, pickOption } = require('../../../lib/naukriAnswers');

const MAX_SEARCHES = 5;
const MAX_PAGES = 5;          // scrolls per page (each fetches the next batch)
const PAGE_DELAY = [2000, 4500];
const JOB_TIMEOUT_MS = 60 * 1000;
const JOB_TIMEOUT_AI_MS = 150 * 1000;
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
    const feed = collectFeed(page, (u, req) => sameSite(u) && (!meta.feedTest || meta.feedTest(u, req)), {
      fields: meta.fields, baseUrl: meta.origin, urlFor: meta.jobUrl,
      prepare: meta.prepare, rawJobs: meta.jobsFromBody,
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
        // A list that scrolls inside its own panel (Cutshort) only moves when the
        // pointer is over it, so rest the pointer there first, like a person.
        if (meta.scrollOverList) {
          const at = await page.evaluate(() => {
            const el = [...document.querySelectorAll('div')].find(e => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY));
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }).catch(() => null);
          if (at) await page.mouse.move(at.x, at.y).catch(() => {});
        }
        await page.mouse.wheel(0, meta.scrollOverList ? 1500 : 4000).catch(() => {});
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

  // Where a job is applied for. Usually its own listing page; a site whose
  // public page only hands you on to an in-app view (Cutshort) says so.
  const listingOf = (job) => (meta.applyFlow.listingUrl ? meta.applyFlow.listingUrl(job) : job.url);

  // Dry run: look, report, click nothing.
  async function rehearse(page, job) {
    await page.bringToFront().catch(() => {});
    await page.goto(listingOf(job), { waitUntil: 'domcontentloaded' });
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
    || (Array.isArray(b.errors) && b.errors.length)
    || (b.status && typeof b.status === 'object' && Number(b.status.code) >= 400)));
  // Only text counts: some sites answer { message: { …the new record… } }.
  const siteMessage = (b) => {
    if (!b || typeof b !== 'object') return '';
    const t = [b.message, b.error, b.status && typeof b.status === 'object' && b.status.message].find(x => typeof x === 'string' && x);
    return t ? t.slice(0, 160) : '';
  };

  // One real application. `state.clicked` tells the caller whether the Apply
  // button was pressed, so a crash after the click is never retried blind.

  // A site's own "tell the recruiter more" form (Hirist: /job/<id>/screening),
  // the counterpart of Naukri's questionnaire drawer. Same answer sources, in
  // the same order: what the site pre-filled from your profile is kept, then a
  // saved answer rule, then (auto-answer on) the AI. A MANDATORY question none
  // of them answers skips the job with the question reported, so it can become
  // a rule under Needs answer; an optional one is left blank.
  //   Returns null when the form was filled and submitted, else a result.
  async function fillScreening(page, job, { config, askAI, askNote, mandatory }) {
    const sc = meta.applyFlow.screening;
    const asked = [];
    const written = [];
    for (let round = 0; round < (sc.maxSteps || 3); round++) {
      const boxes = page.locator(sc.questionBox);
      try { await boxes.first().waitFor({ state: 'visible', timeout: round ? 8000 : 15000 }); }
      catch (_) {
        // A modal that only asks "Send application?" has no questions at all.
        const bare = sc.inline && await page.locator(sc.submit).first().isVisible().catch(() => false);
        if (!bare) return round ? null : { outcome: 'failed', terminal: false, reason: `${meta.label} opened its form but no questions appeared` };
      }
      await page.waitForTimeout(1500);
      const n = await boxes.count();
      for (let i = 0; i < n; i++) {
        const box = boxes.nth(i);
        const question = ((await box.locator(sc.questionText).first().innerText().catch(() => '')) || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        if (!question) continue;
        const pills = box.locator(sc.option);
        const nPills = await pills.count().catch(() => 0);
        const labels = [];
        for (let k = 0; k < nPills; k++) labels.push(((await pills.nth(k).innerText().catch(() => '')) || '').trim());
        const field = box.locator(sc.input).first();
        const hasField = await field.count().catch(() => 0) > 0;
        const choices = box.locator(sc.choice);
        const nChoices = nPills ? 0 : await choices.count().catch(() => 0);
        const hasSelect = !nPills && !hasField && await box.locator('select').count().catch(() => 0) > 0;
        if (!nPills && !hasField && !nChoices && !hasSelect) {
          // A control type nobody has recorded yet. Say what it is instead of
          // guessing: the markup goes in the reason so the next fix is exact.
          const html = ((await box.innerHTML().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 500);
          return { outcome: 'skipped', reason: `Unrecognised ${meta.label} form question "${question.slice(0, 80)}" — nothing was sent. Markup: ${html}`, question, options: [] };
        }
        const choiceLabels = [];
        for (let k = 0; k < nChoices; k++) choiceLabels.push(((await choices.nth(k).innerText().catch(() => '')) || '').trim());
        if (hasSelect) {
          for (const o of await box.locator('select option').allInnerTexts().catch(() => [])) if (o.trim() && !/^select|^choose/i.test(o.trim())) choiceLabels.push(o.trim());
        }
        if (choiceLabels.length && !labels.length) labels.push(...choiceLabels);
        const isMandatory = mandatory.has(question.toLowerCase())
          || (sc.mandatory ? await box.locator(sc.mandatory).count().catch(() => 0) > 0 : false);

        // Already filled from your Hirist profile → keep it.
        let have = '';
        if (nPills) {
          for (let k = 0; k < nPills; k++) if (/\bselected\b/.test(await pills.nth(k).getAttribute('class').catch(() => '') || '')) have = labels[k];
        } else if (hasField) have = (await field.inputValue().catch(() => '')) || '';
        else if (hasSelect) have = (await box.locator('select').first().inputValue().catch(() => '')) || '';
        else if (nChoices) {
          for (let k = 0; k < nChoices; k++) if (await choices.nth(k).locator('input').first().isChecked().catch(() => false)) have = choiceLabels[k];
        }
        if (have) { asked.push({ question, prefilled: true }); continue; }

        const resolved = resolveAnswer(question, config);
        let value = null, ai = null;
        if (resolved.matched) value = String(resolved.answer);
        else if (sc.aiNote && askNote && hasField && (await field.getAttribute('type').catch(() => '')) !== 'number') {
          // An open question: written for THIS job from your resume and its own
          // text, never saved as a reusable rule. Declined (the resume does not
          // say) is a decision; anything else is a failure and nothing is sent.
          const n = await askNote(job, { kind: 'question', question });
          if (n && n.text) { value = n.text; written.push(question); }
          else if (!(n && n.declined)) {
            return { outcome: 'failed', terminal: false, reason: `Could not write an answer to "${question.slice(0, 80)}" (${(n && n.reason) || 'AI unavailable'}) — nothing was sent` };
          }
        }
        else if (askAI && config.autoAnswer && config.autoAnswer.enabled) {
          const live = await askAI(question, labels).catch(() => null);
          if (live && live.answer) {
            value = String(live.answer); ai = live.confidence || null;
            if (live.rule) config.answers = [live.rule, ...(config.answers || [])];
          }
        }
        if (value == null) {
          if (isMandatory) return { outcome: 'skipped', reason: 'Unanswered screening question — answer it under Jobs → Needs answer', question, options: labels };
          continue;
        }
        if (nPills) {
          const chosen = pickOption(value, labels);
          if (!chosen) {
            if (isMandatory) return { outcome: 'skipped', reason: 'Unanswered screening question — answer it under Jobs → Needs answer', question, options: labels };
            continue;
          }
          await pills.nth(labels.indexOf(chosen)).click();
        } else if (nChoices || hasSelect) {
          const chosen = pickOption(value, choiceLabels);
          if (!chosen) {
            if (isMandatory) return { outcome: 'skipped', reason: 'Unanswered screening question — answer it under Jobs → Needs answer', question, options: choiceLabels };
            continue;
          }
          if (hasSelect) await box.locator('select').first().selectOption({ label: chosen }, { timeout: 5000 });
          else await choices.nth(choiceLabels.indexOf(chosen)).click({ timeout: 5000 });
        } else {
          const isNumber = (await field.getAttribute('type').catch(() => '')) === 'number';
          const typed = isNumber ? ((/\d+(\.\d+)?/.exec(value) || [])[0] || '') : value;
          if (!typed) {
            if (isMandatory) return { outcome: 'skipped', reason: 'Unanswered screening question — answer it under Jobs → Needs answer', question, options: labels };
            continue;
          }
          await field.click({ timeout: 5000 });
          await field.fill('').catch(() => {});
          await field.type(typed, { delay: 15 });
        }
        asked.push({ question, ai });
        await jitter(300, 700);
      }
      const next = page.locator(sc.submit).first();
      if (!(await next.count().catch(() => 0))) {
        const seen = await page.evaluate(() => [...document.querySelectorAll('button, [role=button]')].filter(b => b.offsetParent).map(b => `"${(b.innerText || '').trim().slice(0, 25)}"`).slice(0, 8)).catch(() => []);
        return { outcome: 'failed', terminal: true, reason: `${meta.label} form has no submit button (${page.url().slice(0, 90)} · buttons: ${seen.join(', ') || 'none'}) — after ${asked.length} question(s); check the listing before re-approving` };
      }
      if (await next.isDisabled().catch(() => false)) {
        return { outcome: 'skipped', reason: `${meta.label} will not let the form go on (its "${(await next.innerText().catch(() => '') || 'Next').trim()}" button stays disabled) — a required question has no answer. Answer it on ${meta.label} or under Jobs → Needs answer.` };
      }
      const before = page.url();
      await next.click();
      await page.waitForTimeout(3000);
      // A second step shows more questions on the same page; otherwise done.
      if (!(await page.locator(sc.questionBox).first().isVisible().catch(() => false)) && page.url() === before) break;
      if (page.url() !== before && !page.url().includes(sc.urlTest)) break;
    }
    job._screened = asked;
    job._written = written.length;
    return null;
  }

  async function applyOne(page, job, state, { config = {}, askAI = null, askNote = null } = {}) {
    const a = meta.applyFlow;
    const want = job.sourceId != null ? String(job.sourceId) : null;
    let detail = null, sent = null, otherJob = null;
    const mandatory = new Set();
    const onResponse = async (res) => {
      try {
        const u = res.url();
        const m = res.request().method();
        let post = null;
        try { post = res.request().postDataJSON(); } catch (_) {}
        if (a.detailTest && a.detailTest(u, res.request())) { detail = await res.json().catch(() => null); return; }
        if (a.screening && a.screening.questionnaireTest(u, res.request())) {
          const j = await res.json().catch(() => null);
          // A site says which questions are required (Wellfound), or the Hirist shape.
          if (a.screening.mandatoryFrom) {
            for (const q of a.screening.mandatoryFrom(j) || []) mandatory.add(String(q || '').replace(/\s+/g, ' ').trim().toLowerCase());
          } else {
            for (const sec of (j && j.data && j.data[0] && j.data[0].sections) || [])
              for (const q of sec.detailedQuestions || []) if (q.mandatory) mandatory.add(String(q.question || '').replace(/\s+/g, ' ').trim().toLowerCase());
          }
          return;
        }
        if (!a.applyRequest || !a.applyRequest(u, m, post)) return;
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
      await page.goto(listingOf(job), { waitUntil: 'domcontentloaded' });
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
      // A site that asks "Send?" in a dialog (Cutshort): nothing has been sent
      // until that second button, so the click above is not yet an application.
      if (a.confirm) {
        state.clicked = false;
        const dlg = page.locator(a.confirm.dialog).first();
        try { await dlg.waitFor({ state: 'visible', timeout: 10000 }); }
        catch (_) { return { outcome: 'failed', reason: `${meta.label} did not open its confirm dialog after "${label || 'Apply'}" — nothing was sent` }; }
        await page.waitForTimeout(800);
        // The site says there is nothing to send because you already applied.
        const said = ((await dlg.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
        if (a.confirm.already && a.confirm.already.test(said)) {
          await page.keyboard.press('Escape').catch(() => {});
          return { outcome: 'skipped', terminal: true, reason: `${meta.label} says you have already applied to this job` };
        }
        // Side effects the dialog would add (Cutshort pre-ticks "Follow <company>").
        if (a.confirm.untick) {
          const box = dlg.locator(a.confirm.untick).first();
          if (await box.count().catch(() => 0)) await box.click({ timeout: 3000 }).catch(() => {});
        }
        // The message box: written for this job, never sent empty. The dialog
        // stays open while it is written; a failure closes it and sends nothing.
        if (a.confirm.message) {
          const box = dlg.locator(a.confirm.message.selector).first();
          if (await box.count().catch(() => 0)) {
            const n = askNote ? await askNote(job, { kind: 'message', maxChars: a.confirm.message.maxChars }) : null;
            if (!n || !n.text) {
              await page.keyboard.press('Escape').catch(() => {});
              return { outcome: 'failed', terminal: false, reason: `No application message could be written (${(n && n.reason) || 'AI unavailable'}) — nothing was sent` };
            }
            await box.fill(n.text);
            job._message = n.text;
            if ((await box.inputValue().catch(() => '')) !== n.text) {
              await page.keyboard.press('Escape').catch(() => {});
              return { outcome: 'failed', terminal: false, reason: `${meta.label}'s message box did not take the text — nothing was sent` };
            }
          }
        }
        const send = dlg.getByRole('button', { name: a.confirm.button }).first();
        if (!(await send.count().catch(() => 0))) return { outcome: 'failed', reason: `${meta.label}'s confirm dialog has no "${a.confirm.button.source}" button — nothing was sent` };
        await pressButton(page, send, 'Send', state);
      }

      // The site's answer, or where the click took us instead.
      let redirect = null, screeningHit = false;
      for (let i = 0; i < 30 && !sent && !otherJob; i++) {
        await page.waitForTimeout(500);
        const u = page.url();
        if (a.screening && a.screening.urlTest && u.includes(a.screening.urlTest) && !urlBefore.includes(a.screening.urlTest)) { screeningHit = true; break; }
        // A form in a modal on the same page (Wellfound): recognised by its submit button.
        if (a.screening && a.screening.inline && await page.locator(a.screening.submit).first().isVisible().catch(() => false)) { screeningHit = true; break; }
        redirect = (a.redirects || []).find(r => u.includes(r.test) && !urlBefore.includes(r.test)) || null;
        if (redirect) break;
      }
      if (screeningHit) {
        const out = await fillScreening(page, job, { config, askAI, askNote, mandatory });
        if (out) return out;
        // The form is in; the application itself is still only counted on the
        // site's own answer to the apply request.
        for (let i = 0; i < 30 && !sent && !otherJob; i++) await page.waitForTimeout(500);
        if (!sent && !otherJob) {
          return { outcome: 'failed', terminal: true, reason: `Filled and submitted the ${meta.label} form (${(job._screened || []).length} question(s)) but ${meta.label} never confirmed the application — check the listing before re-approving` };
        }
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
          const sc = job._screened || [];
          const byAI = sc.filter(x => x.ai);
          const note = sc.length ? ` after ${sc.length} form question(s)${byAI.length ? ` · ${byAI.length} answered by AI (${byAI.map(x => `${x.ai}%`).join(', ')})` : ''}` : '';
          const wrote = job._message ? ' · with an AI-written message' : job._written ? ` · ${job._written} open answer(s) written by AI` : '';
          return { outcome: 'applied', reason: `Applied on ${meta.label}${note}${wrote}${msg ? ` — "${msg}"` : ''}` };
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

  async function apply(session, { jobs = [], dryRun = false, onProgress = () => {}, onResult = async () => {}, config = {}, askAI = null, askNote = null } = {}) {
    // Writing the message takes an AI call or two on top of the page.
    const jobTimeout = askNote ? JOB_TIMEOUT_AI_MS : JOB_TIMEOUT_MS;
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
            dryRun ? rehearse(page, job) : applyOne(page, job, state, { config, askAI, askNote }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`did not finish within ${jobTimeout / 1000}s`)), jobTimeout)),
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
    emptyHarvestHint, JOB_TIMEOUT_MS, JOB_TIMEOUT_AI_MS,
  };
}

module.exports = { makeDriver, MAX_SEARCHES, MAX_PAGES };
