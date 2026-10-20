'use strict';

// Attaching to the Chrome you are already logged into — for any job site.
//
// The same rules as worker/naukri/session.js, which this generalises: attach
// over CDP, never launch; use the real profile's context (contexts[0]); close
// only the pages we opened. The only thing that differs per site is which
// cookies mean "logged in", and that comes from the driver's meta.
//
// Naukri keeps its own session.js (unchanged); this one is for the platforms
// added after it.

const { chromium } = require('playwright-core');

const cdpUrl = (port) => `http://127.0.0.1:${port}`;
// Same reasoning as Naukri's: connectOverCDP walks every target in your
// everyday Chrome before it resolves.
const CONNECT_TIMEOUT_MS = 45000;

async function connect({ cdpPort = 9222 } = {}) {
  const browser = await chromium.connectOverCDP(cdpUrl(cdpPort), { timeout: CONNECT_TIMEOUT_MS });
  const contexts = browser.contexts();
  if (!contexts.length) {
    await browser.close().catch(() => {});
    throw new Error('Chrome is running but has no browser context open. Open a window and try again.');
  }
  return { browser, context: contexts[0], pages: [] };
}

async function disconnect(session) {
  if (!session) return;
  for (const page of session.pages || []) await page.close().catch(() => {});
  session.pages = [];
  if (session.browser) await session.browser.close().catch(() => {});
}

// "Logged in" from the cookie jar alone — never a navigation. `meta.cookieUrls`
// are the site origins to read; `meta.sessionCookies` the names that mark a
// session (any one present, with a value). Confirmed over three reads, like
// Naukri's, because a transient empty read sends you to fix a session that was
// never broken. A stale cookie is still caught: the guard sees the login wall
// on the first page load.
function makeLoggedIn(meta) {
  return async function loggedIn(session) {
    const has = async () => {
      for (const url of meta.cookieUrls) {
        const cookies = await session.context.cookies(url).catch(() => []);
        if (cookies.some(c => meta.sessionCookies.includes(c.name) && c.value)) return true;
      }
      return false;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await has()) return true;
      if (attempt < 2) await new Promise(r => setTimeout(r, 600));
    }
    return false;
  };
}

async function newPage(session) {
  const page = await session.context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  session.pages.push(page);
  return page;
}

module.exports = { connect, disconnect, makeLoggedIn, newPage };
