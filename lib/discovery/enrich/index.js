// Outside signals for the "Worth searching" shortlist, fetched in the background and
// cached in CompanySignal. The suggestions list only ever reads the cache, so it
// never waits on (or breaks because of) an outside service.
//
// Two stages keep the calls few: only the strongest candidates on the app's OWN
// signals (companyWorth.pickCandidates, at most 25) are looked up, and each source's
// answer is reused until it goes stale. A source that fails is stored as `error`,
// which adds 0 points and is retried the next day.

const mongoose = require('mongoose');
const { inngest } = require('../../../inngest');
const db = require('../../../db');
const CompanySignal = require('../../../models/CompanySignal');
const CompanyPattern = require('../../../models/CompanyPattern');
const DiscoveryConfig = require('../../../models/DiscoveryConfig');
const NaukriConfig = require('../../../models/NaukriConfig');
const NaukriJob = require('../../../models/NaukriJob');
const Lead = require('../../../models/Lead');
const { deadline } = require('../../http');
const usage = require('../usage');
const worth = require('../companyWorth');
const { familyOf } = require('../jobRoles');
const { checkNews } = require('./news');
const { checkHn } = require('./hn');
const { checkCareers } = require('./careers');
const { checkGithub } = require('./github');
const { checkFit } = require('./fit');
const { sleep } = require('./match');

const DAY = 24 * 3600 * 1000;
const STEP_BUDGET_MS = 40_000;

// shared: the same answer for every user, cached once (userId null).
const SOURCES = {
  news:    { shared: true,  ttl: 7 * DAY },
  hn:      { shared: true,  ttl: 7 * DAY },
  github:  { shared: true,  ttl: 14 * DAY },
  careers: { shared: false, ttl: 14 * DAY }, // "roles like yours" depends on you
  fit:     { shared: false, ttl: 14 * DAY },
};
const ERROR_TTL = DAY;

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};
const asId = (id) => new mongoose.Types.ObjectId(String(id));

/** Sources you switched off in Discover settings. */
async function sourcesFor(userId) {
  const cfg = await DiscoveryConfig.findOne({ userId: asId(userId) }, { enrichOff: 1 }).lean();
  const off = new Set((cfg && cfg.enrichOff) || []);
  return Object.keys(SOURCES).filter(s => !off.has(s));
}

