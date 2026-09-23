'use strict';

// Noticing that Naukri has stopped believing this is a person.
//
// Modelled on _guard() in the LinkedIn harvester (scroll_harvest.py), and it
// carries the same doctrine: a challenge is a hard stop, not a thing to retry.
// Retrying a captcha is how a warned account becomes a restricted one. The
// worker turns a Checkpoint into exit code 2, and the SERVER turns that into a
// 7-day block — deliberately not the worker, so that restarting the process
// cannot shrug it off.
//
// Every navigation in this driver is followed by a check(). That is the point:
// the challenge can appear at any step, and the cheapest moment to stop is
// before the next click.

// Named so naukri-worker.js's isCheckpoint() recognises it across the require
// boundary; instanceof would be fragile if this module were ever duplicated.
class Checkpoint extends Error {
  constructor(message) { super(message); this.name = 'Checkpoint'; }
}

// A URL that means we are no longer in an authenticated session. Being bounced
// to the login page mid-run is either an expired cookie or a soft block; both
// need a human, and neither is fixed by trying again.
const URL_MARKERS = [
  '/nlogin/login',
  '/mnjuser/login',
  '/registration/createaccount',
  '/wapi/captcha',
  '/unusual-activity',
];

// Text that means a challenge is on screen. Lowercased substring match against
// the body, because the markup around these strings changes far more often than
// the strings themselves do.
const TEXT_MARKERS = [
  'unusual activity',
  'verify your identity',
  'are you a robot',
  "confirm you're not a robot",
  'complete the security check',
  'too many requests',
  'access denied',
  'your account has been blocked',
];

// A login wall reached from a page we expected to be authenticated.
const LOGIN_TEXT = ['login to your account', 'sign in to continue', 'login id / password'];

// Throws Checkpoint if the page is a challenge. Cheap enough to call after every
// navigation: one URL read plus one innerText of <body>.
async function check(page, where = 'a page') {
  let url = '';
  try { url = page.url() || ''; } catch (_) { return; }

  const hit = URL_MARKERS.find(m => url.includes(m));
  if (hit) {
    throw new Checkpoint(
      `Naukri redirected to ${hit} while loading ${where}. Either the session expired or the account `
      + 'was challenged. Log in inside the debug Chrome window; everything is paused for 7 days.'
    );
  }

  let body = '';
  try {
    body = (await page.innerText('body', { timeout: 5000 }) || '').toLowerCase();
  } catch (_) {
    // A body we cannot read is not evidence of a challenge — it is usually a
    // navigation in flight. The next check() call will see it.
    return;
  }

  const text = TEXT_MARKERS.find(m => body.includes(m));
  if (text) {
    throw new Checkpoint(
      `Naukri showed "${text}" on ${where}. This is a challenge, not a glitch — everything is paused `
      + 'for 7 days. Do not restart the worker to get around it.'
    );
  }

  // Only meaningful when we believed we were authenticated, which is every page
  // this driver opens.
  const login = LOGIN_TEXT.find(m => body.includes(m));
  if (login) {
    throw new Checkpoint(
      `Naukri showed the login wall on ${where}. Log in inside the debug Chrome window, then re-run.`
    );
  }
}

// Randomised pause between actions. A fixed interval is a signature; humans are
// irregular. Used between every job in an apply run and between pages in a
// harvest.
const jitter = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * Math.max(0, max - min)));

module.exports = { Checkpoint, check, jitter, URL_MARKERS, TEXT_MARKERS };
