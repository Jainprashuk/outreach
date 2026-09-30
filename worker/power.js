'use strict';

// Keeping the machine awake, per platform.
//
// The workers were written for macOS, where `caffeinate` does all of this. On
// Linux the equivalent is `systemd-inhibit`, which takes a lock through logind
// for as long as the command it wraps is alive. Anything else (a Linux box with
// no systemd, Windows) gets no inhibitor at all: the worker still runs, the
// machine just has to be kept awake by hand.
//
// Every function here degrades to a no-op rather than throwing. Failing to hold
// the machine awake is a worse run, never a failed one — except that a wrapper
// which itself fails would fail the harvest, which is why the Linux inhibitor
// is probed once before it is ever used as a wrapper.

const { spawn, spawnSync, execFile } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// systemd-inhibit exists on most desktop distros, but logind can still refuse
// the lock (no session, a polkit rule). Try it once with a no-op command.
let inhibitOk = null;
function linuxInhibitWorks() {
  if (inhibitOk === null) {
    const r = spawnSync('systemd-inhibit',
      ['--what=sleep:idle', '--who=outreach-worker', '--why=probe', 'true'],
      { stdio: 'ignore', timeout: 5000 });
    inhibitOk = !r.error && r.status === 0;
  }
  return inhibitOk;
}

const inhibitArgs = (why) =>
  ['--what=sleep:idle', '--who=outreach-worker', `--why=${why}`];

// [bin, args] that runs `cmd args` with sleep held off until it exits.
// macOS: caffeinate -dimsu, which holds on battery too, so a harvest does not
// die mid-scroll because the charger came out.
function wrapAwake(cmd, args) {
  if (IS_MAC) return ['caffeinate', ['-dimsu', cmd, ...args]];
  if (IS_LINUX && linuxInhibitWorks()) {
    return ['systemd-inhibit', [...inhibitArgs('scrape running'), cmd, ...args]];
  }
  return [cmd, args];
}

function spawnDetached(bin, args) {
  try {
    const p = spawn(bin, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (_) { /* not fatal — worst case the machine sleeps and we retry next wake */ }
}

// After a scheduled wake nothing holds an assertion, so macOS re-sleeps within
// a minute or two — possibly mid-claim. Buy some time the moment we notice we
// just woke; if a run starts, its own assertion takes over.
function holdAwake(seconds) {
  if (IS_MAC) return spawnDetached('caffeinate', ['-dimsu', '-t', String(seconds)]);
  if (IS_LINUX && linuxInhibitWorks()) {
    spawnDetached('systemd-inhibit', [...inhibitArgs('just woke'), 'sleep', String(seconds)]);
  }
}

// Hold idle sleep off for as long as THIS process lives, so the worker keeps
// polling and a queued run starts immediately instead of at the next wake.
// -i prevents idle sleep on any power source; -s adds the AC-only assertion.
// `-s` alone does nothing on battery, which was the original mistake.
function holdWhileAlive() {
  const pid = String(process.pid);
  if (IS_MAC) return spawnDetached('caffeinate', ['-is', '-w', pid]);
  if (IS_LINUX && linuxInhibitWorks()) {
    // `tail --pid` exits when we do, which releases the inhibitor with it.
    spawnDetached('systemd-inhibit', [...inhibitArgs('worker polling'), 'tail', `--pid=${pid}`, '-f', '/dev/null']);
  }
}

// `pmset -g sched` -> the next scheduled wake, so the portal can say "this
// will run at 9:25am" instead of "eventually". macOS only; elsewhere the portal
// simply shows no wake time.
function nextWakeAt() {
  if (!IS_MAC) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'sched'], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(null);
      const times = [];
      for (const line of String(stdout || '').split('\n')) {
        const m = /(?:wake|poweron)[^0-9]*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/i.exec(line);
        if (!m) continue;
        const [date, time] = m[1].split(' ');
        const [mo, d, y] = date.split('/').map(Number);
        const [hh, mi, ss] = time.split(':').map(Number);
        const at = new Date(y, mo - 1, d, hh, mi, ss);
        if (!isNaN(at.getTime()) && at > new Date()) times.push(at);
      }
      times.sort((a, b) => a - b);
      resolve(times[0] ? times[0].toISOString() : null);
    });
  });
}

module.exports = { wrapAwake, holdAwake, holdWhileAlive, nextWakeAt };
