'use strict';

// One debug Chrome, two workers.
//
// The LinkedIn harvest (worker/scrape-worker.js, via `jl`) and the Naukri worker
// both attach to the same browser on the same CDP port. Playwright and the
// Python client each open pages in the shared context and scroll them; run both
// at once and they steal focus from each other mid-scroll, which produces
// exactly the failure the dark-wake rule exists to catch — a page that never
// paints — while the window is wide open. Worse, it looks like a selector bug.
//
// So: an advisory lock on the browser itself, held for the duration of a run.
// Advisory because the two processes are cooperating, not adversarial; there is
// no kernel lock on a TCP port and neither worker can force the other to stop.
//
// A loser does not wait. It returns and tries again on its next poll, twenty
// seconds later. Blocking would mean holding a claimed run while another run
// drives the browser, which is how you get two runs believing they own Chrome.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_FILE = path.join(os.homedir(), '.job-leads', 'chrome.lock');

// Longer than the longest plausible run (the LinkedIn harvest's own timeout is
// 60 minutes), so a slow run is never mistaken for a dead one. A holder that
// really did die leaves the lock behind, and the next attempt breaks it.
const STALE_MS = 90 * 60 * 1000;

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
};

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return { pid: Number(raw.pid), label: String(raw.label || '?'), at: Number(raw.at) || 0 };
  } catch (_) { return null; }
}

// Try to take the browser. Returns a release function, or null when someone
// else holds it — the caller skips this poll rather than waiting.
function acquire(label) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

  const held = read();
  if (held) {
    const dead = !alive(held.pid);
    const stale = Date.now() - held.at > STALE_MS;
    if (!dead && !stale) return null;
    // Only report breaking a lock, never taking a free one: the normal case
    // should be silent, and a broken lock is worth seeing in the log.
    console.log(new Date().toISOString(),
      `breaking ${dead ? 'dead' : 'stale'} chrome lock from ${held.label} (pid ${held.pid})`);
  }

  // Written with the pid so a crashed holder can be detected rather than waited
  // out, and with a label so the log can name who is driving.
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, label, at: Date.now() }));
  } catch (err) {
    // A lock we cannot write is not a reason to drive Chrome anyway — that is
    // the collision this module exists to prevent.
    console.log(new Date().toISOString(), `could not take the chrome lock: ${err.message}`);
    return null;
  }

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // Only remove it if it is still ours. Another worker may have broken a lock
    // we thought we held, and deleting theirs would hand Chrome to a third.
    const now = read();
    if (now && now.pid === process.pid) {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
  };
}

// Run `fn` while holding the browser, or return `skipped` without running it.
async function withChrome(label, fn) {
  const release = acquire(label);
  if (!release) {
    const held = read();
    return { skipped: true, heldBy: held ? held.label : 'another worker' };
  }
  try {
    return { skipped: false, value: await fn() };
  } finally {
    release();
  }
}

module.exports = { acquire, withChrome, LOCK_FILE };
