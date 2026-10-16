/**
 * The hourly campaign release, on Inngest rather than GitHub Actions. GitHub ran
 * the hourly workflow about 5 times a day, at UTC :05 (IST :35) when it did, and
 * stops scheduling after 60 days of repo inactivity. This fires at IST :01, so a
 * campaign due at 10:00 IST goes out at 10:01.
 *
 * runDueCampaigns() is the same function POST /api/campaigns/run-due calls. Both
 * schedulers can fire in the same hour: claimCampaign() takes each campaign with
 * one atomic findOneAndUpdate on releaseLockAt + lastReleaseOn, so the second run
 * finds nothing due and releases nothing.
 */
const mongoose = require('mongoose');
const { inngest } = require('../../inngest');
const db = require('../../db');
const { runDueCampaigns } = require('../campaignRunner');
const { checkWorkersOffline } = require('../workerWatch');
const { recordBeat } = require('../cronBeat');

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};

// A run that defers campaigns (its 45s budget ran out) hands the rest straight
// to a follow-up run instead of leaving them for the next hour. Every run starts
// at least one campaign, so the chain ends; the cap is a backstop.
const MAX_ROUNDS = 6;

const campaignsRunDue = inngest.createFunction(
  {
    id: 'campaigns-run-due',
    // One at a time across every user: runDueCampaigns is SEQUENTIAL by design
    // (lib/campaignRunner.js) and two overlapping runs would only contend.
    concurrency: { limit: 1 },
    retries: 1,
    triggers: [
      { cron: 'TZ=Asia/Kolkata 1 * * * *' },
      { event: 'campaigns/run-due.continue' },
    ],
  },
  async ({ event, step }) => {
    const round = Number(event?.data?.round) || 0;

    const report = await step.run('release', async () => {
      await ensureDb();
      const started = Date.now();
      try {
        const r = await runDueCampaigns({ trigger: 'cron' });
        // The hourly fleet-wide tick is also where a quiet scrape/Naukri worker is
        // noticed (it was the GitHub run-due call's job). In this step, not its
        // own: each step is a separate function call. Never throws.
        if (round === 0) await checkWorkersOffline().catch(err => console.error('workerWatch failed:', err.message));
        await recordBeat('inngest:campaigns-run-due', { status: 200, ms: Date.now() - started, body: r });
        // Only what this function needs; the full report is in the beat summary
        // and the campaign's own release history.
        return { deferred: r.deferred.length, totals: r.totals };
      } catch (err) {
        await recordBeat('inngest:campaigns-run-due', { status: 500, ms: Date.now() - started, body: { error: err.message } });
        throw err;
      }
    });

    if (report.deferred > 0 && round + 1 < MAX_ROUNDS) {
      await step.sendEvent('continue', { name: 'campaigns/run-due.continue', data: { round: round + 1 } });
    }

    return { round, ...report };
  },
);

module.exports = { campaignsRunDue };
