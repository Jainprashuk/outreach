// Runs of the automatic Leads sources (HN, hiring posts), shared by the Inngest
// functions (lib/sources/inngest.js) and nothing else — the route only sends events.
// Each run is one SourceRun row the Leads page reads for its "last run" line.

const mongoose = require('mongoose');
const SourceRun = require('../../models/SourceRun');
const SourceConfig = require('../../models/SourceConfig');
const { notify } = require('../notify');
const { importLeads } = require('../leadImport');
const usage = require('../discovery/usage');
const { postSearch } = require('../discovery/search');
const hn = require('./hn');
const { dropDeadEmails } = require('./paste');
const { buildPostQueries, resultsToLeads } = require('./webPosts');

const asId = (id) => new mongoose.Types.ObjectId(String(id));

/** A run already going for this user + source (not stale), or null. */
async function activeRun(userId, source) {
  return SourceRun.findOne({
    userId: asId(userId), source, status: 'running',
    startedAt: { $gte: new Date(Date.now() - SourceRun.STALE_MS) },
  }).lean();
}

/** Starts a run, or returns null when one is already going. */
async function startRun(userId, source, trigger = 'cron') {
  if (await activeRun(userId, source)) return null;
  // A dead `running` row (timed out mid-way) is closed so the history stays honest.
  await SourceRun.updateMany(
    { userId: asId(userId), source, status: 'running' },
    { $set: { status: 'failed', finishedAt: new Date(), error: 'Stopped before finishing' } },
  );
  return SourceRun.create({ userId: asId(userId), source, trigger });
}

const LABELS = { web: 'Hiring posts', hn: 'HN Who is hiring' };

async function finishRun(runId, { error = null } = {}) {
  const run = await SourceRun.findOneAndUpdate(
    { _id: runId },
    { $set: { status: error ? 'failed' : 'done', finishedAt: new Date(), error } },
    { new: true },
  ).lean();
  if (run) await notifyRun(run);
}

/**
 * The bell, like a LinkedIn scrape: new leads, or a failure. A scheduled run that
 * found nothing new stays quiet — HN re-reads the same thread for ten days and
 * would otherwise ping every morning. "Run now" always answers.
 */
async function notifyRun(run) {
  const label = LABELS[run.source] || run.source;
  if (run.status === 'failed') {
    return notify(run.userId, {
      type: 'sources.failed',
      title: `${label} run failed`,
      body: String(run.error || 'The run did not complete.').split('\n')[0],
      link: '/leads',
      dedupeKey: `sources.failed:${run._id}`,
    });
  }
  if (!run.created && run.trigger !== 'manual') return null;
  const n = run.created || 0;
  return notify(run.userId, {
    type: 'sources.finished',
    title: n ? `${n} new lead${n === 1 ? '' : 's'} from ${label}` : `${label} — no new leads`,
    body: `${run.withEmail} with an email out of ${run.read} read${run.duplicates ? ` · ${run.duplicates} already on your board` : ''}${run.credits ? ` · ${run.credits} Tavily credit${run.credits === 1 ? '' : 's'}` : ''}.`,
    severity: n ? undefined : 'info',
    link: '/leads',
    dedupeKey: `sources.finished:${run._id}`,
  });
}

const target = (cfg) => ({ roles: cfg.roles || [], locations: cfg.locations || [], maxYears: cfg.maxYears });

/** Imports leads and adds the counts to the run. */
async function importInto(runId, userId, leads, counts) {
  const res = leads.length ? await importLeads(leads, { userId: asId(userId) }) : { created: [], skipped: 0 };
  await SourceRun.updateOne({ _id: runId }, {
    $inc: {
      read: counts.read || 0,
      withEmail: counts.withEmail || 0,
      rejected: counts.rejected || 0,
      matched: leads.length,
      created: res.created.length,
      duplicates: res.skipped,
      credits: counts.credits || 0,
    },
  });
  return { created: res.created.length, duplicates: res.skipped };
}

/** HN: the newest thread, in one go (one Algolia request, no AI). */
async function runHn(userId, runId) {
  const cfg = await SourceConfig.getForUser(asId(userId));
  const thread = await hn.latestThread();
  if (!thread) return { error: 'No "Who is hiring?" thread found this month' };
  await SourceRun.updateOne({ _id: runId }, { $set: { label: thread.title } });
  const res = await hn.threadPosts(thread.id);
  if (!res.ok) return { error: res.error };
  const out = hn.postsToLeads(res.posts, target(cfg));
  const checked = await dropDeadEmails(out.leads, { keepLinks: true });
  const imported = await importInto(runId, userId, checked.leads, out);
  return { thread: thread.title, ...imported };
}

/** Hiring posts, step 1: today's searches. An error string when it can't run. */
async function planWeb(userId) {
  const cfg = await SourceConfig.getForUser(asId(userId));
  if (!cfg.roles || !cfg.roles.length) return { error: 'Add the roles you want first', queries: [] };
  const keys = await usage.loadKeys(asId(userId));
  if (!keys.tavily && !keys.serpapi) return { error: 'No search key — add a free Tavily key in Settings', queries: [] };
  return { error: null, queries: buildPostQueries(target(cfg), cfg.webPerDay || 6) };
}

/** Hiring posts, step 2: one search → leads. Returns an error only for this query. */
async function runWebQuery(userId, runId, query) {
  const uid = asId(userId);
  const [cfg, keys] = await Promise.all([SourceConfig.getForUser(uid), usage.loadKeys(uid)]);
  const res = await postSearch({ userId: uid, keys, query });
  await SourceRun.updateOne({ _id: runId }, { $push: { queries: query } });
  if (!res.ok) {
    await SourceRun.updateOne({ _id: runId }, { $inc: { credits: res.credits } });
    return { error: res.error, stop: /allowance|rejected the key|No search key/.test(res.error || '') };
  }
  const out = await resultsToLeads(res.results, { userId: uid, target: target(cfg), query });
  const imported = await importInto(runId, userId, out.leads, { ...out, credits: res.credits });
  return { error: null, ...imported };
}

module.exports = { startRun, finishRun, activeRun, runHn, planWeb, runWebQuery, asId };
