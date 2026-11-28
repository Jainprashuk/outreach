// The perf dashboard at https://logs.<zone>/perf (container cw-perf, see
// `cw perf-ui`). Once a minute it reads the portal's counters
// (GET /api/internal/perf, lib/perf.js), Docker's per-container CPU and memory,
// and the host's load, memory and disk, and keeps 7 days of per-minute points in
// /data/history.json. The portal's counters reset on every deploy; this history
// does not.
//
// No dependencies: stock node:22-slim runs this file straight from the checkout.
// Reachable only through the tunnel, behind the logs page's Cloudflare Access.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 6091);
const PORTAL = process.env.PORTAL || 'http://127.0.0.1:3000';
const TOKEN = String(process.env.PERF_TOKEN || '').trim();
const DATA = process.env.DATA || '/data';
const FILE = path.join(DATA, 'history.json');
const KEEP_MS = 7 * 24 * 3600_000;
const SLOW_KEEP = 300;
const INDEX = path.join(__dirname, 'index.html');

let state = { points: [], slowRequests: [], slowQueries: [], db: null, dbHistory: [], bounds: null };
let last = null;      // previous portal snapshot, for deltas
let lastError = null;

try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

function save() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('save failed:', e.message); }
}

// ── sources ────────────────────────────────────────────────────────────────
function getJson(opts, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const portal = () => {
  const u = new URL('/api/internal/perf', PORTAL);
  return getJson({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'x-perf-token': TOKEN } });
};
const docker = (p) => getJson({ socketPath: '/var/run/docker.sock', path: p });

