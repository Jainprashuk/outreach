/**
 * The admin's Issues tab: one place that collects everything that went wrong
 * for anybody. See models/Issue.js for what a row is.
 *
 * reportIssue() NEVER throws and never awaits anything the caller depends on —
 * recording a failure must not be able to cause a second one. Call it without
 * awaiting, from a catch block, after the real error handling has happened.
 */
const crypto = require('crypto');
const Issue = require('../models/Issue');
const { notifyAdmins } = require('./notify');

const MESSAGE_MAX = 2000;
const DETAIL_MAX = 8000;
const META_MAX = 4000;

// A burst of the same failure in one instance (a widget polling a dead job, a
// send storm) is one row bumped later, not one write per occurrence.
const COALESCE_MS = 15_000;
// Hard ceiling per instance, so a failure loop cannot turn into a write loop.
const MAX_WRITES_PER_MIN = 120;

const recent = new Map();   // fingerprint -> { at, pending }
let windowStart = Date.now();
let windowWrites = 0;

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

// Variable parts out, so "Email failed for a@x.com" and "… for b@y.com" are
// the same issue. Only the fingerprint is normalised — the stored text is raw.
const normalise = (s) => String(s || '')
  .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '<email>')
  .replace(/\b[a-f0-9]{24}\b/gi, '<id>')
  .replace(/\b[a-f0-9-]{32,}\b/gi, '<hash>')
  .replace(/\d+/g, '<n>')
  .slice(0, 300);

const fingerprintOf = ({ userId, source, area, kind, message, key }) => crypto
  .createHash('sha1')
  .update([userId ? String(userId) : '-', source, area, kind, key || normalise(message)].join('|'))
  .digest('hex');

// Credentials are never stored, whatever the request carried.
const SECRET_KEY = /pass(word)?|secret|token|^code$|otp|authorization|cookie|apikey|api_key/i;
function scrub(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 500) : value;
}

const capMeta = (meta) => {
  const clean = scrub(meta || {});
  try {
    return JSON.stringify(clean).length > META_MAX ? { truncated: JSON.stringify(clean).slice(0, META_MAX) } : clean;
  } catch (_) {
    return {};
  }
};

async function write(doc, fingerprint, extra) {
  const now = new Date();
  const res = await Issue.updateOne(
    { fingerprint, status: 'open' },
    {
      $set: { message: doc.message, detail: doc.detail, meta: doc.meta, lastSeenAt: now },
      $inc: { count: 1 + extra },
      $setOnInsert: {
        userId: doc.userId, source: doc.source, area: doc.area, kind: doc.kind,
        firstSeenAt: now, resolvedAt: null,
      },
    },
    { upsert: true },
  );
  // Only a brand-new open row tells the admins; count bumps stay quiet. Server
  // faults and background jobs only — validation and browser noise is not worth
  // a bell. Awaited so a serverless freeze cannot drop it; notifyAdmins never throws.
  if (res.upsertedId && (doc.source === 'server' || doc.source === 'job')) {
    await notifyAdmins({
      type: 'admin.issue', title: `New issue: ${doc.area} — ${doc.kind}`,
      body: String(doc.message).replace(/[\r\n]+/g, ' ').trim().slice(0, 200), link: '/admin',
      dedupeKey: `admin.issue:${res.upsertedId}`,
    });
  }
}

/**
 * @param {object} p
 * @param {*}      p.userId   the affected account, or null when there is none
 * @param {string} p.source   'server' | 'validation' | 'job' | 'client'
 * @param {string} p.area     where: 'contacts', 'email', 'scrape' …
 * @param {string} p.kind     what: 'http_500', 'send_failed' …
 * @param {string} p.message  the raw error text
 * @param {string} [p.detail] stack trace or full upstream response
 * @param {object} [p.meta]   anything else useful; credential-looking keys are redacted
 * @param {string} [p.key]    groups by this instead of the normalised message
 */
function reportIssue(p) {
  try {
    const doc = {
      userId: p.userId || null,
      source: p.source,
      area: str(p.area || 'unknown', 60),
      kind: str(p.kind || 'error', 60),
      message: str(p.message || 'Unknown error', MESSAGE_MAX) || 'Unknown error',
      detail: str(p.detail, DETAIL_MAX),
      meta: capMeta(p.meta),
    };
    const fingerprint = fingerprintOf({ ...doc, key: p.key });

    const now = Date.now();
    const seen = recent.get(fingerprint);
    if (seen && now - seen.at < COALESCE_MS) { seen.pending++; return Promise.resolve(); }

    if (now - windowStart > 60_000) { windowStart = now; windowWrites = 0; }
    if (++windowWrites > MAX_WRITES_PER_MIN) return Promise.resolve();

    const extra = seen ? seen.pending : 0;
    recent.set(fingerprint, { at: now, pending: 0 });
    if (recent.size > 2000) recent.delete(recent.keys().next().value);

    return write(doc, fingerprint, extra)
      .catch(err => console.error('[issues] write failed:', err.message));
  } catch (err) {
    console.error('[issues] report failed:', err.message);
    return Promise.resolve();
  }
}

/** `/contacts/123/send` -> `contacts` */
const areaOf = (path) => (String(path || '').replace(/^\/(api\/)?/, '').split(/[/?]/)[0] || 'api');

/**
 * Every /api response with a 4xx or 5xx becomes an issue. Mounted before the
 * routers so it sees them all; it reads req.userId when the response FINISHES,
 * by which point attachUser has set it.
 *
 * Not recorded:
 *  - 401: a signed-out browser or an expired session, not a fault.
 *  - 4xx with no account and outside /auth: bots and probes.
 *  - The Inngest endpoint (its own retry protocol) and the client-report
 *    endpoint itself (a failure there would report itself).
 */
function captureHttpIssues(req, res, next) {
  if (req.path.startsWith('/inngest') || req.path.startsWith('/issues')) return next();

  const json = res.json.bind(res);
  res.json = (body) => { res.locals.issueBody = body; return json(body); };

  res.on('finish', () => {
    const status = res.statusCode;
    if (status < 400 || status === 401) return;
    const isAuth = req.path.startsWith('/auth');
    if (status < 500 && !req.userId && !isAuth) return;

    const body = res.locals.issueBody;
    const said = (body && (body.error || body.message)) || `HTTP ${status}`;
    const shown = typeof said === 'string' ? said : JSON.stringify(said);
    // The route PATTERN, so /contacts/abc and /contacts/def are one issue.
    // No matched route (an unknown path): ids out of the URL instead.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : normalise(req.originalUrl.split('?')[0]);
    // Set by handlers whose response hides the real cause behind a generic line.
    const err = res.locals.issueError;
    const message = err && err.message && !shown.includes(err.message) ? `${shown} — ${err.message}` : shown;

    reportIssue({
      userId: req.userId || null,
      source: status >= 500 ? 'server' : 'validation',
      area: areaOf(req.originalUrl),
      kind: `http_${status}`,
      message,
      detail: err && err.stack ? err.stack : '',
      key: `${req.method} ${route} ${status} ${normalise(message)}`,
      meta: {
        method: req.method,
        url: req.originalUrl,
        route,
        statusCode: status,
        ...(body && typeof body === 'object' && body.code ? { code: body.code } : {}),
        ...(req.method !== 'GET' && req.body && Object.keys(req.body).length ? { body: req.body } : {}),
        ...(isAuth || req.isCron ? { caller: req.isCron ? 'cron' : 'sign-in' } : {}),
        userAgent: str(req.headers['user-agent'], 200),
      },
    });
  });
  next();
}

module.exports = { reportIssue, captureHttpIssues };
