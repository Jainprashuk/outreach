'use strict';

// Noticing that a job site has stopped believing this is a person — for any
// site. Same doctrine as worker/naukri/guard.js: a challenge is a HARD STOP.
// The worker turns a Checkpoint into exit 2 and the server blocks THAT
// platform for 7 days; restarting the worker cannot shrug it off.
//
// Markers come from the driver's meta (`guardMarkers: { urls, text,
// loginText }`), filled in from the site's RECON.md. Generic challenge words
// are always checked as well, so a site we have not fully mapped still stops
// on an obvious captcha rather than ploughing on.

// Named so platform-worker.js's isCheckpoint() recognises it across modules.
class Checkpoint extends Error {
  constructor(message) { super(message); this.name = 'Checkpoint'; }
}

// Thrown for a step a platform does not support. The server never schedules
// one (lib/platforms.js capabilities), so seeing this means a bug, not a site.
class NotSupported extends Error {
  constructor(message) { super(message); this.name = 'NotSupported'; }
}

const GENERIC_TEXT = [
  'unusual activity', 'verify you are human', 'verify your identity', 'are you a robot',
  "confirm you're not a robot", 'complete the security check', 'too many requests',
  'access denied', 'your account has been blocked', 'account has been suspended',
  'please complete the captcha', 'checking your browser',
];
const GENERIC_URLS = ['/captcha', 'challenges.cloudflare.com', '/cdn-cgi/challenge'];

function makeGuard(meta) {
  const label = meta.label;
  const urls = [...GENERIC_URLS, ...((meta.guardMarkers && meta.guardMarkers.urls) || [])];
  const text = [...GENERIC_TEXT, ...((meta.guardMarkers && meta.guardMarkers.text) || [])];
  const login = (meta.guardMarkers && meta.guardMarkers.loginText) || [];
  const loginUrls = (meta.guardMarkers && meta.guardMarkers.loginUrls) || [];

  // Throws Checkpoint if the page is a challenge or a login wall. One URL read
  // plus one innerText of <body>, after every navigation.
  return async function check(page, where = 'a page') {
    let url = '';
    try { url = page.url() || ''; } catch (_) { return; }

    const hitLogin = loginUrls.find(m => url.includes(m));
    if (hitLogin) {
      throw new Checkpoint(`${label} redirected to its login page (${hitLogin}) while loading ${where}. `
        + `Log in inside the debug Chrome window; ${label} runs are paused for 7 days.`);
    }
    const hit = urls.find(m => url.includes(m));
    if (hit) {
      throw new Checkpoint(`${label} redirected to ${hit} while loading ${where}. Either the session expired or the `
        + `account was challenged. ${label} runs are paused for 7 days; other platforms keep running.`);
    }

    let body = '';
    try { body = (await page.innerText('body', { timeout: 5000 }) || '').toLowerCase(); }
    catch (_) { return; }

    const t = text.find(m => body.includes(m));
    if (t) {
      throw new Checkpoint(`${label} showed "${t}" on ${where}. This is a challenge, not a glitch — ${label} runs are `
        + 'paused for 7 days. Do not restart the worker to get around it.');
    }
    const l = login.find(m => body.includes(m));
    if (l) {
      throw new Checkpoint(`${label} showed the login wall on ${where}. Log in inside the debug Chrome window, then re-run.`);
    }
  };
}

const jitter = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * Math.max(0, max - min)));

module.exports = { Checkpoint, NotSupported, makeGuard, jitter, GENERIC_TEXT, GENERIC_URLS };
