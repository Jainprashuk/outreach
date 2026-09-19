#!/usr/bin/env node
'use strict';

// LinkedIn scrape worker — runs on Prashuk's Mac, not on Vercel.
//
// `jl harvest` attaches to a real, visible Chrome over the DevTools protocol
// (scroll_harvest.py: chromium.connect_over_cdp). There is no headless path and
// no launch path, so this cannot run in a serverless function, a container or
// CI. That constraint is also the feature: a real browser with a real profile
// and a real fingerprint is why the LinkedIn account has not been restricted.
//
// The loop: poll the portal, claim at most one run, harvest, post the leads
// back through the same importer the manual JSON upload uses, report the
// outcome. One run at a time, forever, until a checkpoint stops it.
//
//   npm run scrape-worker          (wraps this in `caffeinate -s`)
//   worker/install-worker.sh       (same thing, via launchd at login)

const path0 = require('path');
// Load the outreach repo's .env (WORKER_SECRET, OUTREACH_URL, JL_REPO), the
// same file server.js reads. Resolved from __dirname, not cwd, so it works
// from any directory and under launchd.
require('dotenv').config({ path: path0.join(__dirname, '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

const CFG = {
  outreachUrl:  (process.env.OUTREACH_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  workerSecret:  process.env.WORKER_SECRET || '',
  jlRepo:        process.env.JL_REPO || path.join(os.homedir(), 'Desktop', 'linkdin-post'),
  pollMs:        Number(process.env.POLL_MS) || 20000,
  cdpPort:       Number(process.env.CDP_PORT) || 9222,
};

const LOCK_FILE = path.join(os.homedir(), '.job-leads', 'worker.lock');
const CHUNK = 500;              // leads per /ingest call, well under Vercel's 4.5MB body cap
const HARVEST_TIMEOUT_MS = 60 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jlBin = () => path.join(CFG.jlRepo, '.venv', 'bin', 'jl');

// ── harvest teardown ────────────────────────────────────────────────────────
// A harvest that outlives its worker is worse than no harvest. Nothing reads
// its stdout, so the portal's progress freezes; nothing reads its brief, so the
// leads never land; and the run stays 'running' until the server's 90-minute
// reaper gives up, blocking every later run. It also keeps driving the same
// Chrome a restarted worker is about to drive.

const sleepSync = (ms) => {
  // Atomics.wait because the exit handler cannot await anything.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
};

const isAlive = (pid) => {
  try { process.kill(pid, 0); } catch (_) { return false; }
  // Signal 0 also succeeds for a zombie. killTree runs synchronously from the
  // exit handler, so node never gets to reap its own child, and a caffeinate
  // that has already died would otherwise look alive for the full grace period
  // and earn a bogus "ignored SIGTERM". `ps` tells the two apart.
  const { stdout } = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = String(stdout || '').trim();
  return state !== '' && !state.startsWith('Z');
};

// SIGTERM, a grace period, then SIGKILL. `jl` can be mid-CDP-call, so give it a
// chance to close the browser context cleanly before insisting.
function killTree(pid, label) {
  if (!isAlive(pid)) return;
  log(`stopping ${label} (pid ${pid})`);
  // Negative pid signals the whole process group: `caffeinate` forks `jl`
  // rather than exec'ing it, so signalling the direct child alone would leave
  // the Python process orphaned — which is exactly the bug this prevents.
  try { process.kill(-pid, 'SIGTERM'); } catch (_) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
  for (let waited = 0; waited < 5000 && isAlive(pid); waited += 200) sleepSync(200);
  if (!isAlive(pid)) return;
  log(`${label} ignored SIGTERM — sending SIGKILL`);
  try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
}

// The harvest this worker started, while it is running.
let liveHarvest = null;
const killLiveHarvest = () => {
  const child = liveHarvest;
  liveHarvest = null;
  if (child && child.exitCode === null && child.signalCode === null) killTree(child.pid, 'harvest');
};

// A worker killed without running its exit handler (SIGKILL, a crashed
// terminal, a panic) leaves its harvest reparented to launchd and spinning.
// Clear any such ghost before taking the lock.
function reapStrayHarvest() {
  const { stdout } = spawnSync('pgrep', ['-f', `${jlBin()} harvest`], { encoding: 'utf8' });
  const pids = String(stdout || '').split('\n')
    .map(n => Number(n.trim()))
    .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  for (const pid of pids) killTree(pid, 'orphaned harvest from a previous worker');
  return pids.length;
}

// ── single instance ─────────────────────────────────────────────────────────
// `jl` rewrites data/leads.json wholesale with no locking, so two concurrent
// workers would clobber each other's store.
function claimLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      console.error(`Another scrape worker is already running (pid ${pid}). Refusing to start.`);
      process.exit(1);
    }
    log(`Removing stale lock from dead pid ${pid}`);
    // That worker may have died mid-harvest. Its `jl` would still be running.
    const reaped = reapStrayHarvest();
    if (reaped) {
      log(`reaped ${reaped} stray harvest process(es). The run they belonged to `
        + `will be failed by the server's stale-run sweep; re-queue it from the portal.`);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} };
  process.on('exit', () => { killLiveHarvest(); release(); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { killLiveHarvest(); release(); process.exit(0); });
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

// ── machine state the portal displays ───────────────────────────────────────
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
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

// `jl doctor` reports the li_at cookie without touching the page.
//
// doctor.py emits exactly one positive string for this row, `li_at cookie
// present`, against three negatives (`logged out …`, `Chrome has no browser
// context open`, `run ./chrome-debug.sh first`). Match the positive rather
// than searching for 'li_at', which also appears inside the logged-out row.
// Rich draws a table, so strip its borders and collapse whitespace first.
async function linkedinLoggedIn() {
  if (!fs.existsSync(jlBin())) return false;
  const { stdout, stderr } = await run(jlBin(), ['doctor'], { cwd: CFG.jlRepo });
  const flat = (stdout + stderr).replace(/[│┃|]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return flat.includes('li_at cookie present');
}

// `pmset -g sched` -> the next scheduled wake, so the portal can say
// "this will run at 9:25am" instead of "eventually".
async function nextWakeAt() {
  const { ok, stdout } = await run('pmset', ['-g', 'sched']);
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

function defaultQueries() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CFG.jlRepo, 'config.json'), 'utf8'));
    return Array.isArray(cfg.queries) ? cfg.queries : [];
  } catch (_) { return []; }
}

