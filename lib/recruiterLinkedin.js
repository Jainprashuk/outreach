// Finds the LinkedIn profile of a recruiter a job platform named on a job
// (NaukriJob.recruiters). Search-engine results only — LinkedIn is never opened.
//
// Who triggers it is the user's choice (DiscoveryConfig.recruiterLinkedin.modes):
//   manual            the "Find LinkedIn" button (always allowed)
//   approved          a job gets approved, by you or by auto-approve
//   recruiter_action  a recruiter viewed / shortlisted / contacted you on a job
//   all               every job that comes in with a named recruiter
// Automatic runs go through Inngest (never inline in a request), skip anyone who
// already has a link or was already tried, and share one daily cap.

const NaukriJob = require('../models/NaukriJob');
const DiscoveryConfig = require('../models/DiscoveryConfig');
const usage = require('./discovery/usage');
const { findProfile } = require('./discovery/search');
const { inngest } = require('../inngest');
const { fetchJson } = require('./http');
const { nameKey, splitName } = require('./emailPatterns');

const MODES = ['manual', 'approved', 'recruiter_action', 'all'];
const TRIGGERS = ['approved', 'recruiter_action', 'all'];
const MAX_CAP = 200;

/** Clean modes from untrusted input: known values only, 'manual' implied. */
function cleanModes(modes) {
  const set = new Set((Array.isArray(modes) ? modes : []).filter(m => MODES.includes(m)));
  set.add('manual');
  return [...set];
}

/** YYYY-MM-DD in India time, so the cap resets at local midnight. */
const dayKey = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function settingsOf(userId) {
  const doc = await DiscoveryConfig.findOne({ userId }, { recruiterLinkedin: 1 }).lean();
  const rl = (doc && doc.recruiterLinkedin) || {};
  return { modes: cleanModes(rl.modes), dailyCap: Number.isFinite(rl.dailyCap) ? rl.dailyCap : 20 };
}

/** Spend one of today's automatic lookups. Atomic; false when the cap is reached. */
async function takeDaily(userId, cap) {
  const day = dayKey();
  await DiscoveryConfig.updateOne(
    { userId, 'recruiterLinkedin.day': { $ne: day } },
    { $set: { 'recruiterLinkedin.day': day, 'recruiterLinkedin.used': 0 } },
  );
  const r = await DiscoveryConfig.updateOne(
    { userId, 'recruiterLinkedin.day': day, 'recruiterLinkedin.used': { $lt: cap } },
    { $inc: { 'recruiterLinkedin.used': 1 } },
  );
  return r.modifiedCount === 1;
}

/**
 * Who posted a job, from the platform's own public job page data. Instahyre only:
 * its /api/v1/employer_public_jobs/<id> answers without a login and names the
 * recruiter. (Hirist hides the name from anyone logged out, so it can only come
 * from the worker's own session.)
 * @returns {Promise<null | {name: string, title: string, company: string}>}
 */
async function fetchPlatformRecruiter(job) {
  if (job.platform !== 'instahyre' || !/^\d+$/.test(String(job.sourceId || ''))) return null;
  const res = await fetchJson(`https://www.instahyre.com/api/v1/employer_public_jobs/${job.sourceId}`, {
    timeoutMs: 10_000, retries: 1, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  });
  const d = res.ok && res.data;
  const name = d && typeof d.recruiter_name === 'string' ? d.recruiter_name.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  if (!name || !splitName(name)) return null;
  const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  return { name, title: str(d.recruiter_designation).slice(0, 120), company: str(d.recruiter_company_name).slice(0, 120) };
}

/** Make sure a job's recruiter is stored, fetching it from the platform when it can. Returns the recruiters. */
async function ensureRecruiters(userId, jobId) {
  const job = await NaukriJob.findOne({ _id: jobId, userId, deleted: { $ne: true } }, { platform: 1, sourceId: 1, recruiters: 1 }).lean();
  if (!job) return null;
  if ((job.recruiters || []).some(r => r.name)) return job.recruiters;
  const got = await fetchPlatformRecruiter(job);
  if (!got) return job.recruiters || [];
  const rec = { key: `n:${nameKey(got.name)}`, name: got.name, title: got.title, email: '', profileUrl: '', via: 'feed', company: got.company };
  await NaukriJob.updateOne(
    { _id: job._id, userId, 'recruiters.key': { $ne: rec.key } },
    { $push: { recruiters: rec } },
  );
  return [...(job.recruiters || []), rec];
}