/** What you're looking for: your Naukri search keywords, default roles, and the jobs you approved. */
async function targetsFor(userId) {
  const uid = asId(userId);
  const [cfg, ncfg, jobs] = await Promise.all([
    DiscoveryConfig.findOne({ userId: uid }, { defaultRoles: 1 }).lean(),
    NaukriConfig.findOne({ userId: uid }, { searches: 1 }).lean(),
    NaukriJob.find({ userId: uid, deleted: { $ne: true }, $or: [{ approval: 'approved' }, { applyStatus: { $ne: 'none' } }] }, { title: 1 })
      .sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const terms = [
    ...((ncfg && ncfg.searches) || []).filter(s => s.enabled !== false).flatMap(s => String(s.keywords || '').split(',')),
    ...((cfg && cfg.defaultRoles) || []),
  ].map(t => t.trim().toLowerCase()).filter(t => t.length >= 3);
  const families = [...new Set([...terms, ...jobs.map(j => j.title)].map(familyOf).filter(Boolean))];
  return { terms: [...new Set(terms)].slice(0, 12), families };
}

/** Is this cached answer still good? */
function fresh(row, source, now = Date.now()) {
  if (!row) return false;
  const ttl = row.status === 'error' ? ERROR_TTL : SOURCES[source].ttl;
  return now - new Date(row.checkedAt).getTime() < ttl;
}

/** Look one company up in every enabled source that has nothing fresh cached. */
async function enrichOne(userId, cand, ctx) {
  const key = worth.signalKey(cand);
  const uid = asId(userId);
  const cached = await CompanySignal.find({ key, $or: [{ userId: null }, { userId: uid }] }).lean();
  const have = (source) => cached.find(r => r.source === source && String(r.userId || '') === (SOURCES[source].shared ? '' : String(uid)));

  const budget = deadline(STEP_BUDGET_MS);
  const run = {
    news: () => checkNews(cand, { signal: budget.signal }),
    hn: () => checkHn(cand, { signal: budget.signal }),
    github: () => checkGithub(cand, { token: ctx.githubToken, knownOrg: ctx.orgs.get(cand.domain) || null, signal: budget.signal }),
    careers: () => checkCareers(cand, { ...ctx.targets, signal: budget.signal }),
    fit: () => checkFit(cand, { targets: [...ctx.targets.terms, ...ctx.targets.families], userId: uid, signal: budget.signal }),
  };
  const todo = ctx.sources.filter(s => !fresh(have(s), s));
  // Different hosts per source, so they can run side by side; each source is still
  // asked about one company at a time.
  const results = await Promise.all(todo.map(async (source) => {
    let r;
    try { r = await run[source](); } catch (err) { r = { status: 'error', points: 0, reasons: [], note: `${source} check failed` }; }
    if (budget.expired() && r.status !== 'ok') r = { status: 'error', points: 0, reasons: [], note: `${source} check timed out` };
    return [source, r];
  }));

  const now = new Date();
  const ops = results.map(([source, r]) => ({
    updateOne: {
      filter: { key, source, userId: SOURCES[source].shared ? null : uid },
      update: { $set: {
        status: r.status,
        points: r.status === 'ok' ? Number(r.points) || 0 : 0,
        reasons: (r.reasons || []).slice(0, 3),
        note: String(r.note || '').slice(0, 200),
        checkedAt: now,
      } },
      upsert: true,
    },
  }));
  if (ops.length) await CompanySignal.bulkWrite(ops, { ordered: false });
  return { key, checked: todo, results: Object.fromEntries(results.map(([s, r]) => [s, r.status])) };
}

/** Everything enrichOne needs that's the same for all of one user's companies. */
async function contextFor(userId) {
  const uid = asId(userId);
  const [sources, targets, keys, patterns] = await Promise.all([
    sourcesFor(uid),
    targetsFor(uid),
    usage.loadKeys(uid),
    CompanyPattern.find({ userId: uid, githubOrg: { $ne: null } }, { domain: 1, githubOrg: 1 }).lean(),
  ]);
  return { sources, targets, githubToken: keys.github || '', orgs: new Map(patterns.map(p => [p.domain, p.githubOrg])) };
}

/** The companies to look up for one user, strongest first. */
async function candidatesFor(userId) {
  const scored = await worth.scoredCompanies(userId);
  return worth.pickCandidates(scored).map(c => ({ key: c.key, company: c.company, domain: c.domain }));
}

// ─────────────────────────────────────────────── Inngest

// One run per user at a time: the companies are looked up one per step, so a slow
// website can't push a step past Vercel's limit.
const companiesEnrich = inngest.createFunction(
  {
    id: 'companies-enrich',
    retries: 1,
    concurrency: { limit: 1, key: 'event.data.userId' },
    triggers: [{ event: 'companies/enrich.start' }],
  },
  async ({ event, step }) => {
    const { userId } = event.data;
    const cands = await step.run('candidates', async () => { await ensureDb(); return candidatesFor(userId); });
    let checked = 0;
    for (const cand of cands) {
      const r = await step.run(`company-${cand.key}`, async () => {
        await ensureDb();
        const out = await enrichOne(userId, cand, await contextFor(userId));
        await sleep(1000); // at most one lookup per source per second
        return out;
      });
      if (r.checked.length) checked++;
    }
    return { candidates: cands.length, checked };
  },
);

// Daily, for everyone with something to rank: Leads or Naukri activity this month.
const companiesEnrichDaily = inngest.createFunction(
  { id: 'companies-enrich-daily', triggers: [{ cron: 'TZ=Asia/Kolkata 0 6 * * *' }] },
  async ({ step }) => {
    const users = await step.run('find-users', async () => {
      await ensureDb();
      const since = new Date(Date.now() - 30 * DAY);
      const [a, b] = await Promise.all([
        Lead.distinct('userId', { createdAt: { $gte: since }, deleted: { $ne: true } }),
        NaukriJob.distinct('userId', { createdAt: { $gte: since }, deleted: { $ne: true } }),
      ]);
      return [...new Set([...a, ...b].filter(Boolean).map(String))];
    });
    if (users.length) await step.sendEvent('fan-out', users.map(userId => ({ name: 'companies/enrich.start', data: { userId } })));
    return { users: users.length };
  },
);

module.exports = { companiesEnrich, companiesEnrichDaily, enrichOne, contextFor, candidatesFor, targetsFor, fresh, SOURCES };
