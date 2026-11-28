/**
 * Performance counters for the dashboard at https://logs.<zone>/perf
 * (deploy/cloud-worker/perf). Everything here is in memory and cumulative since
 * boot: the dashboard polls GET /api/internal/perf once a minute and keeps the
 * history itself, so a deploy resets these counters but not the charts.
 *
 * Recording must never slow down or break a request: no awaits, no writes, and
 * every map is capped so an unknown-route flood cannot grow memory.
 */
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

// Histogram bucket upper bounds in ms; the last bucket is "slower than 30 s".
// Percentiles are read off these, so they are approximate by design.
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity];
const SLOW_REQUEST_MS = 1000;
const SLOW_QUERY_MS = 300;
const SLOW_KEEP = 100;
const MAX_KEYS = 400;

const bootId = crypto.randomBytes(6).toString('hex');
const startedAt = new Date().toISOString();

const routes = new Map();   // "GET /api/contacts/:id" -> stat
const queries = new Map();  // "find contacts" -> stat
const slowRequests = [];
const slowQueries = [];
let inFlight = 0;

// Each sample includes the sampling interval itself, so it is subtracted.
const LOOP_RESOLUTION_MS = 10;
const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loop.enable();

const newStat = () => ({ count: 0, errors: 0, sumMs: 0, maxMs: 0, hist: BOUNDS.map(() => 0) });

function add(map, key, ms, failed) {
  let s = map.get(key);
  if (!s) {
    if (map.size >= MAX_KEYS) key = '(other)';
    s = map.get(key) || newStat();
    map.set(key, s);
  }
  s.count++;
  if (failed) s.errors++;
  s.sumMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  s.hist[BOUNDS.findIndex(b => ms <= b)]++;
}

const remember = (list, item) => { list.push(item); if (list.length > SLOW_KEEP) list.shift(); };

// The matched Express pattern, so /api/contacts/65f… and /api/contacts/66a… are
// one row. Unmatched requests (static files, 404s) are grouped, never keyed by
// raw path.
function routeKey(req) {
  if (req.route && req.route.path) {
    const p = Array.isArray(req.route.path) ? req.route.path[0] : req.route.path;
    return `${req.method} ${req.baseUrl || ''}${p}`;
  }
  if (req.originalUrl.startsWith('/api/')) return `${req.method} /api (stopped before a route: auth, 404)`;
  return `${req.method} (static/page)`;
}

function trackRequests(req, res, next) {
  if (req.path === '/api/internal/perf') return next();
  const t0 = process.hrtime.bigint();
  inFlight++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight--;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const key = routeKey(req);
    add(routes, key, ms, res.statusCode >= 500);
    if (ms >= SLOW_REQUEST_MS) {
      remember(slowRequests, {
        at: new Date().toISOString(), route: key, path: req.originalUrl.split('?')[0].slice(0, 200),
        status: res.statusCode, ms: Math.round(ms), userId: req.user?._id ? String(req.user._id) : null,
      });
    }
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

// The keys of a filter, never its values (they hold emails and ids):
// { userId: 1, status: { $in: [..] } } -> "{userId, status.$in}".
function shapeOf(filter, depth = 0) {
  if (!filter || typeof filter !== 'object' || depth > 2) return '';
  return Object.entries(filter).slice(0, 12).map(([k, v]) => {
    const inner = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !v._bsontype
      ? shapeOf(v, depth + 1) : '';
    return inner && Object.keys(v).every(x => x.startsWith('$')) ? `${k}.${inner}` : k;
  }).join(', ');
}

// Driver command monitoring: every round trip to Atlas with its server-side +
// network time. Needs monitorCommands: true on the connection (db.js).
const SKIP_COMMANDS = new Set(['hello', 'isMaster', 'ismaster', 'ping', 'saslStart', 'saslContinue', 'endSessions', 'killCursors', 'buildInfo']);
function watchMongo(client) {
  const started = new Map();
  client.on('commandStarted', (e) => {
    if (SKIP_COMMANDS.has(e.commandName)) return;
    if (started.size > 2000) started.clear();   // lost events must not leak
    const c = e.command || {};
    const coll = typeof c[e.commandName] === 'string' ? c[e.commandName] : (c.collection || '');
    const filter = c.filter || c.q || (Array.isArray(c.updates) && c.updates[0]?.q) || (Array.isArray(c.deletes) && c.deletes[0]?.q)
      || (Array.isArray(c.pipeline) && c.pipeline[0]?.$match) || c.query;
    started.set(e.requestId, { key: `${e.commandName} ${coll}`.trim(), filter });
  });
  const end = (failed) => (e) => {
    const s = started.get(e.requestId);
    if (!s) return;
    started.delete(e.requestId);
    add(queries, s.key, e.duration, failed);
    if (e.duration >= SLOW_QUERY_MS) {
      remember(slowQueries, { at: new Date().toISOString(), query: s.key, shape: shapeOf(s.filter), ms: Math.round(e.duration), failed });
    }
  };
  client.on('commandSucceeded', end(false));
  client.on('commandFailed', end(true));
}

const plain = (map) => Object.fromEntries([...map].map(([k, s]) => [k, { ...s, hist: [...s.hist] }]));
const lag = (ns) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);

// The event-loop histogram is the one thing reset per read: lag is a "right
// now" number, and only the dashboard reads it.
function snapshot() {
  const mem = process.memoryUsage();
  const out = {
    bootId, startedAt, now: new Date().toISOString(), bounds: BOUNDS.map(b => (b === Infinity ? null : b)),
    inFlight, routes: plain(routes), queries: plain(queries),
    slowRequests: [...slowRequests], slowQueries: [...slowQueries],
    process: {
      rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576),
      loopP50Ms: lag(loop.percentile(50)), loopP99Ms: lag(loop.percentile(99)), loopMaxMs: lag(loop.max),
      uptimeS: Math.round(process.uptime()),
    },
  };
  loop.reset();
  return out;
}

// Atlas free tier stops writes at 512 MB, and a growing collection is the usual
// reason a query slows down over weeks. dbStats is cheap but not free: cached.
let dbCache = null;
async function dbStats(mongoose) {
  if (dbCache && Date.now() - dbCache.at < 10 * 60_000) return dbCache.value;
  const db = mongoose.connection.db;
  if (!db) return null;
  const s = await db.stats();
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  const counts = await Promise.all(cols.map(async c => [c.name, await db.collection(c.name).estimatedDocumentCount()]));
  const value = {
    dataMb: Math.round(s.dataSize / 1048576 * 10) / 10, storageMb: Math.round(s.storageSize / 1048576 * 10) / 10,
    indexMb: Math.round(s.indexSize / 1048576 * 10) / 10,
    collections: counts.sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, docs]) => ({ name, docs })),
  };
  dbCache = { at: Date.now(), value };
  return value;
}

// Only the dashboard container holds PERF_TOKEN; without it set the endpoint
// does not exist.
function perfEndpoint(mongoose) {
  const token = String(process.env.PERF_TOKEN || '').trim();
  return async (req, res) => {
    const given = String(req.get('x-perf-token') || '');
    if (!token || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return res.status(404).end();
    }
    const snap = snapshot();
    snap.db = await dbStats(mongoose).catch(() => null);
    res.set('Cache-Control', 'no-store').json(snap);
  };
}

module.exports = { trackRequests, watchMongo, perfEndpoint };