/**
 * Look one recruiter up and save the link on them. Marks them tried either way.
 * @returns {Promise<{status: 'found'|'none'|'error'|'exists', linkedin?: string, error?: string}>}
 */
async function lookupRecruiter({ userId, jobId, key }) {
  const job = await NaukriJob.findOne({ _id: jobId, userId, deleted: { $ne: true } }, { company: 1, recruiters: 1 }).lean();
  if (!job) return { status: 'error', error: 'That job wasn’t found' };
  const r = (job.recruiters || []).find(x => x.key === key);
  if (!r) return { status: 'error', error: 'That recruiter wasn’t found' };
  if (r.profileUrl) return { status: 'exists', linkedin: r.profileUrl };
  if (!r.name) return { status: 'error', error: 'This recruiter has no name to search for' };
  // The recruiter's own employer when it is known (an agency), else the hiring company.
  const companyName = r.company || job.company;
  if (!companyName) return { status: 'error', error: 'This job has no company name' };

  const keys = await usage.loadKeys(userId);
  const out = await findProfile({ userId, keys, name: r.name, companyName });
  // A failed search (no key, allowance used up) is not "tried": it can run again.
  if (out.error && !out.profile) return { status: 'error', error: out.error };

  const set = { 'recruiters.$.linkedinTriedAt': new Date() };
  if (out.profile) set['recruiters.$.profileUrl'] = out.profile.linkedin;
  await NaukriJob.updateOne(
    // Never overwrite a link a feed or an earlier run saved in the meantime.
    { _id: job._id, userId, recruiters: { $elemMatch: { key, profileUrl: { $in: [null, ''] } } } },
    { $set: set },
  );
  return out.profile ? { status: 'found', linkedin: out.profile.linkedin } : { status: 'none' };
}

/**
 * A job just reached `trigger`. If the user ticked it (or 'all'), queue a lookup.
 * Safe to call from request handlers: one small read, one event, never throws.
 */
async function queueIfWanted(userId, trigger, jobIds) {
  try {
    if (!TRIGGERS.includes(trigger) || !jobIds || !jobIds.length) return 0;
    const { modes } = await settingsOf(userId);
    if (!modes.includes(trigger) && !modes.includes('all')) return 0;
    await inngest.send(jobIds.slice(0, 100).map(jobId => ({
      name: 'recruiters/linkedin.find', data: { userId: String(userId), jobId: String(jobId), trigger },
    })));
    return jobIds.length;
  } catch (_) { return 0; }
}

const recruiterLinkedinFind = inngest.createFunction(
  {
    id: 'recruiter-linkedin-find',
    retries: 1,
    // One at a time per user: lookups share the free search allowance.
    concurrency: { limit: 1, key: 'event.data.userId' },
    triggers: [{ event: 'recruiters/linkedin.find' }],
  },
  async ({ event, step }) => {
    const { userId, jobId } = event.data;
    return step.run('lookup', async () => {
      const recruiters = await ensureRecruiters(userId, jobId);
      const todo = (recruiters || []).filter(r => r.name && !r.profileUrl && !r.linkedinTriedAt);
      const results = [];
      for (const r of todo) {
        const { dailyCap } = await settingsOf(userId);
        if (!(await takeDaily(userId, dailyCap))) { results.push('cap'); break; }
        const out = await lookupRecruiter({ userId, jobId, key: r.key });
        results.push(out.status);
        if (out.status === 'error') break; // no key / allowance used up: stop here
      }
      return { jobId, results };
    });
  },
);

module.exports = { fetchPlatformRecruiter, ensureRecruiters, MODES, MAX_CAP, cleanModes, settingsOf, lookupRecruiter, queueIfWanted, recruiterLinkedinFind };
