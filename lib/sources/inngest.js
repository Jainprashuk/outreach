// Inngest functions for the automatic Leads sources. Same shape as Discover's
// companies-enrich: a daily cron fans out one event per user who turned the source
// on; the per-user function runs one at a time per user.
//
// Prod needs an Inngest re-sync after deploying these.

const mongoose = require('mongoose');
const { inngest } = require('../../inngest');
const db = require('../../db');
const SourceConfig = require('../../models/SourceConfig');
const run = require('./run');

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};

const usersWith = (field) => SourceConfig.distinct('userId', { [field]: true }).then(ids => ids.map(String));

// ─────────────────────────────────────────────── HN "Who is hiring?"

const sourcesHn = inngest.createFunction(
  {
    id: 'sources-hn',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.userId' },
    triggers: [{ event: 'sources/hn.start' }],
  },
  async ({ event, step }) => {
    const { userId, trigger = 'cron' } = event.data;
    const runId = await step.run('start', async () => {
      await ensureDb();
      const r = await run.startRun(userId, 'hn', trigger);
      return r ? String(r._id) : null;
    });
    if (!runId) return { skipped: 'already running' };
    return step.run('import', async () => {
      await ensureDb();
      try {
        const out = await run.runHn(userId, runId);
        await run.finishRun(runId, { error: out.error || null });
        return out;
      } catch (err) {
        await run.finishRun(runId, { error: err.message });
        throw err;
      }
    });
  },
);

// The thread goes up on the 1st; most posts land in the first few days.
const sourcesHnDaily = inngest.createFunction(
  { id: 'sources-hn-daily', triggers: [{ cron: 'TZ=Asia/Kolkata 0 7 1-10 * *' }] },
  async ({ step }) => {
    const users = await step.run('find-users', async () => { await ensureDb(); return usersWith('hnOn'); });
    if (users.length) await step.sendEvent('fan-out', users.map(userId => ({ name: 'sources/hn.start', data: { userId, trigger: 'cron' } })));
    return { users: users.length };
  },
);

// ─────────────────────────────────────────────── Hiring posts (Tavily)

// One step per search, so a slow search can't push a step past Vercel's limit.
const sourcesWeb = inngest.createFunction(
  {
    id: 'sources-web',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.userId' },
    triggers: [{ event: 'sources/web.start' }],
  },
  async ({ event, step }) => {
    const { userId, trigger = 'cron' } = event.data;
    const plan = await step.run('plan', async () => {
      await ensureDb();
      const r = await run.startRun(userId, 'web', trigger);
      if (!r) return { runId: null, queries: [], error: null };
      const p = await run.planWeb(userId);
      if (p.error) await run.finishRun(r._id, { error: p.error });
      return { runId: String(r._id), queries: p.queries, error: p.error };
    });
    if (!plan.runId) return { skipped: 'already running' };
    if (plan.error) return { error: plan.error };

    let ok = 0;
    let lastError = null;
    for (let i = 0; i < plan.queries.length; i++) {
      const r = await step.run(`search-${i}`, async () => {
        await ensureDb();
        return run.runWebQuery(userId, plan.runId, plan.queries[i]);
      });
      if (r.error) lastError = r.error; else ok++;
      if (r.stop) break; // out of credits or a bad key: the next search would fail the same way
    }
    await step.run('finish', async () => {
      await ensureDb();
      await run.finishRun(plan.runId, { error: ok ? null : lastError });
    });
    return { searches: plan.queries.length, ok, error: ok ? null : lastError };
  },
);

const sourcesWebDaily = inngest.createFunction(
  { id: 'sources-web-daily', triggers: [{ cron: 'TZ=Asia/Kolkata 0 8 * * *' }] },
  async ({ step }) => {
    const users = await step.run('find-users', async () => { await ensureDb(); return usersWith('webOn'); });
    if (users.length) await step.sendEvent('fan-out', users.map(userId => ({ name: 'sources/web.start', data: { userId, trigger: 'cron' } })));
    return { users: users.length };
  },
);

module.exports = { sourcesHn, sourcesHnDaily, sourcesWeb, sourcesWebDaily };
