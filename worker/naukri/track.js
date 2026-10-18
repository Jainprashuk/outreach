'use strict';

// Reading what recruiters did with your applications — read-only.
//
// Verified against the live site on 2026-10-18. The "My applies" page
// (/myapply/historypage) loads its rows from
//   GET /cloudgateway-apply/whtma-services/v0/applyapi/v5/history?pageSize=10&days=90&filterInfo=2&pageNumber=N
// and its "Recruiter Actions" tab adds &filterBy=1 — the applications a
// recruiter has done something with (viewed, shortlisted, contacted, not
// shortlisted). Each row carries the Naukri job id and a status timeline.
//
// Like Recommended jobs, nothing is requested by hand: the page makes these
// calls itself and we read the responses. The tab is clicked and the list
// scrolled (which is how the page fetches its next 10), never anything else.

const { check, jitter } = require('./guard');
const { newPage } = require('./session');

const HISTORY_URL = 'https://www.naukri.com/myapply/historypage';
const HISTORY_FEED = /\/applyapi\/v\d+\/history\?/;
const MAX_SCROLLS = 30;          // 10 rows a page; 300 recruiter actions is plenty

async function track(session, { onProgress = () => {} } = {}) {
  const page = await newPage(session);
  const byId = new Map();
  let expected = null;           // how many recruiter actions Naukri says there are
  let lastFeedAt = 0;

  const onResponse = async (res) => {
    const url = res.url();
    if (!HISTORY_FEED.test(url) || !/filterBy=1/.test(url)) return;
    try {
      const body = await res.json();
      lastFeedAt = Date.now();
      if (body.recruiterActivityOnApplication != null) expected = Number(body.recruiterActivityOnApplication);
      for (const row of body.applyDetails || []) {
        if (row && row.jobId) byId.set(String(row.jobId), { jobId: String(row.jobId), status: row.status || [], isOpen: row.isOpen });
      }
    } catch (_) { /* a response we cannot read adds nothing */ }
  };
  page.on('response', onResponse);

  try {
    onProgress({ phase: 'tracking', label: 'Opening My applies', page: 0, pagesTotal: 1, found: 0 });
    await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await check(page, 'your applications');

    // The Recruiter Actions tab, found by its visible text.
    const tab = page.getByText(/Recruiter Actions/).first();
    if (!await tab.count().catch(() => 0)) {
      throw new Error('The "Recruiter Actions" tab was not on My applies — Naukri changed the page. Fix worker/naukri/track.js.');
    }
    const first = page.waitForResponse(r => HISTORY_FEED.test(r.url()) && /filterBy=1/.test(r.url()), { timeout: 20000 }).catch(() => null);
    await tab.click();
    if (!await first) {
      throw new Error('My applies did not load its recruiter-actions list — Naukri changed the page. Fix HISTORY_FEED in worker/naukri/track.js.');
    }
    await page.waitForTimeout(800);
    await check(page, 'your applications');

    // Scroll for the next pages until we have them all, or scrolling brings
    // nothing new twice in a row.
    let idle = 0;
    for (let i = 0; i < MAX_SCROLLS && idle < 2; i++) {
      if (expected != null && byId.size >= expected) break;
      const before = byId.size;
      await page.mouse.wheel(0, 3000).catch(() => {});
      await jitter(1500, 2500);
      idle = byId.size === before ? idle + 1 : 0;
      onProgress({ phase: 'tracking', label: 'Reading recruiter actions', page: i + 1, pagesTotal: MAX_SCROLLS, found: byId.size });
    }
    await check(page, 'your applications');
  } finally {
    page.off('response', onResponse);
    await page.close().catch(() => {});
  }

  return { rows: [...byId.values()], expected, sawFeed: lastFeedAt > 0 };
}

module.exports = { track, HISTORY_URL };