async function containers() {
  const list = await docker('/containers/json');
  const out = {};
  await Promise.all(list.map(async (c) => {
    const name = (c.Names[0] || c.Id).replace(/^\//, '');
    try {
      const s = await docker(`/containers/${c.Id}/stats?stream=false`);
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = (s.cpu_stats.system_cpu_usage || 0) - (s.precpu_stats.system_cpu_usage || 0);
      const cpus = s.cpu_stats.online_cpus || 1;
      const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.total_inactive_file ?? 0;
      out[name] = {
        cpu: sysDelta > 0 ? Math.round(cpuDelta / sysDelta * cpus * 1000) / 10 : 0,   // % of one core
        memMb: Math.round(((s.memory_stats.usage || 0) - cache) / 1048576),
        limitMb: Math.round((s.memory_stats.limit || 0) / 1048576),
      };
    } catch { /* container went away mid-poll */ }
  }));
  return out;
}

// /proc in a container shows the host's load and memory (no lxcfs here).
function host() {
  const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').map(Number);
  const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
    .map(l => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map(m => [m[1], Number(m[2])]));
  const fsx = fs.statfsSync(DATA);
  return {
    load1: load[0], cpus: require('os').cpus().length,
    memUsedMb: Math.round((mem.MemTotal - mem.MemAvailable) / 1024), memTotalMb: Math.round(mem.MemTotal / 1024),
    diskUsedGb: Math.round((fsx.blocks - fsx.bfree) * fsx.bsize / 1e8) / 10, diskTotalGb: Math.round(fsx.blocks * fsx.bsize / 1e8) / 10,
  };
}

// ── polling ────────────────────────────────────────────────────────────────
// A point holds what happened since the previous poll. Same bootId: subtract.
// New bootId (a deploy): the new process's counters are all since boot.
function delta(cur, prev) {
  const out = {};
  for (const [k, s] of Object.entries(cur)) {
    const p = prev && prev[k];
    const c = s.count - (p ? p.count : 0);
    if (c <= 0) continue;
    out[k] = {
      c, e: s.errors - (p ? p.errors : 0), s: Math.round(s.sumMs - (p ? p.sumMs : 0)),
      m: Math.round(s.maxMs),   // cumulative max: a ceiling, not this minute's
      h: s.hist.map((n, i) => n - (p ? p.hist[i] : 0)),
    };
  }
  return out;
}

const mergeSlow = (have, fresh, key) => {
  const seen = new Set(have.map(key));
  return have.concat(fresh.filter(x => !seen.has(key(x)))).slice(-SLOW_KEEP);
};

async function poll() {
  const t = Date.now();
  const point = { t };
  const [snap, ctr] = await Promise.allSettled([portal(), containers()]);
  if (snap.status === 'fulfilled') {
    const s = snap.value;
    const prev = last && last.bootId === s.bootId ? last : null;
    point.routes = delta(s.routes, prev && prev.routes);
    point.queries = delta(s.queries, prev && prev.queries);
    point.proc = { ...s.process, inFlight: s.inFlight, restarted: !prev && !!last };
    state.bounds = s.bounds;
    state.slowRequests = mergeSlow(state.slowRequests, s.slowRequests, x => x.at + x.route);
    state.slowQueries = mergeSlow(state.slowQueries, s.slowQueries, x => x.at + x.query);
    if (s.db) {
      state.db = { ...s.db, at: s.now };
      const lastDb = state.dbHistory[state.dbHistory.length - 1];
      if (!lastDb || t - lastDb.t > 3600_000) state.dbHistory.push({ t, dataMb: s.db.dataMb, storageMb: s.db.storageMb });
      state.dbHistory = state.dbHistory.slice(-24 * 90);
    }
    last = s;
    lastError = null;
  } else {
    lastError = { at: new Date(t).toISOString(), message: `portal: ${snap.reason.message}` };
    point.down = true;
  }
  if (ctr.status === 'fulfilled') point.containers = ctr.value;
  try { point.host = host(); } catch { /* not fatal */ }
  state.points.push(point);
  state.points = state.points.filter(p => p.t > t - KEEP_MS);
}

// ── aggregation for the page ───────────────────────────────────────────────
const RANGES = { '1h': [3600e3, 60e3], '6h': [6 * 3600e3, 5 * 60e3], '24h': [24 * 3600e3, 15 * 60e3], '7d': [7 * 24 * 3600e3, 3600e3] };

function pct(hist, q, maxMs) {
  const bounds = state.bounds || [];
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let target = total * q, lo = 0;
  for (let i = 0; i < hist.length; i++) {
    const hi = bounds[i] == null ? Math.max(maxMs || lo, lo) : bounds[i];
    if (target <= hist[i]) return Math.round(lo + (hi - lo) * (target / hist[i]));
    target -= hist[i];
    lo = hi;
  }
  return Math.round(lo);
}

function addInto(acc, m) {
  for (const [k, v] of Object.entries(m || {})) {
    const a = acc[k] || (acc[k] = { c: 0, e: 0, s: 0, m: 0, h: v.h.map(() => 0) });
    a.c += v.c; a.e += v.e; a.s += v.s; a.m = Math.max(a.m, v.m);
    v.h.forEach((n, i) => { a.h[i] += n; });
  }
  return acc;
}
const total = (m) => Object.values(m || {}).reduce((acc, v) => addInto(acc, { all: v }), {}).all;

function table(points, prevPoints) {
  return (kind) => {
    const now = points.reduce((acc, p) => addInto(acc, p[kind]), {});
    const before = prevPoints.reduce((acc, p) => addInto(acc, p[kind]), {});
    return Object.entries(now).map(([key, v]) => {
      const b = before[key];
      // A slow bucket's ceiling is only known as the cumulative max; cap it.
      const p95 = pct(v.h, 0.95, v.m);
      return {
        key, count: v.c, errors: v.e, avgMs: Math.round(v.s / v.c), p50: pct(v.h, 0.5, v.m), p95,
        totalS: Math.round(v.s / 100) / 10,
        prevP95: b ? pct(b.h, 0.95, b.m) : null, prevCount: b ? b.c : 0,
      };
    }).sort((a, b) => b.totalS - a.totalS).slice(0, 40);
  };
}

function view(rangeKey) {
  const [span, step] = RANGES[rangeKey] || RANGES['24h'];
  const now = Date.now();
  const points = state.points.filter(p => p.t > now - span);
  const prevPoints = state.points.filter(p => p.t > now - 2 * span && p.t <= now - span);

  const buckets = new Map();
  for (const p of points) {
    const b = Math.floor(p.t / step) * step;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(p);
  }
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, ps]) => {
    const all = ps.reduce((acc, p) => addInto(acc, { all: total(p.routes) || { c: 0, e: 0, s: 0, m: 0, h: [] } }), {}).all;
    const api = ps.reduce((acc, p) => {
      const only = Object.fromEntries(Object.entries(p.routes || {}).filter(([k]) => k.includes(' /api')));
      const t2 = total(only);
      return t2 ? addInto(acc, { api: t2 }) : acc;
    }, {}).api;
    const db = ps.reduce((acc, p) => { const q = total(p.queries); return q ? addInto(acc, { db: q }) : acc; }, {}).db;
    const avg = (f) => { const v = ps.map(f).filter(x => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    const max = (f) => { const v = ps.map(f).filter(x => x != null); return v.length ? Math.max(...v) : null; };
    const names = new Set(ps.flatMap(p => Object.keys(p.containers || {})));
    const ctr = {};
    for (const n of names) ctr[n] = { cpu: avg(p => p.containers?.[n]?.cpu), memMb: avg(p => p.containers?.[n]?.memMb), limitMb: max(p => p.containers?.[n]?.limitMb) };
    return {
      t, minutes: ps.length,
      reqs: all ? all.c : 0, errors: all ? all.e : 0,
      apiP50: api ? pct(api.h, 0.5, api.m) : null, apiP95: api ? pct(api.h, 0.95, api.m) : null,
      dbP95: db ? pct(db.h, 0.95, db.m) : null,
      loopP99: max(p => p.proc?.loopP99Ms), rssMb: max(p => p.proc?.rssMb),
      load1: avg(p => p.host?.load1), memUsedMb: avg(p => p.host?.memUsedMb),
      down: ps.some(p => p.down), restarted: ps.some(p => p.proc?.restarted),
      containers: ctr,
    };
  });

  const summarize = (ps) => {
    const api = ps.reduce((acc, p) => {
      const only = Object.fromEntries(Object.entries(p.routes || {}).filter(([k]) => k.includes(' /api')));
      const t2 = total(only);
      return t2 ? addInto(acc, { api: t2 }) : acc;
    }, {}).api;
    const db = ps.reduce((acc, p) => { const q = total(p.queries); return q ? addInto(acc, { db: q }) : acc; }, {}).db;
    const loops = ps.map(p => p.proc?.loopP99Ms).filter(x => x != null).sort((a, b) => a - b);
    return {
      apiReqs: api ? api.c : 0, apiErrors: api ? api.e : 0,
      apiP50: api ? pct(api.h, 0.5, api.m) : null, apiP95: api ? pct(api.h, 0.95, api.m) : null,
      dbP95: db ? pct(db.h, 0.95, db.m) : null,
      loopP99: loops.length ? loops[Math.floor(loops.length * 0.95)] : null,
      minutes: ps.length,
    };
  };

  const tbl = table(points, prevPoints);
  const since = new Date(now - span).toISOString();
  const latest = state.points[state.points.length - 1] || null;
  return {
    range: rangeKey, step, now,
    firstPointAt: state.points[0]?.t || null,
    summary: summarize(points), previous: summarize(prevPoints),
    series, routes: tbl('routes'), queries: tbl('queries'),
    slowRequests: state.slowRequests.filter(x => x.at >= since).slice(-60).reverse(),
    slowQueries: state.slowQueries.filter(x => x.at >= since).slice(-60).reverse(),
    latest: latest && { t: latest.t, proc: latest.proc || null, host: latest.host || null, containers: latest.containers || null, down: !!latest.down },
    db: state.db, dbHistory: state.dbHistory, lastError,
  };
}

// ── http ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/perf' || u.pathname === '/perf/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (u.pathname === '/perf/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(view(u.searchParams.get('range') || '24h')));
  }
  res.writeHead(404); res.end();
});

if (!TOKEN) console.warn('PERF_TOKEN is not set: the portal will answer 404 and only Docker/host stats are recorded.');
server.listen(PORT, '127.0.0.1', () => console.log(`perf dashboard on 127.0.0.1:${PORT}/perf, ${state.points.length} points loaded`));

const tick = () => poll().catch(e => console.error('poll failed:', e.message));
tick();
setInterval(tick, Number(process.env.POLL_MS || 60_000));
setInterval(save, 5 * 60_000);
process.once('SIGTERM', () => { save(); process.exit(0); });