// ── power ───────────────────────────────────────────────────────────────────
// After a scheduled wake nothing holds an assertion, so macOS re-sleeps within
// a minute or two — possibly mid-claim. Buy five minutes the moment we notice
// we just woke; if a run starts, its own assertion takes over.
function holdAwake(seconds) {
  try {
    const p = spawn('caffeinate', ['-dimsu', '-t', String(seconds)], { detached: true, stdio: 'ignore' });
    p.unref();
  } catch (_) { /* not fatal — worst case the Mac sleeps and we retry next wake */ }
}

// ── the harvest ─────────────────────────────────────────────────────────────
// `jl` emits two lines per search (scroll_harvest.py on_event):
//   "search: <query>"                        when it starts one
//   "  32 posts seen, 19 hiring, 19 new"     when it finishes one
// Parsing those is what turns the panel's spinner into a real progress bar —
// searches done out of total — and lets it name the search currently running.
const RE_SEARCH = /^\s*search:\s*(.+?)\s*$/;
const RE_TALLY  = /^\s*(\d+)\s+posts seen,\s*(\d+)\s+hiring,\s*(\d+)\s+new\s*$/;

function runHarvest(queries, briefPath, onProgress) {
  return new Promise((resolve) => {
    const args = ['-dimsu', jlBin(), 'harvest'];
    for (const q of queries) args.push('-q', q);
    // --brief to a per-run temp file so nothing ever reads a half-written one.
    // Deliberately NOT passing --store/--runs-dir: the run must write the
    // repo's default data/leads.json, because that store is what makes the
    // new-vs-seen distinction work across runs.
    args.push('--brief', briefPath);

    log(`harvest: ${queries.length} queries`);
    // `detached` puts caffeinate and its `jl` child in their own process group,
    // so killTree can signal the pair as a unit. It also means a Ctrl-C aimed
    // at the worker no longer reaches the harvest by accident — the SIGINT
    // handler tears it down deliberately instead, which is the only path that
    // also reports the run as failed.
    const child = spawn('caffeinate', args, { cwd: CFG.jlRepo, detached: true });
    liveHarvest = child;

    let tail = [];
    const progress = {
      currentQuery: '', searchesDone: 0, searchesTotal: queries.length,
      rendered: 0, hiring: 0, new: 0, perQuery: [],
    };

    // Chunks split mid-line, so buffer until a newline before matching.
    let pending = '';
    const handleLine = (line) => {
      const search = RE_SEARCH.exec(line);
      if (search) {
        progress.currentQuery = search[1];
        return onProgress(progress);
      }
      const tally = RE_TALLY.exec(line);
      if (tally) {
        const [, rendered, hiring, fresh] = tally.map(Number);
        // The tally is per-query; the run totals are the running sum.
        progress.rendered += rendered;
        progress.hiring   += hiring;
        progress.new      += fresh;
        progress.searchesDone += 1;
        progress.perQuery.push({
          query: progress.currentQuery, rendered, hiring, new: fresh,
        });
        return onProgress(progress);
      }
    };

    const keep = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      tail.push(s);
      if (tail.length > 40) tail = tail.slice(-40);

      pending += s;
      const lines = pending.split('\n');
      pending = lines.pop();          // keep the unterminated remainder
      for (const line of lines) handleLine(line);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      log('harvest exceeded the timeout — killing it');
      killTree(child.pid, 'timed-out harvest');
    }, HARVEST_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      liveHarvest = null;
      resolve({ code: -1, output: `Could not start jl: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveHarvest = null;
      resolve({ code, output: tail.join('') });
    });
  });
}

// The brief is the machine-readable surface; `jl` prints Rich text, not JSON.
function readBrief(briefPath) {
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  const lastRun = brief.last_run || {};
  return {
    // Only last_run_leads. all_leads is every lead ever seen (~4,400 rows,
    // 1.6MB) and is already in the DB from previous runs.
    leads: Array.isArray(brief.last_run_leads) ? brief.last_run_leads : [],
    stats: {
      new: Number(lastRun.new) || 0,
      seen: Number(lastRun.seen) || 0,
      searches: Array.isArray(lastRun.searches) ? lastRun.searches.length : 0,
    },
  };
}

async function executeRun(runDoc) {
  const briefPath = path.join(os.tmpdir(), `scrape-brief-${runDoc.id}.json`);
  const finish = (status, extra) => api('/api/scrapes/finish', { runId: runDoc.id, status, ...extra });

  try {
    if (!fs.existsSync(jlBin())) {
      return finish('failed', { error: `jl not found at ${jlBin()} — is the scraper venv set up?` });
    }

    // Chrome down? Launch it. chrome-debug.sh is idempotent and exits 0 if the
    // port is already open.
    if (!await chromeUp()) {
      log('Chrome is not listening — running chrome-debug.sh');
      await run('bash', [path.join(CFG.jlRepo, 'chrome-debug.sh')], { cwd: CFG.jlRepo, timeout: 60000 });
      await sleep(2000);
    }
    if (!await chromeUp()) {
      return finish('failed', { error: 'Could not open Chrome on the debug port. Run chrome-debug.sh by hand.' });
    }
    if (!await linkedinLoggedIn()) {
      // A login wall is a human problem. Retrying would just burn runs.
      return finish('failed', { error: 'Not logged into LinkedIn. Log in inside the debug Chrome window, then try again.' });
    }

    // Fire-and-forget: a progress POST that fails must never interrupt a
    // harvest that is working. The next event overwrites it anyway.
    const postProgress = (progress) => {
      api('/api/scrapes/progress', { runId: runDoc.id, progress })
        .catch(err => log('progress update dropped:', err.message));
    };

    const { code, output } = await runHarvest(runDoc.queries, briefPath, postProgress);

    // Exit 2 is a LinkedIn checkpoint. TRACK-SCROLL.md says stop for a week;
    // the server turns this into a 7-day block that the schedule also obeys.
    if (code === 2) {
      await finish('blocked', { exitCode: 2, error: 'LinkedIn showed a checkpoint. Harvesting is paused for 7 days.' });
      return { checkpoint: true };
    }
    if (code !== 0) {
      return finish('failed', { exitCode: code, error: output.slice(-1500) || `jl exited ${code}` });
    }
    if (!fs.existsSync(briefPath)) {
      return finish('failed', { exitCode: code, error: 'Harvest finished but wrote no brief file.' });
    }

    const { leads, stats } = readBrief(briefPath);

    // `jl` warns loudly on zero rendered and its docs say not to add retries.
    // Treat it as a failure so a run that scrolled a frozen window is never
    // mistaken for "no new leads this week".
    const rendered = /(\d+)\s+rendered/.exec(output);
    stats.rendered = rendered ? Number(rendered[1]) : (leads.length ? leads.length : 0);
    const hiring = /from\s+(\d+)\s+hiring/.exec(output);
    stats.hiring = hiring ? Number(hiring[1]) : 0;

    if (stats.rendered === 0) {
      return finish('failed', {
        exitCode: 0, stats,
        error: 'Zero posts rendered. Either the Chrome window was not visible (dark wake / minimised) '
             + 'or LinkedIn changed their DOM. Do not retry blindly — check the window first.',
      });
    }

    for (let i = 0; i < leads.length; i += CHUNK) {
      const chunk = leads.slice(i, i + CHUNK);
      const r = await api('/api/scrapes/ingest', { runId: runDoc.id, leads: chunk });
      log(`ingested ${i + chunk.length}/${leads.length} — created ${r.created}, skipped ${r.skipped}`);
    }

    await finish('done', { exitCode: 0, stats });
    log(`run ${runDoc.id} done — ${stats.new} new of ${leads.length} delivered`);
    return {};
  } catch (err) {
    log('run failed:', err.message);
    try { await finish('failed', { error: err.message.slice(0, 1500) }); } catch (_) {}
    return {};
  } finally {
    try { fs.unlinkSync(briefPath); } catch (_) {}
  }
}

// ── main loop ───────────────────────────────────────────────────────────────
async function main() {
  if (!CFG.workerSecret) {
    console.error('WORKER_SECRET is not set. Add it to .env (and to the Vercel env) and restart.');
    process.exit(1);
  }
  if (!fs.existsSync(CFG.jlRepo)) {
    console.error(`Scraper repo not found at ${CFG.jlRepo}. Set JL_REPO.`);
    process.exit(1);
  }
  claimLock();

  log(`worker up — portal ${CFG.outreachUrl}, scraper ${CFG.jlRepo}, polling every ${CFG.pollMs / 1000}s`);

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
      const [chrome, loggedIn, wake] = await Promise.all([chromeUp(), linkedinLoggedIn(), nextWakeAt()]);
      const { run: runDoc, blockedUntil } = await api('/api/scrapes/claim', {
        host: os.hostname(),
        chromeUp: chrome,
        linkedinLoggedIn: loggedIn,
        nextWakeAt: wake,
        defaultQueries: defaultQueries(),
      });

      if (blockedUntil) {
        log(`harvesting is blocked until ${blockedUntil} — idling`);
      } else if (runDoc) {
        log(`claimed ${runDoc.trigger} run ${runDoc.id}`);
        const { checkpoint } = await executeRun(runDoc);
        if (checkpoint) {
          log('LinkedIn checkpoint. Stopping the worker — do not restart it for a week.');
          process.exit(0);
        }
      }
    } catch (err) {
      log('poll failed:', err.message);
    }

    await sleep(CFG.pollMs);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { isAlive, killTree, reapStrayHarvest };
