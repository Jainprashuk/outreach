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
const {
  setupReminderCandidates, inactiveCandidates, weeklyReportCandidates, adminDigestCandidates,
  aiKeyAnnounceCandidates, aiKeyEndedCandidates, usersWithoutAiKeys,
} = require('./candidates');
const { getAiKeysConfig, inGrace } = require('../ai/keys');
const { notify } = require('../notify');
const { deliver } = require('./deliver');
const { notifyStalledCrons } = require('../cronBeat');

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
      // Independent of the lifecycle switch: the scheduler can stall regardless.
      await notifyStalledCrons();
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

// 21:00 IST: the admins' digest of today across every account.
const adminDigestSweep = inngest.createFunction(
  { id: 'lifecycle-admin-digest-sweep', triggers: [{ cron: 'TZ=Asia/Kolkata 0 21 * * *' }] },
  async ({ step }) => {
    const found = await step.run('find-due', async () => {
      await ensureDb();
      const config = await getLifecycleConfig();
      if (!config.enabled) return { paused: true, events: [] };
      return { paused: false, events: toEvents(await adminDigestCandidates(new Date())) };
    });
    if (found.events.length) await step.sendEvent('fan-out', found.events);
    return { paused: found.paused, queued: found.events.length };
  },
);

// Hourly, and right away when an admin changes the AI keys rollout: the two
// AI-key emails (each once per account) and the bell notices at the start and on
// the last day of the grace period. With the rollout off it reads one row and returns.
const istDay = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

const aiKeysSweep = inngest.createFunction(
  { id: 'ai-keys-sweep', concurrency: { limit: 1 }, triggers: [{ cron: 'TZ=Asia/Kolkata 5 * * * *' }, { event: 'ai-keys/sweep' }] },
  async ({ step }) => {
    const found = await step.run('find-due', async () => {
      await ensureDb();
      const cfg = await getAiKeysConfig({ fresh: true });
      if (!cfg.enforce) return { off: true, events: [], bells: 0 };
      const now = new Date();

      let bells = 0;
      if (inGrace(cfg, now)) {
        const lastDay = cfg.graceUntil.getTime() - now.getTime() <= 24 * 3600 * 1000;
        const users = await usersWithoutAiKeys();
        for (const u of users) {
          const r = await notify(u._id, lastDay ? {
            type: 'ai.key_needed',
            title: 'Last day to add your Groq key',
            body: `From ${istDay(cfg.graceUntil)}, AI features need your own free Groq key. About 2 minutes, no card.`,
            link: '/settings',
            dedupeKey: `ai.key_needed:last:${cfg.graceUntil.toISOString()}`,
          } : {
            type: 'ai.key_needed',
            title: 'Add your free Groq key',
            body: `From ${istDay(cfg.graceUntil)}, AI features run on your own free Groq key. About 2 minutes, no card.`,
            link: '/settings',
            dedupeKey: `ai.key_needed:start:${(cfg.enforcedAt || cfg.graceUntil).toISOString()}`,
          });
          if (r) bells++;
        }
      }

      const [announce, ended] = await Promise.all([aiKeyAnnounceCandidates(now, cfg), aiKeyEndedCandidates(now, cfg)]);
      return { off: false, events: toEvents([...announce, ...ended]), bells };
    });
    if (found.events.length) await step.sendEvent('fan-out', found.events);
    return { off: found.off, queued: found.events.length, bells: found.bells };
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

module.exports = { lifecycleDailySweep, weeklyReportSweep, adminDigestSweep, lifecycleDeliver, aiKeysSweep };
