/**
 * Records each scheduled call (req.isCron) into models/CronBeat.js when it
 * finishes. Never blocks or fails the request it observes.
 */
const CronBeat = require('../models/CronBeat');

const KEEP = 400;   // > a day of 5-minute fires

// Only numbers survive into the summary: the bodies list per-account results.
const summarise = (body) => {
  if (!body || typeof body !== 'object') return null;
  const src = body.totals && typeof body.totals === 'object' ? body.totals : body;
  const out = {};
  for (const [k, v] of Object.entries(src)) if (typeof v === 'number') out[k] = v;
  if (typeof body.error === 'string') out.error = body.error.slice(0, 300);
  return Object.keys(out).length ? out : null;
};

function recordCronBeats(req, res, next) {
  if (!req.isCron) return next();
  const started = Date.now();
  const json = res.json.bind(res);
  let body = null;
  res.json = (b) => { body = b; return json(b); };
  res.on('finish', () => {
    const now = new Date();
    const ok = res.statusCode < 400;
    CronBeat.updateOne(
      { name: req.originalUrl.split('?')[0] },
      {
        $set: {
          lastAt: now, lastStatus: res.statusCode, lastMs: Date.now() - started,
          lastSummary: summarise(body), ...(ok ? { lastOkAt: now } : {}),
        },
        $push: { recent: { $each: [now], $slice: -KEEP } },
      },
      { upsert: true },
    ).catch(err => console.error('[cron-beat] write failed:', err.message));
  });
  next();
}

module.exports = { recordCronBeats };
