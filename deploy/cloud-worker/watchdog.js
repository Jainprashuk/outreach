'use strict';

// Keeps one user's Chrome from eating its container.
//
// Chrome left running for a day grows until it hits the container's memory cap,
// then pages to the VM's slow disk; everything on the VM crawls, the workers'
// check-ins time out and the portal shows them offline (seen 2026-10-22: 2.5 GB
// used + 1 GB swap after 22 h). Restarting Chrome gives it all back, and the
// logins survive it — they live in the profile on disk.
//
// So, every CHECK_MS: restart Chrome when the container is above HIGH of its
// memory cap, or when Chrome has been up longer than MAX_UPTIME_MS. Only
// between runs: it takes the same chrome lock the workers take before they
// drive Chrome (worker/chrome-lock.js), so a run is never cut off, and no run
// can start while Chrome is coming back.

const fs = require('fs');
const { execFile } = require('child_process');
const chromeLock = require('/app/worker/chrome-lock');

const CHECK_MS = Number(process.env.WATCHDOG_CHECK_MS) || 2 * 60 * 1000;
const HIGH = Number(process.env.WATCHDOG_HIGH) || 0.8;
const MAX_UPTIME_MS = Number(process.env.WATCHDOG_MAX_UPTIME_MS) || 24 * 3600 * 1000;
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
const SUPERVISOR = ['-c', '/tmp/cw-supervisord.conf'];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The container's own cgroup (cgroup v2, private namespace — Docker's default).
function memory() {
  try {
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const max = maxRaw === 'max' ? 0 : Number(maxRaw);
    return { current, max };
  } catch (_) { return null; }
}

const run = (args) => new Promise((resolve) => {
  execFile('supervisorctl', [...SUPERVISOR, ...args], { timeout: 60000 }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
});

async function chromeUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch (_) { return false; }
}

let chromeSince = Date.now();

async function restartChrome(why) {
  const release = chromeLock.acquire('watchdog');
  if (!release) { log(`would restart Chrome (${why}) but a run is using it — next check`); return; }
  try {
    log(`restarting Chrome: ${why}`);
    await run(['restart', 'chrome']);
    for (let i = 0; i < 60 && !(await chromeUp()); i++) await sleep(1000);
    // A moment for the start page to settle before a worker may attach.
    await sleep(5000);
    chromeSince = Date.now();
    const m = memory();
    log(`Chrome is back${m ? ` — container now ${Math.round(m.current / 1048576)} MB` : ''}`);
  } finally {
    release();
  }
}

async function check() {
  const m = memory();
  if (m && m.max) {
    const used = m.current / m.max;
    if (used > HIGH) return restartChrome(`container at ${Math.round(used * 100)}% of its ${Math.round(m.max / 1048576)} MB`);
  }
  if (Date.now() - chromeSince > MAX_UPTIME_MS) return restartChrome(`up for ${Math.round((Date.now() - chromeSince) / 3600000)} h`);
}

(async () => {
  const m = memory();
  log(`watchdog up — restart Chrome above ${Math.round(HIGH * 100)}% of ${m && m.max ? Math.round(m.max / 1048576) + ' MB' : 'no cap'} or after ${Math.round(MAX_UPTIME_MS / 3600000)} h, between runs`);
  for (;;) {
    await sleep(CHECK_MS);
    await check().catch(err => log('check failed:', err.message));
  }
})();
