/**
 * POST /api/issues — the browser reporting something that broke on its side: a
 * render crash, an uncaught error, or a request that never reached us (so the
 * server-side capture in lib/issues.js could not see it). Any signed-in user may
 * call it; only the admin can read the result.
 */
const express = require('express');
const { reportIssue } = require('../lib/issues');

const router = express.Router();

const KINDS = new Set(['js_error', 'unhandled_rejection', 'render_crash', 'network_error']);
const PER_USER_PER_MIN = 30;
const counts = new Map();   // userId -> { start, n }

router.post('/', (req, res) => {
  // Reporting is not something the user did; keep it out of their Logs page.
  req.skipAudit = true;

  const key = String(req.userId);
  const now = Date.now();
  const c = counts.get(key);
  if (!c || now - c.start > 60_000) counts.set(key, { start: now, n: 1 });
  else if (++c.n > PER_USER_PER_MIN) return res.status(202).json({ ok: true, dropped: true });

  const b = req.body || {};
  const kind = KINDS.has(b.kind) ? b.kind : 'js_error';
  reportIssue({
    userId: req.userId,
    source: 'client',
    area: typeof b.area === 'string' && b.area ? b.area : 'browser',
    kind,
    message: b.message,
    detail: b.stack,
    meta: {
      page: b.page,
      ...(b.url ? { url: b.url } : {}),
      ...(b.method ? { method: b.method } : {}),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    },
  });
  res.status(202).json({ ok: true });
});

module.exports = router;
