/**
 * Scheduled lifecycle work, on Inngest rather than GitHub Actions: one cron
 * finds who is due and fans out ONE event per email, and a worker sends each in
 * its own function run. That keeps every run far inside Vercel's 60s, isolates
 * one account's failure from the rest, and does not stop firing after 60 days of
 * repo inactivity the way GitHub's scheduler does.
 *
 * The crons fire in every environment the app is synced to. With the master
 * switch off — the state of any database that has never had it turned on —
 * each sweep reads one config row and returns.
 */
const mongoose = require('mongoose');
const { inngest } = require('../../inngest');
const db = require('../../db');
const { getLifecycleConfig } = require('./config');
const { setupReminderCandidates, inactiveCandidates, weeklyReportCandidates } = require('./candidates');
const { deliver } = require('./deliver');

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};

const toEvents = (cands) => cands.map(c => ({
  name: 'lifecycle/deliver',
  data: { type: c.type, userId: String(c.userId), key: c.key },
}));

// 10:00 IST: setup reminders and inactivity nudges.
const lifecycleDailySweep = inngest.createFunction(
  { id: 'lifecycle-daily-sweep', triggers: [{ cron: 'TZ=Asia/Kolkata 0 10 * * *' }] },
  async ({ step }) => {
    const found = await step.run('find-due', async () => {
      await ensureDb();
      const config = await getLifecycleConfig();
      if (!config.enabled) return { paused: true, events: [] };
      const now = new Date();
      const [setup, idle] = await Promise.all([setupReminderCandidates(now), inactiveCandidates(now, config)]);
      return { paused: false, events: toEvents([...setup, ...idle]) };
    });
    if (found.events.length) await step.sendEvent('fan-out', found.events);
    return { paused: found.paused, queued: found.events.length };
  },
);

// Monday 09:00 IST: last week's report.
const weeklyReportSweep = inngest.createFunction(
  { id: 'lifecycle-weekly-report-sweep', triggers: [{ cron: 'TZ=Asia/Kolkata 0 9 * * 1' }] },
  async ({ step }) => {
    const found = await step.run('find-due', async () => {
      await ensureDb();
      const config = await getLifecycleConfig();
      if (!config.enabled) return { paused: true, events: [] };
      return { paused: false, events: toEvents(await weeklyReportCandidates(new Date())) };
    });
    if (found.events.length) await step.sendEvent('fan-out', found.events);
    return { paused: found.paused, queued: found.events.length };
  },
);

// One email per run. Throttled to Resend's default of 2 requests a second.
const lifecycleDeliver = inngest.createFunction(
  {
    id: 'lifecycle-deliver',
    retries: 2,
    concurrency: { limit: 2 },
    throttle: { limit: 2, period: '1s' },
    triggers: [{ event: 'lifecycle/deliver' }],
  },
  async ({ event, step }) => step.run('deliver', async () => {
    await ensureDb();
    return deliver(event.data);
  }),
);

module.exports = { lifecycleDailySweep, weeklyReportSweep, lifecycleDeliver };
