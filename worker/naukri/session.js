'use strict';

// Attaching to the Chrome you are already logged into.
//
// connect_over_cdp, never launch. Playwright's own bundled Chromium would be a
// fresh profile with automation flags and navigator.webdriver === true — a
// browser Naukri has every reason to challenge. The browser we attach to is the
// one from chrome-debug.sh: real Chrome, real profile, real fingerprint, with
// your session cookie already in it. That is the whole anti-detection story, and
// it is why no Naukri password is stored anywhere in this repo.

const { chromium } = require('playwright-core');

// 127.0.0.1 rather than localhost: Chrome binds the debug port on IPv4 only,
// and on a machine where localhost resolves to ::1 first the connection is
// refused. chrome-debug.sh documents the same thing.
const cdpUrl = (port) => `http://127.0.0.1:${port}`;

// Naukri's session cookies. `nauk_at` is the one that actually marks a logged-in
// session; the others come and go across their redesigns, so any of them being
// present is treated as "logged in" and the guard catches a stale session when a
// page turns out to be the login wall anyway.
const SESSION_COOKIES = ['nauk_at', 'NKAT', 'ninfo', 'nauk_uid'];

// 45s, not the 10s that looks sufficient in a quiet test. connectOverCDP
// enumerates every target in the browser before it resolves, and this is your
// everyday Chrome — a window with thirty tabs, each a target, takes real time to
// walk. A timeout here fails a run that would have worked, which is the most
// annoying possible failure: nothing is wrong and retrying "fixes" it.
const CONNECT_TIMEOUT_MS = 45000;

async function connect({ cdpPort = 9222 } = {}) {
  const browser = await chromium.connectOverCDP(cdpUrl(cdpPort), { timeout: CONNECT_TIMEOUT_MS });

  const contexts = browser.contexts();
  if (!contexts.length) {
    await browser.close().catch(() => {});
    throw new Error('Chrome is running but has no browser context open. Open a window and try again.');
  }

  // contexts[0] is the real profile's context — the one holding your cookies.
  // Creating a new context would give us a clean, logged-out jar.
  return { browser, context: contexts[0], pages: [] };
}

async function disconnect(session) {
  if (!session) return;
  // Close only the pages WE opened. The browser itself, and whatever tabs you
  // had open in it, must survive: this is your everyday Chrome, not a throwaway.
  for (const page of session.pages) {
    await page.close().catch(() => {});
  }
  session.pages = [];
  // Detaches the CDP client without killing Chrome.
  await session.browser.close().catch(() => {});
}

// Read-only: the cookie jar, never a navigation. Asking by loading a page would
// itself be traffic, and a redirect to the login wall is exactly the state we
// are trying to detect without provoking it.
//
// Confirmed rather than sampled once. "Logged out" ends the run and tells you to
// go and log in, so a single empty read is too thin a basis for it — and an
// empty read does happen transiently when something else attaches to the same
// browser mid-call. A false negative here sends you to Chrome to fix a session
// that was never broken, which is worse than waiting a second.
async function loggedIn(session) {
  const has = async () => {
    const cookies = await session.context.cookies('https://www.naukri.com').catch(() => []);
    return cookies.some(c => SESSION_COOKIES.includes(c.name) && c.value);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await has()) return true;
    if (attempt < 2) await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

// Every page the driver opens comes from here, so each one is tracked for
// cleanup and carries the same timeout. Naukri is a heavy, ad-laden SPA; the
// default 30s is not generous enough on a cold profile.
async function newPage(session) {
  const page = await session.context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  session.pages.push(page);
  return page;
}

module.exports = { connect, disconnect, loggedIn, newPage, SESSION_COOKIES };
