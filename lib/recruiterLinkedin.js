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

// Platforms whose worker can read who posted a job (meta.recruiterDetail), for
// the jobs the server cannot read itself.
const WORKER_PLATFORMS = ['instahyre', 'hirist', 'wellfound'];

const decodeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/**
 * Wellfound's job page is public and server-rendered. Its "Hiring contact"
 * heading is followed by the name and then the title — a plain span logged
 * out, a /u/<slug> link logged in — so the first two pieces of text after the
 * heading are read, whatever wraps them (verified both shapes 2026-11-03). Pure.
 * @returns {null | {name: string, title: string, company: string}}
 */
function wellfoundRecruiterFromHtml(html) {
  const s = String(html || '');
  const m = />\s*Hiring contact\s*</i.exec(s);
  if (!m) return null;
  const after = s.slice(m.index + m[0].length - 1, m.index + 3000);
  const texts = [...after.matchAll(/>([^<>]+)</g)].map(x => decodeHtml(x[1])).filter(Boolean);
  const name = (texts[0] || '').slice(0, 100);
  if (!name || !splitName(name)) return null;
  const title = texts[1] && texts[1].length < 80 ? texts[1] : '';
  return { name, title, company: '' };
}

/**
 * Who posted a job, from the platform's own PUBLIC data, read by the server:
 * Instahyre's /api/v1/employer_public_jobs/<id>, Wellfound's job page. Hirist
 * hides the name from anyone logged out, so it only comes from the worker.
 * @returns {Promise<null | {name: string, title: string, company: string}>}
 */
async function fetchPlatformRecruiter(job) {
  if (job.platform === 'wellfound') {
    if (!/^https:\/\/wellfound\.com\/jobs\//.test(String(job.url || ''))) return null;
    try {
      const res = await fetch(job.url, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' },
      });
      // A Cloudflare challenge (403/503) is not "nobody": the worker can still read it.
      return res.ok ? wellfoundRecruiterFromHtml(await res.text()) : null;
    } catch (_) { return null; }
  }
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

/**
 * Make sure a job's recruiter is stored. The server reads public data itself;
 * when it can't (Hirist, or a Wellfound page behind a challenge) and `queue` is
 * set, the job is handed to the platform worker for its next idle check-in.
 * @returns {Promise<null | {recruiters: object[], queued: boolean}>}
 */
async function ensureRecruiters(userId, jobId, { queue = false } = {}) {
  const job = await NaukriJob.findOne({ _id: jobId, userId, deleted: { $ne: true } },
    { platform: 1, sourceId: 1, url: 1, recruiters: 1, recruiterWantedAt: 1 }).lean();
  if (!job) return null;
  if ((job.recruiters || []).some(r => r.name)) return { recruiters: job.recruiters, queued: false };
  const got = await fetchPlatformRecruiter(job);
  if (got) {
    const rec = { key: `n:${nameKey(got.name)}`, name: got.name, title: got.title, email: '', profileUrl: '', via: 'feed', company: got.company };
    await NaukriJob.updateOne(
      { _id: job._id, userId, 'recruiters.key': { $ne: rec.key } },
      { $push: { recruiters: rec }, $set: { recruiterFetchedAt: new Date(), recruiterWantedAt: null } },
    );
    return { recruiters: [...(job.recruiters || []), rec], queued: false };
  }
  if (queue && WORKER_PLATFORMS.includes(job.platform)) {
    if (!job.recruiterWantedAt) await NaukriJob.updateOne({ _id: job._id, userId }, { $set: { recruiterWantedAt: new Date() } });
    return { recruiters: job.recruiters || [], queued: true };
  }
  return { recruiters: job.recruiters || [], queued: false };
}

/**
 * Hand every older job with no recruiter on these platforms to the worker
 * (found in the last `days`). Returns how many were queued.
 */
async function queueBackfill(userId, platforms, { days = 60, max = 500 } = {}) {
  const list = platforms.filter(p => WORKER_PLATFORMS.includes(p));
  if (!list.length) return 0;
  const since = new Date(Date.now() - days * 86400000);
  const rows = await NaukriJob.find({
    userId, platform: { $in: list }, deleted: { $ne: true },
    recruiterWantedAt: null, recruiterFetchedAt: null,
    'recruiters.name': { $nin: [/./] },
    $or: [{ firstSeenAt: { $gte: since } }, { createdAt: { $gte: since } }],
  }, { _id: 1 }).sort({ createdAt: -1 }).limit(max).lean();
  if (!rows.length) return 0;
  const r = await NaukriJob.updateMany({ _id: { $in: rows.map(x => x._id) }, userId }, { $set: { recruiterWantedAt: new Date() } });
  return r.modifiedCount;
}

/** The jobs a worker on `platform` should read now (oldest ask first). */
async function wantedFor(userId, platform, limit = 30) {
  if (!WORKER_PLATFORMS.includes(platform)) return [];
  const rows = await NaukriJob.find({ userId, platform, recruiterWantedAt: { $ne: null }, deleted: { $ne: true } },
    { sourceId: 1, url: 1 }).sort({ recruiterWantedAt: 1 }).limit(limit).lean();
  return rows.map(r => ({ sourceId: r.sourceId, url: r.url || '' }));
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
      const got = await ensureRecruiters(userId, jobId, { queue: true });
      const todo = ((got && got.recruiters) || []).filter(r => r.name && !r.profileUrl && !r.linkedinTriedAt);
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

module.exports = { fetchPlatformRecruiter, wellfoundRecruiterFromHtml, ensureRecruiters, queueBackfill, wantedFor, WORKER_PLATFORMS, MODES, MAX_CAP, cleanModes, settingsOf, lookupRecruiter, queueIfWanted, recruiterLinkedinFind };
