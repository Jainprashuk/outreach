const NaukriRun = require('../models/NaukriRun');
const { reportIssue } = require('./issues');

const STALE_RUN_MS = 30 * 60_000;
const ERROR = 'Worker stopped responding mid-run';

/** Mark runs with no recent progress failed. A userId scopes cleanup to one account. */
async function failStaleNaukriRuns(userId = null) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const filter = {
    status: 'running',
    claimedAt: { $lt: cutoff },
    $or: [{ 'progress.updatedAt': null }, { 'progress.updatedAt': { $lt: cutoff } }],
    deleted: { $ne: true },
  };
  if (userId) filter.userId = userId;

  const candidates = await NaukriRun.find(filter, { _id: 1, userId: 1, claimedAt: 1 }).lean();
  if (!candidates.length) return { failed: 0, cutoff };

  const ids = candidates.map(run => run._id);
  const result = await NaukriRun.updateMany(
    { ...filter, _id: { $in: ids } },
    { $set: { status: 'failed', error: ERROR, finishedAt: now } },
  );
  if (!result.modifiedCount) return { failed: 0, cutoff };

  const changed = await NaukriRun.find(
    { _id: { $in: ids }, status: 'failed', error: ERROR, finishedAt: now },
    { _id: 1, userId: 1, claimedAt: 1 },
  ).lean().catch(() => []);
  for (const run of changed) {
    reportIssue({
      userId: run.userId, source: 'job', area: 'naukri', kind: 'run_stalled',
      message: `${ERROR} — the run was marked failed`,
      meta: { runId: String(run._id), claimedAt: run.claimedAt || null },
    });
  }
  return { failed: result.modifiedCount, cutoff };
}

module.exports = { failStaleNaukriRuns, STALE_RUN_MS };
