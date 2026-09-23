#!/usr/bin/env node
'use strict';

// Naukri worker — runs on Prashuk's Mac, not on Vercel.
//
// Same constraint as the LinkedIn harvest, for the same reason: it attaches to a
// real, visible Chrome over the DevTools protocol, logged in as you. There is no
// headless path and no launch path. A real browser with a real profile is why
// the account stays unrestricted, and it is why this cannot run serverless.
//
// Three kinds of work, in the order a scheduled wake fires them:
//   refresh — re-save the profile so recruiter search ranks you today
//   harvest — collect listings into the portal as `pending`
//   apply   — act on the jobs YOU approved, and only those
//
// The apply step is the one that does something irreversible, so it is the most
// constrained: it only ever sees jobs the server hands it, the server only hands
// over approved ones, and a screening question with no matching answer skips the
// job rather than guessing.
//
//   npm run naukri-worker          (wraps this in `caffeinate -is`)

const path0 = require('path');
// Load the outreach repo's .env (WORKER_SECRET, OUTREACH_URL), the same file
// server.js reads. Resolved from __dirname, not cwd, so it works from any
// directory and under launchd.
require('dotenv').config({ path: path0.join(__dirname, '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const chromeLock = require('./chrome-lock');

const CFG = {
  outreachUrl: (process.env.OUTREACH_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  workerSecret: process.env.WORKER_SECRET || '',
  jlRepo:       process.env.JL_REPO || path.join(os.homedir(), 'Desktop', 'linkdin-post'),
  pollMs:       Number(process.env.POLL_MS) || 20000,
  cdpPort:      Number(process.env.CDP_PORT) || 9222,
  // Set NAUKRI_STUB=1 to run the loop end to end without touching Naukri. It
  // exercises claim/progress/result/finish against the real server with fake
  // page data — the only way to test the lifecycle without spending real
  // applications on a real account.
  stub:         process.env.NAUKRI_STUB === '1',
};

const LOCK_FILE = path.join(os.homedir(), '.job-leads', 'naukri-worker.lock');
const CHUNK = 200;                       // jobs per /ingest call, well under Vercel's body cap
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── single instance ─────────────────────────────────────────────────────────
// Two Naukri workers would both drive the same Chrome profile and both apply to
// the same approved jobs — double applications, which a recruiter sees.
function claimLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      console.error(`Another Naukri worker is already running (pid ${pid}). Refusing to start.`);
      process.exit(1);
    }
    log(`Removing stale lock from dead pid ${pid}`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
}

// ── portal API ──────────────────────────────────────────────────────────────
async function api(pathname, body) {
  const res = await fetch(CFG.outreachUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': CFG.workerSecret },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`${pathname} returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data.error || `${pathname} failed with ${res.status}`);
  return data;
}

// The resume lives in Mongo, not on disk. Playwright's setInputFiles needs a
// real path, so fetch it to a temp file per run and delete it afterwards.
async function fetchResume(runId) {
  const res = await fetch(CFG.outreachUrl + '/api/naukri/worker-resume', {
    headers: { 'X-Worker-Secret': CFG.workerSecret },
  });
  if (!res.ok) return null;
  const disp = res.headers.get('content-disposition') || '';
  const named = /filename="([^"]+)"/.exec(disp);
  const ext = named ? path.extname(named[1]) : '.pdf';
  const file = path.join(os.tmpdir(), `naukri-resume-${runId}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ── machine state the portal displays ───────────────────────────────────────
const exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
});

async function chromeUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CFG.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (_) { return false; }
}

// `pmset -g sched` -> the next scheduled wake, so the tab can say "this runs at
// 9:25am" instead of "eventually".
async function nextWakeAt() {
  const { ok, stdout } = await exec('pmset', ['-g', 'sched']);
  if (!ok) return null;
  const times = [];
  for (const line of stdout.split('\n')) {
    const m = /(?:wake|poweron)[^0-9]*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/i.exec(line);
    if (!m) continue;
    const [date, time] = m[1].split(' ');
    const [mo, d, y] = date.split('/').map(Number);
    const [hh, mi, ss] = time.split(':').map(Number);
    const at = new Date(y, mo - 1, d, hh, mi, ss);
    if (!isNaN(at.getTime()) && at > new Date()) times.push(at);
  }
  times.sort((a, b) => a - b);
  return times[0] ? times[0].toISOString() : null;
}

// ── power ───────────────────────────────────────────────────────────────────
// After a scheduled wake nothing holds an assertion, so macOS re-sleeps within a
// minute or two — possibly mid-claim. Buy five minutes the moment we notice we
// just woke; if a run starts, its own assertion takes over.
function holdAwake(seconds) {
  try {
    const p = spawn('caffeinate', ['-dimsu', '-t', String(seconds)], { detached: true, stdio: 'ignore' });
    p.unref();
  } catch (_) { /* not fatal — worst case the Mac sleeps and we retry next wake */ }
}

// ── the driver ──────────────────────────────────────────────────────────────
// Everything that knows what Naukri's DOM looks like lives behind this one
// require, so the loop below can be tested without a browser and a selector fix
// never touches lifecycle code.
function loadDriver() {
  if (CFG.stub) return require('./naukri/stub');
  return require('./naukri');
}

// Thrown by the driver's guard when Naukri challenges the session. Exit 2 is the
// same contract the LinkedIn harvest uses: the server turns it into a 7-day
// block that a worker restart cannot shrug off.
const isCheckpoint = (err) => err && err.name === 'Checkpoint';

async function executeRun(runDoc, config, openSession = null) {
  const finish = (status, extra) => api('/api/naukri/finish', { runId: runDoc.id, status, ...extra });
  let resumePath = null;

  // Fire-and-forget: a progress POST that fails must never interrupt a run that
  // is working. The next event overwrites it anyway.
  const onProgress = (progress) => {
    api('/api/naukri/progress', { runId: runDoc.id, progress })
      .catch(err => log('progress update dropped:', err.message));
  };
  // Per-job outcomes are NOT fire-and-forget. An apply run that dies halfway
  // must still have told the server what it already sent, or the next run would
  // apply to the same job again.
  const onResult = (result) => api('/api/naukri/result', { runId: runDoc.id, ...result });

  const deadline = setTimeout(() => {
    log('run exceeded the timeout — the driver will be abandoned');
  }, RUN_TIMEOUT_MS);

  try {
    if (!CFG.stub && !await chromeUp()) {
      log('Chrome is not listening — running chrome-debug.sh');
      await exec('bash', [path.join(CFG.jlRepo, 'chrome-debug.sh')], { cwd: CFG.jlRepo, timeout: 60000 });
      await sleep(2000);
    }
    if (!CFG.stub && !await chromeUp()) {
      return finish('failed', { error: 'Could not open Chrome on the debug port. Run chrome-debug.sh by hand.' });
    }

    const driver = loadDriver();
    // The session is opened once per poll by the caller and shared with the
    // login probe. Attaching over CDP walks every target in the browser, which
    // on an everyday Chrome is slow enough that doing it twice per poll was
    // timing out the second one.
    const session = openSession || await driver.connect({ cdpPort: CFG.cdpPort });

    try {
      if (!await driver.loggedIn(session)) {
        // A login wall is a human problem. Retrying would just burn runs.
        return finish('failed', { error: 'Not logged into Naukri. Log in inside the debug Chrome window, then try again.' });
      }

      if (runDoc.kind === 'refresh') {
        const out = await driver.refresh(session, { config, onProgress });
        // The profile's own "last updated" stamp is the only honest proof the
        // save landed. Unchanged means the page never really painted — a dark
        // wake, or a changed DOM — and must not be recorded as success.
        if (!out.updated) {
          return finish('failed', {
            error: 'Profile save did not move the "last updated" stamp. Either the Chrome window was not '
                 + 'visible (dark wake / minimised) or Naukri changed their DOM. Do not retry blindly.',
          });
        }
        await finish('done', { exitCode: 0 });
        log(`refresh done — ${out.note || 'profile updated'}`);
        return {};
      }

      if (runDoc.kind === 'harvest') {
        const { jobs, searches } = await driver.harvest(session, { config, onProgress });
        // Same doctrine as the LinkedIn harvest's zero-rendered check: a page
        // that painted nothing is a failure, never "no new jobs today".
        if (jobs.length === 0) {
          return finish('failed', {
            error: 'Zero cards rendered. Either the Chrome window was not visible (dark wake / minimised) '
                 + 'or Naukri changed their DOM. Do not retry blindly — check the window first.',
          });
        }
        for (let i = 0; i < jobs.length; i += CHUNK) {
          const chunk = jobs.slice(i, i + CHUNK);
          const r = await api('/api/naukri/ingest', { runId: runDoc.id, jobs: chunk });
          log(`ingested ${i + chunk.length}/${jobs.length} — ${r.created} new, ${r.updated} updated`);
        }
        await finish('done', { exitCode: 0, stats: { searches } });
        log(`harvest done — ${jobs.length} jobs from ${searches} searches`);
        return {};
      }

      if (runDoc.kind === 'apply') {
        const jobs = Array.isArray(runDoc.jobs) ? runDoc.jobs : [];
        if (jobs.length === 0) {
          // Not a failure. It is the normal state of an apply run queued by an
          // approval that the previous run already worked through, or one whose
          // daily budget is spent.
          await finish('done', { exitCode: 0, stats: { applied: 0, skipped: 0, failed: 0 } });
          log('apply: nothing approved and within budget — nothing to do');
          return {};
        }
        resumePath = await fetchResume(runDoc.id);
        const out = await driver.apply(session, {
          config, jobs, resumePath, dryRun: !!runDoc.dryRun, onProgress, onResult,
        });
        await finish('done', { exitCode: 0, stats: out });
        log(runDoc.dryRun
          ? `apply rehearsed — ${out.rehearsed || 0} job(s) walked, nothing submitted`
          : `apply done — ${out.applied} applied, ${out.skipped} skipped, ${out.failed} failed`);
        return {};
      }

      return finish('failed', { error: `Unknown run kind: ${runDoc.kind}` });
    } finally {
      // Only close what we opened. A session handed in by the caller is theirs
      // to close, after the login probe and the run have both finished with it.
      if (!openSession) await driver.disconnect(session).catch(() => {});
    }
  } catch (err) {
    if (isCheckpoint(err)) {
      await finish('blocked', { exitCode: 2, error: err.message });
      return { checkpoint: true };
    }
    log('run failed:', err.message);
    try { await finish('failed', { error: String(err.stack || err.message).slice(0, 1500) }); } catch (_) {}
    return {};
  } finally {
    clearTimeout(deadline);
    if (resumePath) { try { fs.unlinkSync(resumePath); } catch (_) {} }
  }
}

// ── main loop ───────────────────────────────────────────────────────────────
async function main() {
  if (!CFG.workerSecret) {
    console.error('WORKER_SECRET is not set. Add it to .env (and to the Vercel env) and restart.');
    process.exit(1);
  }
  claimLock();

  log(`naukri worker up — portal ${CFG.outreachUrl}, polling every ${CFG.pollMs / 1000}s`
    + (CFG.stub ? ' [STUB DRIVER — no browser, nothing real is applied to]' : ''));

  let lastTick = Date.now();
  for (;;) {
    // A gap much larger than the poll interval means the machine was asleep.
    const gap = Date.now() - lastTick;
    if (gap > CFG.pollMs * 2) {
      log(`woke after ${Math.round(gap / 1000)}s asleep — holding the Mac awake for 5 minutes`);
      holdAwake(300);
    }
    lastTick = Date.now();

    try {
      const [chrome, wake] = await Promise.all([chromeUp(), nextWakeAt()]);

      // Taken BEFORE claiming, not around the run: a run claimed and then
      // skipped would sit in 'running' until the server's 90-minute reaper,
      // because /claim only ever hands out queued rows.
      const releaseChrome = CFG.stub ? (() => {}) : chromeLock.acquire('naukri');

      // One CDP attach per poll, shared by the login probe and the run. Two
      // attaches in quick succession made the second one time out: each walks
      // every target in the browser, and they were competing.
      const driver = loadDriver();
      let session = null;
      if (releaseChrome && (chrome || CFG.stub)) {
        try { session = await driver.connect({ cdpPort: CFG.cdpPort }); }
        catch (err) { log('could not attach to Chrome:', err.message.split('\n')[0]); }
      }

      let claimed;
      try {
        claimed = await api('/api/naukri/claim', {
          host: os.hostname(),
          chromeUp: chrome,
          // Read from the cookie jar of the session we already hold — no
          // navigation, no extra attach. Undefined (rather than false) while we
          // have no session, so a poll that never looked does not overwrite the
          // last known answer with a wrong one.
          naukriLoggedIn: session ? await driver.loggedIn(session).catch(() => undefined) : undefined,
          nextWakeAt: wake,
          // Keep the tab saying "ready" for the length of a LinkedIn harvest,
          // which can be an hour, without claiming work we cannot execute.
          probeOnly: !releaseChrome,
        });

        if (claimed.paused) {
          log('Naukri is paused in Configuration — idling');
        } else if (claimed.blockedUntil) {
          log(`Naukri is blocked until ${claimed.blockedUntil} — idling`);
        } else if (claimed.run) {
          const runDoc = { ...claimed.run, jobs: claimed.jobs || [] };
          log(`claimed ${runDoc.trigger} ${runDoc.kind} run ${runDoc.id}`
            + (claimed.budget ? ` — ${claimed.budget.granted} of ${claimed.budget.perRun} allowed` : ''));
          const { checkpoint } = await executeRun(runDoc, claimed.config || {}, session);
          if (checkpoint) {
            log('Naukri showed a captcha. Stopping the worker — do not restart it for a week.');
            process.exit(0);
          }
        }
      } finally {
        if (session) await driver.disconnect(session).catch(() => {});
        if (releaseChrome) releaseChrome();
      }
    } catch (err) {
      log('poll failed:', err.message);
    }

    // Re-stamped AFTER the work, not before it. A run takes minutes; if the gap
    // were measured from the top of the loop, the next iteration would read its
    // own duration as time asleep and hold the Mac awake for nothing.
    lastTick = Date.now();
    await sleep(CFG.pollMs);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { executeRun, CFG };
