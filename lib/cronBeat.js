/**
 * Records each scheduled call (req.isCron) into models/CronBeat.js when it
 * finishes. Never blocks or fails the request it observes.
 */
const CronBeat = require('../models/CronBeat');
const { notifyAdmins } = require('./notify');

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

// The scheduled jobs and how often each is ASKED for: paths are GitHub workflows,
// `inngest:` names are Inngest crons. Mirrors CRONS in routes/admin.js, which uses
// the same "overdue" rule for the Sending tab.
const SCHEDULE = [
  { name: '/api/check-mailbox', label: 'Mailbox check (GitHub)', everyMin: 5 },
  { name: '/api/campaigns/run-due', label: 'Campaign releases (GitHub)', everyMin: 60 },
  { name: 'inngest:mailbox-sweep', label: 'Mailbox check', everyMin: 120 },
  { name: 'inngest:campaigns-run-due', label: 'Campaign releases', everyMin: 60 },
];
const MIN = 60_000;
const HOUR = 60 * MIN;
const CHECK_EVERY_MS = 10 * MIN;
let lastCheckAt = 0;

/**
 * Tell the admins when a scheduled endpoint has gone quiet. One notification per
 * stall: the key carries the last beat's time, so it repeats only after the
 * scheduler has come back and stalled again. Cheap (one small read, at most once
 * per instance per 10 minutes) and never throws. A beat never seen is skipped —
 * there is no baseline to be overdue against.
 */
async function notifyStalledCrons(now = Date.now()) {
  try {
    if (now - lastCheckAt < CHECK_EVERY_MS) return;
    lastCheckAt = now;
    const beats = await CronBeat.find({}, { name: 1, lastAt: 1 }).lean();
    for (const c of SCHEDULE) {
      const b = beats.find(x => x.name === c.name);
      if (!b || !b.lastAt) continue;
      const lastAt = new Date(b.lastAt).getTime();
      const gap = now - lastAt;
      if (gap <= Math.max(3 * c.everyMin * MIN, 3 * HOUR)) continue;
      await notifyAdmins({
        type: 'admin.cron_stalled', title: `${c.label} has stopped running`,
        body: `Last ran ${Math.round(gap / HOUR)}h ago (asked for every ${c.everyMin} min).`, link: '/admin',
        dedupeKey: `admin.cron_stalled:${c.name}:${lastAt}`,
      });
    }
  } catch (err) {
    console.error('[cron-beat] stall check failed:', err.message);
  }
}

function recordCronBeats(req, res, next) {
  if (!req.isCron) return next();
  const started = Date.now();
  const json = res.json.bind(res);
  let body = null;
  res.json = (b) => { body = b; return json(b); };
  res.on('finish', () => {
    recordBeat(req.originalUrl.split('?')[0], { status: res.statusCode, ms: Date.now() - started, body });
  });
  next();
}

/**
 * One scheduled run finished: `name` is its path, or `inngest:<id>` for an
 * Inngest cron. Never throws.
 */
function recordBeat(name, { status, ms, body }) {
  const now = new Date();
  const ok = status < 400;
  return CronBeat.updateOne(
    { name },
    {
      $set: {
        lastAt: now, lastStatus: status, lastMs: ms,
        lastSummary: summarise(body), ...(ok ? { lastOkAt: now } : {}),
      },
      $push: { recent: { $each: [now], $slice: -KEEP } },
    },
    { upsert: true },
  ).catch(err => console.error('[cron-beat] write failed:', err.message))
    // A live beat is the cheapest moment to notice that a DIFFERENT one has not come.
    .then(() => notifyStalledCrons());
}

module.exports = { recordCronBeats, recordBeat, notifyStalledCrons };
