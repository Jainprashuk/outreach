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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

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
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
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
function runHarvest(queries, briefPath) {
  return new Promise((resolve) => {
    const args = ['-dimsu', jlBin(), 'harvest'];
    for (const q of queries) args.push('-q', q);
    // --brief to a per-run temp file so nothing ever reads a half-written one.
    // Deliberately NOT passing --store/--runs-dir: the run must write the
    // repo's default data/leads.json, because that store is what makes the
    // new-vs-seen distinction work across runs.
    args.push('--brief', briefPath);

    log(`harvest: ${queries.length} queries`);
    const child = spawn('caffeinate', args, { cwd: CFG.jlRepo });

    let tail = [];
    const keep = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      tail.push(s);
      if (tail.length > 40) tail = tail.slice(-40);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      log('harvest exceeded the timeout — killing it');
      child.kill('SIGKILL');
    }, HARVEST_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `Could not start jl: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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

    const { code, output } = await runHarvest(runDoc.queries, briefPath);

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

main().catch((err) => { console.error(err); process.exit(1); });
