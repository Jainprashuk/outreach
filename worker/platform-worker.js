#!/usr/bin/env node
'use strict';

// Job platform worker — runs on Prashuk's Mac, not on Vercel.
//
// One loop for every job platform (Naukri, Instahyre, Hirist, Cutshort, Wellfound), started as one
// process per platform:
//
//   PLATFORM=instahyre node worker/platform-worker.js   (npm run instahyre-worker)
//
// Each process drives only its own platform's driver (worker/naukri for Naukri,
// worker/platforms/<id> for the others), talks to its own API path, keeps its
// own lock and outbox, and is blocked on its own — an Instahyre captcha never
// stops the Naukri worker. They share the one debug Chrome through
// worker/chrome-lock.js, so only one of them (or the LinkedIn harvest) drives
// it at a time. worker/naukri-worker.js is this file with PLATFORM=naukri.
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
//   npm run naukri-worker | instahyre-worker | hirist-worker | cutshort-worker | wellfound-worker
//   (macOS or Linux; holds sleep off itself)

const path0 = require('path');
// Load the outreach repo's .env (WORKER_SECRET, OUTREACH_URL), the same file
// server.js reads. Resolved from __dirname, not cwd, so it works from any
// directory and under launchd.
require('dotenv').config({ path: path0.join(__dirname, '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const chromeLock = require('./chrome-lock');
const chromeHealth = require('./chrome-health');
const { holdAwake, holdWhileAlive, nextWakeAt } = require('./power');
const { isPlatform, labelOf } = require('../lib/platforms');

const PLATFORM = process.env.PLATFORM || 'naukri';
if (!isPlatform(PLATFORM)) {
  console.error(`Unknown PLATFORM "${PLATFORM}". Use one of: naukri, instahyre, hirist, cutshort, wellfound.`);
  process.exit(1);
}
const LABEL = labelOf(PLATFORM);
// Naukri keeps the exact paths it always used; the others go through the
// per-platform mount. Both reach the same router.
const API = PLATFORM === 'naukri' ? '/api/naukri' : `/api/p/${PLATFORM}`;

const CFG = {
  outreachUrl: (process.env.OUTREACH_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  workerSecret: process.env.WORKER_SECRET || '',
  jlRepo:       process.env.JL_REPO || path.join(os.homedir(), 'Desktop', 'linkdin-post'),
  pollMs:       Number(process.env.POLL_MS) || 20000,
  cdpPort:      Number(process.env.CDP_PORT) || 9222,
  // Set PLATFORM_STUB=1 (or the original NAUKRI_STUB=1) to run the loop end to
  // end without touching the site. It exercises claim/progress/result/finish
  // against the real server with fake page data — the only way to test the
  // lifecycle without spending real applications on a real account.
  stub:         process.env.PLATFORM_STUB === '1' || process.env.NAUKRI_STUB === '1',
  platform:     PLATFORM,
};

// Per platform, so three workers can run side by side. Naukri's names are the
// ones it always had.
const LOCK_FILE = path.join(os.homedir(), '.job-leads', `${PLATFORM}-worker.lock`);
const CHUNK = 200;                       // jobs per /ingest call, well under Vercel's body cap
// At least 80 minutes; an apply run gets more as it grows — room for every
// job at its own worst case (a job is abandoned after 90s, or 180s with live
// AI answers) plus the gaps. There is no ceiling on run size, so the limit
// follows the run rather than capping it. The server's stale-run check is by
// time since the last progress, so a long run that keeps reporting is safe.
const RUN_TIMEOUT_MS = 80 * 60 * 1000;
function runTimeoutFor(runDoc, config) {
  if (runDoc.kind !== 'apply') return RUN_TIMEOUT_MS;
  const d = loadDriver();
  const JOB_TIMEOUT_MS = d.JOB_TIMEOUT_MS || require('./naukri/apply').JOB_TIMEOUT_MS;
  const JOB_TIMEOUT_AI_MS = d.JOB_TIMEOUT_AI_MS || require('./naukri/apply').JOB_TIMEOUT_AI_MS;
  const af = (d.meta && d.meta.applyFlow) || {};
  const writesNotes = !!((af.confirm && af.confirm.message) || (af.screening && af.screening.aiNote));
  const perJob = (writesNotes || (config.autoAnswer && config.autoAnswer.enabled) ? JOB_TIMEOUT_AI_MS : JOB_TIMEOUT_MS)
    + (Number(config.apply && config.apply.delayMaxMs) || 4000);
  const jobs = Array.isArray(runDoc.jobs) ? runDoc.jobs.length : 0;
  return Math.max(RUN_TIMEOUT_MS, jobs * perJob + 10 * 60 * 1000);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── single instance ─────────────────────────────────────────────────────────
// Two workers for the same platform would both drive the same Chrome profile
// and both apply to the same approved jobs — double applications, which a
// recruiter sees.
function claimLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      console.error(`Another ${LABEL} worker is already running (pid ${pid}). Refusing to start.`);
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
// Every portal call gets a deadline. Without one, a request whose connection
// went quiet (Wi-Fi drop, sleep mid-request) never settles: the poll loop stops
// for good while holding the shared Chrome lock, so neither worker runs again,
// and the panel keeps showing the last heartbeat as "ready". Longer than
// Vercel's 60s function cap, so a slow but live response is never cut off.
const API_TIMEOUT_MS = 90 * 1000;

async function api(pathname, body, timeoutMs = API_TIMEOUT_MS) {
  const res = await fetch(CFG.outreachUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': CFG.workerSecret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`${pathname} returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw Object.assign(new Error(data.error || `${pathname} failed with ${res.status}`), { status: res.status });
  return data;
}

// The same call, retried through a network blip. Seen live on 2026-10-17: one
// "fetch failed" while reporting a job's result ended a whole apply run. Only
// the failures a retry can fix are retried — no connection, a timeout, or the
// server/Vercel having a moment (5xx, 429, a non-JSON error page). A real
// answer like "No such job" (4xx) is not.
// NAUKRI_RETRY_WAITS (comma-separated ms) shortens them for tests only.
const RETRY_WAITS_MS = process.env.NAUKRI_RETRY_WAITS
  ? process.env.NAUKRI_RETRY_WAITS.split(',').map(Number).filter(n => n >= 0)
  : [2000, 4000, 8000, 15000, 30000, 30000];   // ~1.5 min in all
const retryable = (err) => !err.status || err.status >= 500 || err.status === 429;

async function apiRetry(pathname, body, waits = RETRY_WAITS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(pathname, body);
    } catch (err) {
      if (!retryable(err) || attempt >= waits.length) throw err;
      log(`${pathname}: ${err.message.split('\n')[0]} — retrying in ${waits[attempt] / 1000}s`);
      await sleep(waits[attempt]);
    }
  }
}

// Results that could not be delivered even after retrying, kept on disk until
// they can be. A result is the record of what was sent under your name, so it
// is never just dropped. Flushed before every claim.
const OUTBOX_FILE = path0.join(require('os').homedir(), '.job-leads', `${PLATFORM}-outbox.json`);

function readOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')) || []; } catch (_) { return []; }
}
function writeOutbox(items) {
  try {
    fs.mkdirSync(path0.dirname(OUTBOX_FILE), { recursive: true });
    if (items.length) fs.writeFileSync(OUTBOX_FILE, JSON.stringify(items, null, 1));
    else fs.rmSync(OUTBOX_FILE, { force: true });
  } catch (err) { log('could not write the result outbox:', err.message); }
}
async function flushOutbox() {
  const items = readOutbox();
  if (!items.length) return;
  const left = [];
  for (const item of items) {
    try { await api(`${API}/result`, item); }
    catch (err) { if (retryable(err)) left.push(item); else log(`dropping undeliverable result for job ${item.jobId}: ${err.message}`); }
  }
  writeOutbox(left);
  log(`outbox: sent ${items.length - left.length} saved result(s)${left.length ? `, ${left.length} still waiting` : ''}`);
}

// Thrown when a result could not be delivered: the run stops rather than keep
// applying to jobs it cannot record.
class PortalUnreachable extends Error {
  constructor(message) { super(message); this.name = 'PortalUnreachable'; }
}

// The resume lives in Mongo, not on disk. Playwright's setInputFiles needs a
// real path, so fetch it to a temp file per run and delete it afterwards.
async function fetchResume(runId) {
  const res = await fetch(CFG.outreachUrl + `${API}/worker-resume`, {
    headers: { 'X-Worker-Secret': CFG.workerSecret },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const disp = res.headers.get('content-disposition') || '';
  const named = /filename="([^"]+)"/.exec(disp);
  const ext = named ? path.extname(named[1]) : '.pdf';
  const file = path.join(os.tmpdir(), `${PLATFORM}-resume-${runId}${ext}`);
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

// ── the driver ──────────────────────────────────────────────────────────────
// Everything that knows what Naukri's DOM looks like lives behind this one
// require, so the loop below can be tested without a browser and a selector fix
// never touches lifecycle code.
//
// Naukri's driver lives in worker/naukri (where it always has); every other
// platform's in worker/platforms/<id>. Same contract: worker/naukri/stub.js.
function loadDriver() {
  const dir = PLATFORM === 'naukri' ? './naukri' : `./platforms/${PLATFORM}`;
  if (CFG.stub) return require(`${dir}/stub`);
  return require(dir);
}

// Thrown by the driver's guard when the site challenges the session. Exit 2 is the
// same contract the LinkedIn harvest uses: the server turns it into a 7-day
// block that a worker restart cannot shrug off.
const isCheckpoint = (err) => err && err.name === 'Checkpoint';

async function executeRun(runDoc, config, openSession = null) {
  let deadlineTimer = null;
  const finish = (status, extra) => apiRetry(`${API}/finish`, { runId: runDoc.id, status, ...extra });
  let resumePath = null;

  // Fire-and-forget: a progress POST that fails must never interrupt a run that
  // is working. The next event overwrites it anyway.
  const onProgress = (progress) => {
    api(`${API}/progress`, { runId: runDoc.id, progress })
      .catch(err => log('progress update dropped:', err.message));
  };
  // Per-job outcomes are NOT fire-and-forget. An apply run that dies halfway
  // must still have told the server what it already sent, or the next run would
  // apply to the same job again.
  const onResult = async (result) => {
    const item = { runId: runDoc.id, ...result };
    try {
      return await apiRetry(`${API}/result`, item);
    } catch (err) {
      if (!retryable(err)) throw err;
      writeOutbox([...readOutbox(), item]);
      throw new PortalUnreachable('Lost the connection to the portal for over a minute while recording a result, '
        + 'so the run stopped instead of applying to jobs it could not record. The result is saved on this Mac '
        + 'and will be sent automatically when the connection is back.');
    }
  };

  // A deadline that actually ends the run.
  //
  // The previous version only LOGGED, which meant a hung driver call blocked
  // the worker forever — and since one run at a time is allowed, the whole
  // feature with it, until the server's 90-minute reaper noticed. A run that
  // overruns is now failed and the loop moves on. The hung call cannot be
  // cancelled, but it stops being everyone else's problem.
  // Rendered once, so the log line and the error the UI shows agree — and so a
  // short limit set for a test does not print "0.1333 minutes".
  const limitMs = runTimeoutFor(runDoc, config);
  const humanLimit = limitMs >= 60000
    ? `${Math.round(limitMs / 60000)}-minute`
    : `${Math.round(limitMs / 1000)}-second`;
  let timedOut = false;
  const expired = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      log(`run exceeded ${humanLimit} — abandoning it`);
      reject(new Error(`The ${runDoc.kind} run passed its ${humanLimit} limit and was abandoned. `
        + 'Anything it had already reported is recorded.'));
    }, limitMs);
  });
  // Never rejects on its own; only the race below observes it.
  expired.catch(() => {});

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
      // A site whose job search is public (Hirist) harvests logged out.
      const publicHarvest = runDoc.kind === 'harvest' && driver.meta && driver.meta.capabilities && driver.meta.capabilities.publicHarvest;
      const isIn = await driver.loggedIn(session);
      // Logged out on a public site: searches only (login-only feeds skipped).
      const loggedOut = publicHarvest && !isIn;
      if (loggedOut) log(`not logged into ${LABEL} — harvesting public searches only`);
      if (!publicHarvest && !isIn) {
        // A login wall is a human problem. Retrying would just burn runs.
        return finish('failed', { error: `Not logged into ${LABEL}. Log in inside the debug Chrome window, then try again.` });
      }

      if (runDoc.kind === 'refresh') {
        const out = await Promise.race([driver.refresh(session, { config, onProgress }), expired]);
        // The profile's own "last updated" stamp is the only honest proof the
        // save landed. Unchanged means the page never really painted — a dark
        // wake, or a changed DOM — and must not be recorded as success.
        if (!out.updated) {
          return finish('failed', {
            error: 'Profile save did not move the "last updated" stamp. Either the Chrome window was not '
                 + `visible (dark wake / minimised) or ${LABEL} changed their DOM. Do not retry blindly.`,
          });
        }
        await finish('done', { exitCode: 0 });
        log(`refresh done — ${out.note || 'profile updated'}`);
        return {};
      }

      if (runDoc.kind === 'harvest') {
        const { jobs, searches, recommended = 0, answeredEmpty = false } = await Promise.race([driver.harvest(session, { config, onProgress, loggedOut }), expired]);
        // Same doctrine as the LinkedIn harvest's zero-rendered check: a page
        // that painted nothing is a failure, never "no new jobs today".
        if (jobs.length === 0 && answeredEmpty) {
          // The site's own feed answered with an empty list (e.g. Instahyre
          // when every match is already applied): nothing new, not a failure.
          await finish('done', { exitCode: 0 });
          log(`harvest done — ${LABEL} had no new jobs (its feed answered empty)`);
          return {};
        }
        if (jobs.length === 0) {
          const recOnly = config.sources && config.sources.recommended && config.sources.searches === false;
          // A driver can name its own pages; Naukri's wording is the default.
          if (driver.emptyHarvestHint) return finish('failed', { error: driver.emptyHarvestHint(config) });
          return finish('failed', {
            error: recOnly
              ? 'No jobs found on Recommended jobs. Either the Chrome window was not visible (dark wake / minimised), '
                + 'Naukri has no recommendations for you right now, or the page changed — open '
                + 'naukri.com/mnjuser/recommendedjobs in the debug Chrome and look before retrying.'
              : 'Zero cards rendered. Either the Chrome window was not visible (dark wake / minimised) '
                + 'or Naukri changed their DOM. Do not retry blindly — check the window first.',
          });
        }
        for (let i = 0; i < jobs.length; i += CHUNK) {
          const chunk = jobs.slice(i, i + CHUNK);
          const r = await api(`${API}/ingest`, { runId: runDoc.id, jobs: chunk });
          log(`ingested ${i + chunk.length}/${jobs.length} — ${r.created} new, ${r.updated} updated`);
        }
        await finish('done', { exitCode: 0, stats: { searches, recommended } });
        log(`harvest done — ${jobs.length} jobs from ${searches} searches${recommended ? ` + ${recommended} recommended` : ''}`);
        return {};
      }

      if (runDoc.kind === 'apply') {
        const jobs = Array.isArray(runDoc.jobs) ? runDoc.jobs : [];
        if (jobs.length === 0) {
          // Not a failure. It is the normal state of an apply run queued by an
          // approval that the previous run already worked through, or one whose
          // daily budget is spent.
          await finish('done', { exitCode: 0, stats: { applied: 0, skipped: 0, failed: 0 } });
          const b = runDoc.budget;
          log(b && b.granted === 0 && b.doneToday >= b.perDay
            ? `apply: daily limit reached (${b.doneToday}/${b.perDay}) — nothing sent; raise Max per day or wait for tomorrow`
            : 'apply: nothing approved and waiting — nothing to do');
          return {};
        }
        resumePath = await fetchResume(runDoc.id);
        // Live AI answers: one try, a short deadline, and any failure is "no
        // answer" (the job is skipped as before). Never the long retry the
        // result reports get — a Naukri form is open and waiting.
        const askAI = async (question, options) => {
          try {
            return await api(`${API}/ai-answer`, { runId: runDoc.id, question, options }, 30 * 1000);
          } catch (err) {
            log('AI answer unavailable:', err.message.split('\n')[0]);
            return null;
          }
        };
        // The message that goes with an application, written for that job
        // (lib/applyNote.js). Same one-try rule; null = nothing was written, and
        // the driver then sends no application.
        const askNote = async (job, { kind = 'message', question = '', maxChars } = {}) => {
          try {
            return await api(`${API}/ai-note`, { runId: runDoc.id, jobId: job.id, kind, question, maxChars }, 60 * 1000);
          } catch (err) {
            log('AI note unavailable:', err.message.split('\n')[0]);
            return null;
          }
        };
        const out = await Promise.race([
          driver.apply(session, {
            config, jobs, resumePath, dryRun: !!runDoc.dryRun, onProgress, onResult, askAI, askNote,
          }),
          expired,
        ]);
        await finish('done', { exitCode: 0, stats: out });
        log(runDoc.dryRun
          ? `apply rehearsed — ${out.rehearsed || 0} job(s) walked, nothing submitted`
          : `apply done — ${out.applied} applied, ${out.skipped} skipped, ${out.failed} failed`);
        return {};
      }

      if (runDoc.kind === 'track') {
        // Read-only: what recruiters did with your applications.
        const { rows, expected } = await Promise.race([driver.track(session, { onProgress }), expired]);
        let matched = 0, moved = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const r = await apiRetry(`${API}/track`, { runId: runDoc.id, rows: rows.slice(i, i + CHUNK) });
          matched += r.matched || 0; moved += r.moved || 0;
        }
        await finish('done', { exitCode: 0, stats: {} });
        log(`track done — ${rows.length} recruiter action(s) read${expected != null ? ` of ${expected}` : ''}, ${matched} on jobs applied from here, ${moved} moved in your pipeline`);
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
    // A timeout is reported as itself, without a stack: the stack is this
    // file's race, not the thing that hung, and printing it would send you
    // looking in the wrong place.
    const detail = timedOut || err.name === 'PortalUnreachable' ? err.message : String(err.stack || err.message);
    try {
      await finish('failed', {
        error: detail.slice(0, 1500),
        ...(err.stats && typeof err.stats === 'object' ? { stats: err.stats } : {}),
      });
    } catch (_) {}
    return {};
  } finally {
    clearTimeout(deadlineTimer);
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
  holdWhileAlive();

  log(`${PLATFORM} worker up — portal ${CFG.outreachUrl}, polling every ${CFG.pollMs / 1000}s`
    + (CFG.stub ? ' [STUB DRIVER — no browser, nothing real is applied to]' : ''));

  let lastTick = Date.now();
  // How long the last poll chose to sleep: the server's hint when it sent one
  // (nextPollSeconds — minutes while nothing is happening), else pollMs.
  let sleptMs = CFG.pollMs;
  let nextSleepMs = CFG.pollMs;
  for (;;) {
    // A gap much larger than the intended sleep means the machine was asleep.
    const gap = Date.now() - lastTick;
    if (gap > sleptMs + CFG.pollMs * 2) {
      log(`woke after ${Math.round(gap / 1000)}s asleep — holding the machine awake for 5 minutes`);
      holdAwake(300);
    }
    lastTick = Date.now();

    try {
      const [chrome, wake] = await Promise.all([chromeUp(), nextWakeAt()]);

      // Taken BEFORE claiming, not around the run: a run claimed and then
      // skipped would sit in 'running' until the server's 90-minute reaper,
      // because /claim only ever hands out queued rows.
      const releaseChrome = CFG.stub ? (() => {}) : chromeLock.acquire(PLATFORM);

      // One CDP attach per poll, shared by the login probe and the run. Two
      // attaches in quick succession made the second one time out: each walks
      // every target in the browser, and they were competing.
      const driver = loadDriver();
      let session = null;
      if (releaseChrome && (chrome || CFG.stub)) {
        try { session = await driver.connect({ cdpPort: CFG.cdpPort }); }
        catch (err) {
          log('could not attach to Chrome:', err.message.split('\n')[0]);
          // Usually a frozen background tab, not anything site-specific.
          const stuck = await chromeHealth.stuckTabs(CFG.cdpPort).catch(() => []);
          if (stuck.length) log(chromeHealth.stuckTabsError(stuck));
        }
      }

      // Anything a previous run could not deliver goes first, before new work.
      await flushOutbox().catch(err => log('outbox flush failed:', err.message));

      let claimed;
      nextSleepMs = CFG.pollMs;
      try {
        // Read from the cookie jar of the session we already hold — no
        // navigation, no extra attach. Undefined (rather than false) while we
        // have no session, so a poll that never looked does not overwrite the
        // last known answer with a wrong one.
        const li = session ? await driver.loggedIn(session).catch(() => undefined) : undefined;
        claimed = await api(`${API}/claim`, {
          host: os.hostname(),
          chromeUp: chrome,
          // Both names: `loggedIn` for the platform server, `naukriLoggedIn`
          // for a server that predates platforms.
          loggedIn: li,
          naukriLoggedIn: li,
          nextWakeAt: wake,
          // Keep the tab saying "ready" for the length of a LinkedIn harvest,
          // which can be an hour, without claiming work we cannot execute.
          probeOnly: !releaseChrome,
          // Ask for check-in hints: the server then says when to come back
          // (fast while there is work or you are in the portal, minutes
          // otherwise). A server that predates hints ignores this.
          hints: true,
        });

        // Clamped like pollSeconds, wider: a bad value must neither spin nor
        // put the worker to sleep for hours.
        const hint = Number(claimed.nextPollSeconds);
        if (Number.isFinite(hint) && hint >= 15 && hint <= 900) nextSleepMs = hint * 1000;

        // The check-in interval is a setting (Configuration → Schedule), sent
        // back on every claim so a change applies without a restart. Clamped
        // here too: a malformed value must not turn this into a tight loop.
        const ps = Number(claimed.pollSeconds);
        if (Number.isFinite(ps) && ps >= 15 && ps <= 120 && ps * 1000 !== CFG.pollMs) {
          log(`check-in interval now ${ps}s (from Configuration)`);
          CFG.pollMs = ps * 1000;
        }

        if (claimed.paused) {
          log(claimed.disabled
            ? `${LABEL} is turned off in Configuration → Platforms — idling`
            : `${LABEL} is paused in Configuration — idling`);
        } else if (claimed.blockedUntil) {
          log(`${LABEL} is blocked until ${claimed.blockedUntil} — idling`);
        } else if (claimed.waiting) {
          log(`holding back: ${claimed.waiting} has an older run queued (oldest first across platforms)`);
        } else if (claimed.run) {
          const runDoc = { ...claimed.run, jobs: claimed.jobs || [], budget: claimed.budget || null };
          log(`claimed ${runDoc.trigger} ${runDoc.kind} run ${runDoc.id}`
            + (claimed.budget ? ` — ${claimed.budget.granted} of ${claimed.budget.perRun} allowed` : ''));
          const { checkpoint } = await executeRun(runDoc, claimed.config || {}, session);
          if (checkpoint) {
            log(`${LABEL} showed a captcha. Stopping the worker — do not restart it for a week.`);
            process.exit(0);
          }
        }
      } finally {
        if (session) await driver.disconnect(session).catch(() => {});
        if (releaseChrome) releaseChrome();
      }
    } catch (err) {
      // "fetch failed" alone hides the reason; the cause names it
      // (UND_ERR_CONNECT_TIMEOUT = the network dropped the connection attempt).
      log('poll failed:', err.message + (err.cause && (err.cause.code || err.cause.message) ? ` (${err.cause.code || err.cause.message})` : ''));
    }

    // Re-stamped AFTER the work, not before it. A run takes minutes; if the gap
    // were measured from the top of the loop, the next iteration would read its
    // own duration as time asleep and hold the Mac awake for nothing.
    lastTick = Date.now();
    sleptMs = nextSleepMs;
    await sleep(nextSleepMs);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { executeRun, flushOutbox, readOutbox, OUTBOX_FILE, CFG, PLATFORM, API, main };
