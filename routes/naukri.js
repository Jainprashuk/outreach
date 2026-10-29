const mongoose = require('mongoose');
const express = require('express');
const multer = require('multer');
const NaukriRun = require('../models/NaukriRun');
const NaukriJob = require('../models/NaukriJob');
const NaukriConfig = require('../models/NaukriConfig');
const NaukriWorker = require('../models/NaukriWorker');
const ProspectSearch = require('../models/ProspectSearch');
const Prospect = require('../models/Prospect');
const Contact = require('../models/Contact');
const Settings = require('../models/Settings');
const { dueSlot, nextSlot, upcomingSlots, slotsOf, startOfDayIn, parseTime, MAX_SLOTS } = require('../lib/naukriSchedule');
const { resolveAnswer, matchable, STARTER_RULES, similarRules } = require('../lib/naukriAnswers');
const { scoreJob } = require('../lib/naukriScore');
// Called through the module object (naukriDraft.draftAnswer), not a
// destructured copy, so the end-to-end test can swap in a scripted AI.
const naukriDraft = require('../lib/naukriDraft');
const applyNote = require('../lib/applyNote');
const { applyFilters, parseSalaryLpa, parsePostedAgeDays, cityVariants } = require('../lib/naukriFilters');
const { reportIssue } = require('../lib/issues');
const { failStaleNaukriRuns: failStaleRuns } = require('../lib/staleNaukriRuns');
const { notify } = require('../lib/notify');
const { WORKER_OFFLINE_MS, workerBack } = require('../lib/workerWatch');
const { inPortal } = require('../lib/portalPresence');
const {
  isPlatform, labelOf, capabilitiesOf, platformQuery, platformOfDoc, siteOf, applyModeOf,
  kindBlocked, isEnabled, publicRegistry, PLATFORM_IDS, SITE_FIELDS,
} = require('../lib/platforms');
const { dupKeyOf, dupesFor, dupText, blocksAuto, blocksApply } = require('../lib/jobDupes');
const { recruitersFor, MAX_RECRUITERS } = require('../lib/recruiterContacts');

// mergeParams: the same router is mounted at /api/naukri (Naukri) and at
// /api/p/:platform (every platform), and reads the platform from req.platform.
const router = express.Router({ mergeParams: true });

// Which platform this request is about. server.js sets req.platform with
// withPlatform(); a router mounted bare (the test harnesses) is Naukri, as it
// always was. 'all' is the All platforms view: read-only lists and counts.
router.use((req, res, next) => {
  const p = req.platform || (req.params && req.params.platform) || 'naukri';
  if (p !== 'all' && !isPlatform(p)) return res.status(404).json({ error: `Unknown platform: ${p}` });
  req.platform = p;
  // Job-level writes carry ids, so they work from the All view too.
  const jobPath = /^\/jobs(\/|$)/.test(req.path);
  if (p === 'all' && !ALL_OK.has(`${req.method} ${req.path}`) && !jobPath) {
    return res.status(400).json({ error: 'Pick a platform for this — the All platforms view only lists jobs.' });
  }
  next();
});
// What the All platforms view may call. Everything else needs one platform.
const ALL_OK = new Set([
  'GET /jobs', 'GET /jobs/outreach', 'POST /jobs/decide', 'GET /activity', 'GET /needs-answer',
  'POST /needs-answer/draft', 'POST /needs-answer/use', 'POST /needs-answer/auto', 'POST /needs-answer/ignore',
  'GET /config/unknown-questions', 'POST /config/test-answer', 'GET /platforms', 'GET /runs', 'GET /analytics', 'GET /counts',
  'POST /config/starter-rules', 'POST /config/profile-from-resume', 'GET /resume',
  // Shared settings only (the PATCH refuses any one platform's own fields).
  'GET /config', 'PATCH /config', 'POST /resume', 'DELETE /resume',
]);
// What the All view's PATCH /config may change: settings every platform shares.
const SHARED_KEYS = new Set(['profile', 'answers', 'autoAnswer', 'aiDrafts', 'onUnknownQuestion', 'resumeText', 'duplicates', 'crossPlatformOrder']);
// A row with its platform, for rows from before the field existed.
const PQ = (req) => platformQuery(req.platform);
const LABEL = (req) => labelOf(req.platform === 'all' ? 'naukri' : req.platform);
// Links in notifications open the page on the right platform.
const pageLink = (platform) => (platform && platform !== 'naukri' ? `/naukri?platform=${platform}` : '/naukri');

const BASE_FILTER = { deleted: { $ne: true } };
const ACTIVE = ['queued', 'running'];
const KINDS = ['refresh', 'harvest', 'apply', 'probe', 'track'];
const { queueOrder, tidyReason, readStatus, STAGE_RANK } = require('../lib/naukriQueue');
const { profileFromResume } = require('../lib/naukriProfile');

// A worker polls every 20s; 90s of silence means the Mac slept or the process died.
const ONLINE_MS = 90_000;
// A worker that understands check-in hints (it sends `hints: true`) is told when
// to come back: fast while there is work or its owner is in the portal, else at
// the next scheduled run or after IDLE_POLL_SECONDS. Three workers per user
// checking in every 20s were ~390k requests a month — most of the hosting
// plan's free allowance for one person.
const IDLE_POLL_SECONDS = 300;
// A running run whose worker reported progress (or claimed it) recently.
// Generous on purpose: the slowest single step, a job with live AI answers, is
// about 3 minutes; failStaleRuns gives up only after 30 minutes without progress.
const RUN_ALIVE_MS = 5 * 60_000;
const runIsAlive = (run) => !!run && run.status === 'running'
  && Date.now() - new Date((run.progress && run.progress.updatedAt) || run.claimedAt || 0).getTime() < RUN_ALIVE_MS;
// Online = seen within the interval it was last told, plus a margin; never
// less than ONLINE_MS, so a worker that ignores hints reads exactly as before.
const isOnline = (w) => !!(w && w.lastSeenAt)
  && Date.now() - new Date(w.lastSeenAt).getTime() < Math.max(ONLINE_MS, (w.pollHintSeconds || 0) * 1000 + 60_000);
// A claimed run whose worker vanished mid-flight: nothing from it — no
// progress, no result — for this long. Measured from its LAST sign of life,
// not from when it started, so a long run that is still working is never cut
// off now that run size has no ceiling. Every job and every page posts
// progress; the slowest single step (a job with live AI answers) is ~3 min.
// Naukri showed a captcha. Same doctrine as the LinkedIn checkpoint: stop for a
// week, and do not let a worker restart shrug it off.
const BLOCK_MS = 7 * 24 * 3600 * 1000;

// The statuses that mean an application actually left, plus where it got to
// afterwards. Deliberately excludes 'skipped' and 'failed': those are jobs the
// worker looked at and backed out of, so listing them under "Applied" claims
// work that never happened. They remain visible in Waiting, which is where you
// can act on them.
const SENT_STATUSES = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];

// Skips no future run can turn into an application, and the company-site one.
const { TERMINAL_SKIP, EXTERNAL_SKIP } = require('../lib/naukriReasons');
const { naukriAnalytics } = require('../lib/naukriAnalytics');

// "Approved and still queued to be sent", in ONE place.
//
// It was written out twice — once for the tab's count, once implied by the
// list's query — and the two drifted: the badge said 55 while the list's own
// chips totalled 259, because the list asked only for `approval: 'approved'`
// and counted everything ever approved, applied and skipped included. A number
// that disagrees with the list under it is worse than no number.
const WAITING_FILTER = {
  approval: 'approved',
  applyStatus: { $in: ['none', 'failed'] },
  retryable: { $ne: false },
};

// The sub-lists of Skipped, defined once so each chip's count and its list agree.
const SKIP_BUCKETS = {
  // approval ≠ rejected: before 'dismissed' existed, Dismiss only rejected the
  // job and left it 'skipped', so those rows still sat in these lists.
  'needs-answer': { applyStatus: 'skipped', approval: { $ne: 'rejected' }, unknownQuestion: { $nin: [null, ''] } },
  'company-site': { applyStatus: 'skipped', approval: { $ne: 'rejected' }, applyNote: EXTERNAL_SKIP },
  'other-skipped': {
    applyStatus: 'skipped', approval: { $ne: 'rejected' },
    unknownQuestion: { $in: [null, ''] }, applyNote: { $not: EXTERNAL_SKIP },
  },
};
const ALL_SKIPPED = { applyStatus: 'skipped', approval: { $ne: 'rejected' } };

// Jobs blocked on a screening question go back to Waiting the moment a rule
// answers it — and not before. Called whenever the answer bank changes, so
// "answer it once" is all it ever takes. Returns how many moved.
//
// Across EVERY platform: the answer bank is shared, so a rule saved from the
// Instahyre page frees a Naukri job that asked the same thing. `platforms`, when
// given, collects which platforms had jobs freed.
async function requeueAnswered(userId, config, platforms = null) {
  const blocked = await NaukriJob.find(
    { userId, approval: 'approved', ...SKIP_BUCKETS['needs-answer'], ...BASE_FILTER },
    { unknownQuestion: 1, applyNote: 1, platform: 1 },
  ).lean();
  const bank = { answers: config.answers, profile: config.profile };
  const ready = blocked.filter(j => resolveAnswer(j.unknownQuestion, bank).matched);
  if (!ready.length) return 0;
  if (platforms) for (const j of ready) platforms.add(platformOfDoc(j));
  const now = new Date();
  for (const j of ready) {
    await NaukriJob.updateOne({ _id: j._id, userId, applyStatus: 'skipped' }, {
      $set: { applyStatus: 'none', retryable: true, priority: 1, applyNote: '', unknownQuestion: '', questionOptions: [] },
      $push: { applyHistory: { at: now, from: 'skipped', to: 'none', note: `answer added for: ${String(j.unknownQuestion).slice(0, 300)}` } },
    });
  }
  return ready.length;
}


const RESUME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!RESUME_TYPES.has(file.mimetype)) {
      return cb(new Error('Resume must be a PDF or Word document.'));
    }
    cb(null, true);
  },
});

const serialize = (doc) => {
  if (!doc) return null;
  const obj = { ...doc };
  obj.platform = platformOfDoc(doc);
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

// Aggregations do not cast like find() does.
const oidOf = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);

const cleanList = (input, limit = 50, max = 200) => {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const v = str(raw, max).replace(/\s+/g, ' ');
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out.slice(0, limit);
};

const num = (v, { min = null, max = null, integer = false } = {}) => {
  if (v === null || v === '') return null;
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (integer) n = Math.round(n);
  if (min != null) n = Math.max(min, n);
  if (max != null) n = Math.min(max, n);
  return n;
};

// { searches, recommended } with at least one on, or null. `fallback` fills
// any key the input leaves out.
const cleanSources = (input, fallback = {}) => {
  if (!input || typeof input !== 'object') return null;
  const TABS = ['apply', 'profile', 'preference', 'similar_jobs'];
  const tabs = Array.isArray(input.recommendedTabs)
    ? [...new Set(input.recommendedTabs.filter(t => TABS.includes(t)))]
    : (Array.isArray(fallback.recommendedTabs) && fallback.recommendedTabs.length ? [...fallback.recommendedTabs] : TABS);
  const out = {
    searches: input.searches !== undefined ? !!input.searches : fallback.searches !== false,
    recommended: input.recommended !== undefined ? !!input.recommended : !!fallback.recommended,
    recommendedTabs: tabs.length ? tabs : TABS,
  };
  return out.searches || out.recommended ? out : null;
};

// When a hint-aware worker should check in next, in seconds. Fast (its own
// check-in interval, default 20s) while this platform has a run queued or
// running, or its owner is in the portal — so "Run now" starts within seconds.
// Otherwise at the next scheduled run (a few seconds after, so it is due), or
// after IDLE_POLL_SECONDS, whichever comes first. Remembered on the worker so
// "online" can allow for it (isOnline).
async function nextPollFor(userId, platform, config, worker, fastSeconds, fast) {
  let secs = IDLE_POLL_SECONDS;
  if (fast
    || await NaukriRun.exists({ userId, status: { $in: ACTIVE }, ...platformQuery(platform), ...BASE_FILTER })
    || await inPortal(userId)) {
    secs = fastSeconds;
  } else {
    const next = nextSlot(config.schedule, new Date());
    if (next) secs = Math.min(secs, Math.max(fastSeconds, Math.ceil((next.at.getTime() - Date.now()) / 1000) + 5));
  }
  if (worker.pollHintSeconds !== secs) {
    await NaukriWorker.updateOne({ _id: worker._id }, { $set: { pollHintSeconds: secs } }).catch(() => {});
  }
  return secs;
}

const blockedUntilOf = (worker) => {
  const until = worker && worker.blockedUntil ? new Date(worker.blockedUntil) : null;
  return until && until > new Date() ? until : null;
};

// How many applications have gone out since midnight in YOUR timezone (the
// schedule's), for apply.maxPerDay. The server runs in UTC, and counting from
// its midnight reset the cap at 05:30 IST. Counted from NaukriJob rather than
// summed off run stats, because the jobs are the thing that actually left — a
// failed run that applied to three before dying still spent three.
const appliedToday = (userId, timeZone, platform = 'naukri') => {
  let since;
  try { since = startOfDayIn(timeZone || 'Asia/Kolkata'); }
  catch (_) { since = new Date(); since.setHours(0, 0, 0, 0); }
  // Per platform: each one has its own daily limit.
  return NaukriJob.countDocuments({ userId, appliedAt: { $gte: since }, ...platformQuery(platform), ...BASE_FILTER });
};

// Schedule facts the tab shows, in one shape for /overview and /config.
const scheduleView = (schedule) => {
  const now = new Date();
  const next = nextSlot(schedule, now);
  return {
    nextOccurrence: next ? next.at : null,
    scheduleKinds: next ? next.kinds : [],
    upcoming: upcomingSlots(schedule, now, 5).map(o => ({ at: o.at, kinds: o.kinds })),
  };
};

// ── Inbox tidy ─────────────────────────────────────────────────────────────
// Clears jobs nobody will apply to out of the review queue, by the rules in
// Configuration → Filters (lib/naukriQueue.js tidyReason). They become
// 'rejected' with the reason; Restore puts one back for good. Runs after every
// harvest and whenever the rules are saved. Returns how many were cleared.
async function tidyInbox(userId, config, platform = 'naukri') {
  const rules = siteOf(config, platform).inboxTidy || {};
  if (!rules.enabled) return 0;
  const pending = await NaukriJob.find(
    { userId, approval: 'pending', applyStatus: 'none', tidyExempt: { $ne: true }, ...platformQuery(platform), ...BASE_FILTER },
    { postedAt: 1, postedText: 1, lastSeenAt: 1, score: 1, likelyExternal: 1, tidyExempt: 1 },
  ).lean();
  const now = new Date();
  let n = 0;
  for (const j of pending) {
    const why = tidyReason(j, rules, now);
    if (!why) continue;
    await NaukriJob.updateOne({ _id: j._id, approval: 'pending' }, {
      $set: { approval: 'rejected', rejectedReason: `Tidied: ${why}`, tidiedAt: now, tidyReason: why },
    });
    n++;
  }
  return n;
}

// ── Results: what recruiters did ───────────────────────────────────────────
// Over applications sent in the last `days`, from the daily track run: how
// many were viewed, shortlisted, contacted — overall, by where the job came
// from, and by fit score — so you can see what is actually working.
async function resultsSummary(userId, days = 30, platform = 'naukri') {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await NaukriJob.find(
    { userId, appliedAt: { $gte: since }, ...platformQuery(platform), ...BASE_FILTER },
    { naukriStage: 1, origins: 1, score: 1, trackedAt: 1 },
  ).lean();
  const tally = (list) => {
    const t = { sent: list.length, viewed: 0, shortlisted: 0, contacted: 0, notShortlisted: 0 };
    for (const r of list) {
      const st = r.naukriStage;
      if (st && STAGE_RANK[st] >= STAGE_RANK.viewed) t.viewed++;
      if (st === 'shortlisted') t.shortlisted++;
      if (st === 'contacted') t.contacted++;
      if (st === 'not-shortlisted') t.notShortlisted++;
    }
    return t;
  };
  const isRec = (r) => (r.origins || []).includes('recommended');
  const band = (r) => (r.score == null ? 'unscored' : r.score >= 75 ? '75+' : r.score >= 50 ? '50-74' : 'under 50');
  const byBand = {};
  for (const b of ['75+', '50-74', 'under 50', 'unscored']) byBand[b] = tally(rows.filter(r => band(r) === b));
  const lastTracked = rows.reduce((m, r) => (r.trackedAt && (!m || r.trackedAt > m) ? r.trackedAt : m), null);
  return {
    days, ...tally(rows), lastTracked,
    bySource: { search: tally(rows.filter(r => !isRec(r))), recommended: tally(rows.filter(isRec)) },
    byScore: byBand,
  };
}

// ── Setup progress ─────────────────────────────────────────────────────────
// What a new (or half-set-up) account still needs, each with the card that
// fixes it. Every item is something that changes results, not busywork.
async function setupChecklist(userId, config, worker, platform = 'naukri') {
  const eff = await effectiveResume(userId, config);
  const text = await resumeTextFor(userId, config);
  const p = config.profile || {};
  const site = siteOf(config, platform);
  const label = labelOf(platform);
  const slots = slotsOf(site.schedule);
  const answers = (config.answers || []).filter(a => a.enabled !== false);
  const src = site.sources || {};
  // Resume and profile are set once and used by every platform.
  const shared = ' (shared by all platforms)';
  const items = [
    { key: 'worker', card: null, label: `Worker running and logged in to ${label}`,
      done: !!(worker && worker.lastSeenAt && (worker.loggedIn || worker.naukriLoggedIn)),
      hint: `Start the worker on your computer (see the Guide) and log in to ${label} in the debug Chrome, or ask your admin to host it in the cloud.` },
    { key: 'resume', card: 'resume', label: `Resume with readable text${shared}`,
      done: !!(eff && text && text.trim().length > 200),
      hint: 'Upload a PDF resume in Settings (or paste its text in Resume & headline) — AI answers and your profile come from it.' },
    { key: 'profile', card: 'profile', label: `Profile: skills, experience, CTC, notice period${shared}`,
      done: (p.skills || []).length >= 3 && p.totalExperienceMonths != null && p.expectedCtcLpa != null && p.noticePeriodDays != null,
      hint: 'Use "Fill from resume", then add CTC and notice period. Skills and years drive the fit score.' },
    { key: 'sources', card: 'searches', label: 'Where to find jobs: searches or Recommended',
      done: (site.searches || []).some(s => s.enabled !== false && (s.keywords || s.url)) || !!src.recommended,
      hint: `Add a search or two${capabilitiesOf(platform) && src ? `, or tick ${label}'s recommended jobs` : ''}.` },
    { key: 'answers', card: 'answers', label: 'Common screening answers',
      done: answers.length >= 5,
      hint: 'Press "Add common rules" in Answers — notice period, CTC, experience, location in one go.' },
    { key: 'schedule', card: 'schedule', label: applyModeOf(site, platform) === 'off' ? 'Daily schedule that harvests' : 'Daily schedule that applies',
      done: !!site.schedule.enabled && slots.some(s => s.kinds.includes(applyModeOf(site, platform) === 'off' ? 'harvest' : 'apply')),
      hint: 'Turn on the schedule with Apply ticked — a second apply time (e.g. 14:00) gets fresh jobs out the same day.' },
    { key: 'autoAnswer', card: 'answers', label: 'AI answers screening questions it is sure of',
      done: !!(config.autoAnswer && config.autoAnswer.enabled),
      hint: 'Turn on "Let AI answer during apply" in Answers so fewer jobs stop on a question.' },
    { key: 'tidy', card: 'filters', label: 'Inbox tidies itself',
      done: !!(site.inboxTidy && site.inboxTidy.enabled),
      hint: 'Turn on inbox tidy in Filters so old and poor-fit jobs clear themselves away.' },
  ];
  // Wellfound's apply form can ask questions (verified 2026-10-28), so it keeps
  // the answers items. Instahyre and Hirist apply in one click — no screening questions (verified
  // 2026-10-21) — so answers and AI answers do nothing there, and inbox tidy
  // is a nicety, not setup. Their list is only what changes results.
  const list = (platform === 'naukri' || platform === 'wellfound') ? items : items.filter(i => !['answers', 'autoAnswer', 'tidy'].includes(i.key));
  return { items: list, done: list.filter(i => i.done).length, total: list.length };
}

// ── Owner endpoints ────────────────────────────────────────────────────────
// IMPORTANT: literal paths are declared before any /:id route, or Express
// matches them as an id.

// GET /api/naukri/analytics?days=30 — Analytics → Naukri (lib/naukriAnalytics.js).
router.get('/analytics', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    res.json(await naukriAnalytics(req.userId, { days, platform: req.platform }));
  } catch (err) {
    console.error('[naukri] analytics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/naukri/overview — one call drives the whole tab. The worker fields
// exist so the UI can say "your Mac is asleep, this runs at 09:25" BEFORE you
// trigger anything, rather than leaving a queued row looking broken.
router.get('/overview', async (req, res) => {
  try {
    res.json(await overviewFor(req.userId, req.platform));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/p/:platform/platforms — every platform at a glance, for the
// switcher, the All platforms view and the Action Center: each one's overview
// (the same object /overview returns) plus whether it is switched on.
router.get('/platforms', async (req, res) => {
  try {
    await failStaleRuns(req.userId);
    const config = await NaukriConfig.getForUser(req.userId);
    const out = [];
    for (const id of PLATFORM_IDS) {
      const site = siteOf(config, id);
      const enabled = isEnabled(site, id);
      const reg = publicRegistry().find(r => r.id === id);
      out.push({ ...reg, enabled, overview: enabled ? await overviewFor(req.userId, id, { config, light: true }) : null });
    }
    res.json({
      platforms: out,
      duplicates: config.duplicates,
      crossPlatformOrder: !!config.crossPlatformOrder,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/p/:platform/counts?range=today|yesterday|7d|30d — found / applied /
// skipped / failed in a window, per platform, for the Job Platforms cards'
// date filter. Days start at midnight in the schedule's timezone (IST by
// default), like the daily apply limit; 7d and 30d are rolling, matching the
// "this week" numbers /overview has always shown. From the All view it answers
// for every switched-on platform at once.
const COUNT_RANGES = ['today', 'yesterday', '7d', '30d'];
function rangeWindow(range, timeZone) {
  const now = new Date();
  let today;
  try { today = startOfDayIn(timeZone || 'Asia/Kolkata', now); } catch (_) { today = new Date(now); today.setHours(0, 0, 0, 0); }
  if (range === 'today') return { from: today, to: now };
  if (range === 'yesterday') return { from: new Date(today.getTime() - 86400000), to: today };
  return { from: new Date(now.getTime() - (range === '30d' ? 30 : 7) * 86400000), to: now };
}
async function countsFor(userId, platform, config) {
  const pq = platformQuery(platform);
  const { from, to } = config.__window;
  const [outcomes, found] = await Promise.all([
    NaukriJob.aggregate([
      { $match: { userId: oidOf(userId), 'applyHistory.at': { $gte: from, $lt: to }, ...pq, deleted: { $ne: true } } },
      { $unwind: '$applyHistory' },
      { $match: { 'applyHistory.at': { $gte: from, $lt: to }, 'applyHistory.to': { $in: ['applied', 'skipped', 'failed'] } } },
      { $group: { _id: '$applyHistory.to', n: { $sum: 1 } } },
    ]),
    NaukriJob.countDocuments({ userId, firstSeenAt: { $gte: from, $lt: to }, ...pq, ...BASE_FILTER }),
  ]);
  const of = (k) => (outcomes.find(o => o._id === k) || {}).n || 0;
  return { found, applied: of('applied'), skipped: of('skipped'), failed: of('failed') };
}
router.get('/counts', async (req, res) => {
  try {
    const range = COUNT_RANGES.includes(req.query.range) ? req.query.range : '7d';
    const config = await NaukriConfig.getForUser(req.userId);
    const ids = req.platform === 'all' ? PLATFORM_IDS.filter(id => isEnabled(siteOf(config, id), id)) : [req.platform];
    const tz = siteOf(config, ids[0] || 'naukri').schedule.timezone;
    const win = rangeWindow(range, tz);
    const counts = {};
    for (const id of ids) counts[id] = await countsFor(req.userId, id, { __window: win });
    res.json({ range, from: win.from, to: win.to, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One platform's overview. `light` skips the setup checklist and the results
// summary, which only the platform's own page shows.
async function overviewFor(userId, platform, { config: given = null, light = false } = {}) {
  const pq = platformQuery(platform);
  if (!given) await failStaleRuns(userId);
  const config = given || await NaukriConfig.getForUser(userId);
  const site = siteOf(config, platform);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [worker, activeRun, queued, history, reviewCount, appliedCount, todayCount, waitingCount, skippedCount, needsAnswerCount, week, foundWeek] = await Promise.all([
    NaukriWorker.getForUser(userId, platform),
    NaukriRun.findOne({ userId, status: 'running', ...pq, ...BASE_FILTER }).sort({ createdAt: 1 }).lean(),
    NaukriRun.find({ userId, status: 'queued', ...pq, ...BASE_FILTER }).sort({ createdAt: 1 }).limit(10).lean(),
    NaukriRun.find({ userId, status: { $nin: ACTIVE }, ...pq, ...BASE_FILTER }).sort({ createdAt: -1 }).limit(light ? 5 : 20).lean(),
    NaukriJob.countDocuments({ userId, approval: 'pending', ...pq, ...BASE_FILTER }),
    NaukriJob.countDocuments({ userId, applyStatus: { $in: SENT_STATUSES }, ...pq, ...BASE_FILTER }),
    appliedToday(userId, site.schedule.timezone, platform),
    // Approved and genuinely queued to be sent. Deliberately excludes skips:
    // those have been looked at and backed out of, which is a different state
    // with a different next action, and mixing them made "138 waiting" mean
    // two unrelated things at once. They have their own tab.
    //
    // Appended LAST, matching the destructuring above. Adding a query in the
    // middle silently shifts every position after it — that is how the panel
    // once reported the waiting count as "applied today".
    NaukriJob.countDocuments({ userId, ...WAITING_FILTER, ...pq, ...BASE_FILTER }),
    NaukriJob.countDocuments({ userId, ...ALL_SKIPPED, ...pq, ...BASE_FILTER }),
    NaukriJob.countDocuments({ userId, ...SKIP_BUCKETS['needs-answer'], ...pq, ...BASE_FILTER }),
    // This week's outcomes, from the history entries the worker writes as it
    // goes — so a job retried twice counts as what it ended up as each time,
    // not as whatever it is now.
    NaukriJob.aggregate([
      { $match: { userId: oidOf(userId), 'applyHistory.at': { $gte: weekAgo }, ...pq, deleted: { $ne: true } } },
      { $unwind: '$applyHistory' },
      { $match: { 'applyHistory.at': { $gte: weekAgo }, 'applyHistory.to': { $in: ['applied', 'skipped', 'failed'] } } },
      { $group: { _id: '$applyHistory.to', n: { $sum: 1 } } },
    ]),
    // New jobs found this week, for the All platforms cards.
    NaukriJob.countDocuments({ userId, firstSeenAt: { $gte: weekAgo }, ...pq, ...BASE_FILTER }),
  ]);
  const weekOf = (k) => (week.find(w => w._id === k) || {}).n || 0;
  const mode = applyModeOf(site, platform);

  const lastSeenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt) : null;
  return {
    platform,
    label: labelOf(platform),
    capabilities: capabilitiesOf(platform),
    enabled: isEnabled(site, platform),
    applyMode: mode,
    readOnlySince: site.readOnlySince || null,
    foundThisWeek: foundWeek,
    activeRun: serialize(activeRun),
    queuedRuns: queued.map(serialize),
    history: history.map(serialize),
    worker: {
      everSeen: !!lastSeenAt,
      // A worker in the middle of a run doesn't check in — it reports progress
      // on the run instead — so a run that reported recently means it is there.
      online: isOnline(worker) || runIsAlive(activeRun),
      lastSeenAt,
      host: worker.host || '',
      chromeUp: !!worker.chromeUp,
      naukriLoggedIn: !!(worker.loggedIn || worker.naukriLoggedIn),
      loggedIn: !!(worker.loggedIn || worker.naukriLoggedIn),
      nextWakeAt: worker.nextWakeAt || null,
    },
    schedule: site.schedule,
    ...scheduleView(site.schedule),
    reviewCount,
    needsAnswerCount,
    week: { applied: weekOf('applied'), skipped: weekOf('skipped'), failed: weekOf('failed') },
    perRun: site.apply.maxPerRun,
    perDay: site.apply.maxPerDay,
    sources: site.sources,
    // What still needs setting up, and what recruiters did with what was sent.
    setup: light ? null : await setupChecklist(userId, config, worker, platform),
    results: light ? null : await resultsSummary(userId, 30, platform),
    inboxTidy: site.inboxTidy,
    appliedCount,
    appliedToday: todayCount,
    waitingCount,
    skippedCount,
    // Surfaced separately from the config blob so the header can warn about
    // them without the client having to know which fields mean "unsafe".
    paused: !!site.safety.pauseAll,
    dryRun: mode === 'dry-run',
    autoApprove: !!site.apply.autoApproveEnabled,
    blockedUntil: blockedUntilOf(worker),
    blockedReason: worker.blockedReason || '',
  };
}

// ── Configuration ──────────────────────────────────────────────────────────

// The config as one platform sees it: its own settings at the top level, where
// the Naukri page has always read them, plus the shared ones. Naukri's view is
// the document as it was, with the platform facts added.
function configView(config, platformIn) {
  // The All view sees the shared settings; its own-settings fields are Naukri's
  // and are never written through it (SHARED_KEYS).
  const platform = platformIn === 'all' ? 'naukri' : platformIn;
  const json = config.toJSON();
  if (platform !== 'naukri') {
    const own = (json.platforms && json.platforms[platform]) || {};
    for (const k of SITE_FIELDS) if (own[k] !== undefined) json[k] = own[k];
    // Naukri-only: other sites do not rank on profile recency.
    json.headlineVariants = [];
  }
  const site = siteOf(config, platform);
  json.platform = platformIn;
  json.label = platformIn === 'all' ? 'All platforms' : labelOf(platform);
  json.capabilities = capabilitiesOf(platform);
  json.enabled = isEnabled(site, platform);
  json.applyMode = applyModeOf(site, platform);
  json.readOnlySince = site.readOnlySince || null;
  return json;
}

router.get('/config', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const [eff, text] = await Promise.all([effectiveResume(req.userId, config), resumeTextFor(req.userId, config)]);
    const json = configView(config, req.platform);
    const site = siteOf(config, req.platform);
    // The resume the card shows is the one Naukri will USE — the Settings one
    // when no Naukri-only file was uploaded.
    json.resume = eff
      ? { filename: eff.filename, size: eff.size, uploadedAt: eff.uploadedAt, source: eff.source, text }
      : { filename: '', size: 0, uploadedAt: null, source: null, text };
    res.json({
      config: json,
      ...scheduleView(site.schedule),
      resume: eff ? { filename: eff.filename, size: eff.size, uploadedAt: eff.uploadedAt, source: eff.source } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/naukri/config — partial save. Each config card sends only its own
// section, so two cards open at once cannot clobber each other's fields.
router.patch('/config', async (req, res) => {
  try {
    const body = req.body || {};
    if (req.platform === 'all') {
      const own = Object.keys(body).filter(k => !SHARED_KEYS.has(k));
      if (own.length) return res.status(400).json({ error: `Pick a platform to change ${own.join(', ')} — those are set per platform.` });
    }
    const config = await NaukriConfig.getForUser(req.userId);
    // Settings for THIS platform go to its own section (Naukri: the top level,
    // as always); profile, resume, answers and AI settings are shared.
    const site = siteOf(config, req.platform);
    const label = LABEL(req);

    if (body.enabled !== undefined) {
      site.enabled = !!body.enabled;
      if (site.enabled && !site.readOnlySince && applyModeOf(site, req.platform) === 'off') site.readOnlySince = new Date();
    }
    if (body.applyMode !== undefined) {
      const mode = String(body.applyMode);
      if (!['off', 'dry-run', 'on'].includes(mode)) return res.status(400).json({ error: 'applyMode must be off, dry-run or on' });
      const caps = capabilitiesOf(req.platform);
      if (mode === 'on' && !caps.apply) {
        return res.status(400).json({ error: `Real apply on ${label} isn't verified yet — use Dry run until it is.` });
      }
      if (mode === 'dry-run' && !caps.dryRun) return res.status(400).json({ error: `${label} has no apply step yet.` });
      const before = applyModeOf(site, req.platform);
      if (req.platform === 'naukri') {
        // Naukri keeps safety.dryRun as its switch; applyMode only says "off".
        site.applyMode = mode === 'off' ? 'off' : null;
        if (mode !== 'off') site.safety.dryRun = mode === 'dry-run';
      } else {
        site.applyMode = mode;
      }
      if (mode === 'off' && before !== 'off') site.readOnlySince = new Date();
      if (mode !== 'off') site.readOnlySince = null;
    }
    if (body.duplicates) {
      const d = body.duplicates;
      if (d.windowDays !== undefined) config.duplicates.windowDays = num(d.windowDays, { min: 7, max: 180, integer: true }) ?? 60;
      if (d.blockAuto !== undefined) config.duplicates.blockAuto = !!d.blockAuto;
      if (d.blockApply !== undefined) config.duplicates.blockApply = !!d.blockApply;
    }
    if (body.crossPlatformOrder !== undefined) config.crossPlatformOrder = !!body.crossPlatformOrder;

    if (body.schedule) {
      const s = body.schedule;
      if (s.time !== undefined) {
        if (!parseTime(s.time)) return res.status(400).json({ error: 'time must be HH:mm' });
        site.schedule.time = str(s.time, 5);
      }
      if (s.days !== undefined) {
        const clean = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))]
          .filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
        if (!clean.length) return res.status(400).json({ error: 'Pick at least one day' });
        site.schedule.days = clean;
      }
      if (s.timezone !== undefined) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(s.timezone) }); }
        catch (_) { return res.status(400).json({ error: `Unknown timezone: ${s.timezone}` }); }
        site.schedule.timezone = String(s.timezone);
      }
      if (s.catchUpHours !== undefined) {
        const n = num(s.catchUpHours, { min: 0, max: 12 });
        if (n == null) return res.status(400).json({ error: 'catchUpHours must be between 0 and 12' });
        site.schedule.catchUpHours = n;
      }
      for (const k of ['runRefresh', 'runHarvest', 'runApply', 'runTrack']) {
        if (s[k] !== undefined) site.schedule[k] = !!s[k];
      }
      // Slots 2 and 3. Each needs a valid time and at least one kind, and no
      // two slots may share a time — that would fire the same wake twice.
      if (s.extraSlots !== undefined) {
        const raw = Array.isArray(s.extraSlots) ? s.extraSlots : [];
        if (raw.length > MAX_SLOTS - 1) return res.status(400).json({ error: `At most ${MAX_SLOTS} times a day` });
        const seen = new Set([site.schedule.time]);
        const clean = [];
        for (const x of raw) {
          const time = str(x && x.time, 5);
          if (!parseTime(time)) return res.status(400).json({ error: `Each time must be HH:mm (got "${time}")` });
          if (seen.has(time)) return res.status(400).json({ error: `${time} is listed twice` });
          seen.add(time);
          const slot = { time, runRefresh: !!(x && x.runRefresh), runHarvest: !!(x && x.runHarvest), runApply: !!(x && x.runApply), runTrack: !!(x && x.runTrack) };
          if (!slot.runRefresh && !slot.runHarvest && !slot.runApply && !slot.runTrack) {
            return res.status(400).json({ error: `The ${time} slot has nothing to do — tick refresh, harvest or apply` });
          }
          clean.push(slot);
        }
        site.schedule.extraSlots = clean;
      }
      // A tick for a step this platform cannot do is dropped, not saved: the
      // schedule must never ask a worker for a run it has no driver for.
      const caps = capabilitiesOf(req.platform);
      if (!caps.refresh) site.schedule.runRefresh = false;
      if (!caps.track) site.schedule.runTrack = false;
      if (!caps.harvest) site.schedule.runHarvest = false;
      if (!caps.refresh || !caps.track) {
        for (const x of site.schedule.extraSlots || []) {
          if (!caps.refresh) x.runRefresh = false;
          if (!caps.track) x.runTrack = false;
        }
      }
      if (s.enabled !== undefined) {
        if (s.enabled && slotsOf({ ...site.schedule.toObject(), ...s, extraSlots: site.schedule.extraSlots }).length === 0) {
          return res.status(400).json({ error: 'Turn on at least one of refresh, harvest or apply' });
        }
        site.schedule.enabled = !!s.enabled;
        // Turning the schedule on must not immediately fire an occurrence from
        // earlier today — that would spend the day's budget the instant you
        // saved the form.
        if (s.enabled) site.schedule.lastFiredAt = new Date();
      }
    }

    if (body.searches !== undefined) {
      site.searches = (Array.isArray(body.searches) ? body.searches : []).slice(0, 20).map(s => ({
        label:    str(s && s.label, 100),
        keywords: str(s && s.keywords, 200),
        location: str(s && s.location, 100),
        experienceYears: num(s && s.experienceYears, { min: 0, max: 50, integer: true }),
        url:      str(s && s.url, 1000),
        enabled:  s && s.enabled !== false,
      })).filter(s => s.keywords || s.url);
    }
    if (body.useRecommended !== undefined) site.useRecommended = !!body.useRecommended;
    if (body.sources) {
      const next = cleanSources(body.sources, site.sources);
      if (!next) return res.status(400).json({ error: 'Pick at least one place to harvest from: your searches or recommended jobs' });
      site.sources = next;
    }
    if (body.searchLimits) {
      const l = body.searchLimits;
      if (l.maxSearches !== undefined) site.searchLimits.maxSearches = num(l.maxSearches, { min: 1, max: 10, integer: true }) ?? 10;
      if (l.maxPages !== undefined) site.searchLimits.maxPages = num(l.maxPages, { min: 1, max: 8, integer: true }) ?? 8;
    }
    if (body.worker && body.worker.pollSeconds !== undefined) {
      site.worker.pollSeconds = num(body.worker.pollSeconds, { min: 15, max: 120, integer: true }) ?? 20;
    }
    if (body.aiDrafts !== undefined) config.aiDrafts = !!body.aiDrafts;
    let tidyChanged = false;
    if (body.inboxTidy) {
      const t = body.inboxTidy;
      if (t.enabled !== undefined) site.inboxTidy.enabled = !!t.enabled;
      if (t.maxAgeDays !== undefined) site.inboxTidy.maxAgeDays = num(t.maxAgeDays, { min: 1, integer: true }) ?? site.inboxTidy.maxAgeDays;
      if (t.minScore !== undefined) site.inboxTidy.minScore = num(t.minScore, { min: 0, max: 100, integer: true }) ?? site.inboxTidy.minScore;
      if (t.companySite !== undefined) site.inboxTidy.companySite = !!t.companySite;
      tidyChanged = true;
    }
    if (body.resumeText !== undefined) {
      config.resume.text = str(body.resumeText, 20000);
      // Cleared = go back to reading the resume file; anything typed is kept as yours.
      config.resume.textFrom = config.resume.text ? 'manual' : '';
    }

    if (body.filters) {
      const f = body.filters;
      for (const k of ['titleInclude', 'titleExclude', 'companyExclude', 'locations']) {
        if (f[k] !== undefined) site.filters[k] = cleanList(f[k]);
      }
      if (f.remoteOnly !== undefined) site.filters.remoteOnly = !!f.remoteOnly;
      if (f.skipAlreadyApplied !== undefined) site.filters.skipAlreadyApplied = !!f.skipAlreadyApplied;
      if (f.minExperienceYears !== undefined) site.filters.minExperienceYears = num(f.minExperienceYears, { min: 0, max: 50 });
      if (f.maxExperienceYears !== undefined) site.filters.maxExperienceYears = num(f.maxExperienceYears, { min: 0, max: 50 });
      if (f.minSalaryLpa !== undefined) site.filters.minSalaryLpa = num(f.minSalaryLpa, { min: 0, max: 1000 });
      if (f.maxPostedAgeDays !== undefined) site.filters.maxPostedAgeDays = num(f.maxPostedAgeDays, { min: 1, max: 365, integer: true });
    }

    if (body.profile) {
      const p = body.profile;
      for (const k of ['fullName', 'email', 'phone', 'currentCompany', 'currentDesignation', 'currentLocation', 'highestQualification']) {
        if (p[k] !== undefined) config.profile[k] = str(p[k], 200);
      }
      if (p.preferredLocations !== undefined) config.profile.preferredLocations = cleanList(p.preferredLocations);
      if (p.skills !== undefined) config.profile.skills = cleanList(p.skills, 100);
      if (p.willingToRelocate !== undefined) config.profile.willingToRelocate = !!p.willingToRelocate;
      if (p.noticePeriodDays !== undefined) config.profile.noticePeriodDays = num(p.noticePeriodDays, { min: 0, max: 365, integer: true });
      if (p.currentCtcLpa !== undefined) config.profile.currentCtcLpa = num(p.currentCtcLpa, { min: 0, max: 1000 });
      if (p.expectedCtcLpa !== undefined) config.profile.expectedCtcLpa = num(p.expectedCtcLpa, { min: 0, max: 1000 });
      if (p.totalExperienceMonths !== undefined) config.profile.totalExperienceMonths = num(p.totalExperienceMonths, { min: 0, max: 720, integer: true });
    }

    const answersChanged = body.answers !== undefined || body.profile !== undefined;
    if (body.answers !== undefined) {
      // An AI-written rule stays 'auto' only while it is untouched; edit it
      // here and it is yours.
      const autoBefore = new Map((config.answers || []).filter(a => a.origin === 'auto').map(a => [a.pattern, a]));
      // Every rule's age is kept unless its answer changes — an unchanged rule
      // re-saved with the card must not look "new" and reopen drafts.
      const before = new Map((config.answers || []).map(a => [a.pattern, a]));
      config.answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 200).map(a => {
        const rule = {
          pattern: str(a && a.pattern, 300).toLowerCase(),
          answer:  str(a && a.answer, 2000),
          kind:    ['text', 'choice', 'number', 'yesno'].includes(a && a.kind) ? a.kind : 'text',
          enabled: a && a.enabled !== false,
        };
        const was = autoBefore.get(rule.pattern);
        return was && was.answer === rule.answer
          ? { ...rule, origin: 'auto', confidence: was.confidence, quote: was.quote, createdAt: was.createdAt }
          : { ...rule, origin: 'you', createdAt: (() => {
              const prev = before.get(rule.pattern);
              return prev && prev.answer === rule.answer && prev.createdAt ? prev.createdAt : new Date();
            })() };
      }).filter(a => a.pattern);
    }
    if (body.autoAnswer) {
      const x = body.autoAnswer;
      if (x.enabled !== undefined) config.autoAnswer.enabled = !!x.enabled;
      if (x.minConfidence !== undefined) config.autoAnswer.minConfidence = num(x.minConfidence, { min: 70, max: 100, integer: true }) ?? 85;
    }
    if (body.onUnknownQuestion !== undefined) {
      config.onUnknownQuestion = body.onUnknownQuestion === 'apply-anyway' ? 'apply-anyway' : 'skip';
    }

    if (body.apply) {
      const a = body.apply;
      // No ceilings: the numbers are yours. Only "a whole number, at least 1".
      if (a.maxPerRun !== undefined) site.apply.maxPerRun = num(a.maxPerRun, { min: 1, integer: true }) ?? site.apply.maxPerRun;
      if (a.maxPerDay !== undefined) site.apply.maxPerDay = num(a.maxPerDay, { min: 1, integer: true }) ?? site.apply.maxPerDay;
      if (a.autoApproveEnabled !== undefined) site.apply.autoApproveEnabled = !!a.autoApproveEnabled;
      // Floor of 50: below that, "auto-approve" is approving jobs that match
      // under half of what you asked for.
      if (a.autoApproveMinScore !== undefined) site.apply.autoApproveMinScore = num(a.autoApproveMinScore, { min: 50, max: 100, integer: true }) ?? 80;
      if (a.delayMinMs !== undefined) site.apply.delayMinMs = num(a.delayMinMs, { min: 500, max: 60000, integer: true });
      if (a.delayMaxMs !== undefined) site.apply.delayMaxMs = num(a.delayMaxMs, { min: 500, max: 60000, integer: true });
      if (a.coverNote !== undefined) site.apply.coverNote = str(a.coverNote, 4000);
      // A max below the min would make the randomised gap negative, which reads
      // to Naukri as a script.
      if (site.apply.delayMaxMs < site.apply.delayMinMs) {
        site.apply.delayMaxMs = site.apply.delayMinMs;
      }
    }

    if (body.headlineVariants !== undefined) {
      config.headlineVariants = cleanList(body.headlineVariants, 20, 250);
    }

    if (body.safety) {
      if (body.safety.pauseAll !== undefined) site.safety.pauseAll = !!body.safety.pauseAll;
      if (body.safety.dryRun !== undefined) site.safety.dryRun = !!body.safety.dryRun;
    }

    await config.save();
    // A new rule — or a profile field a rule quotes — can unblock skipped jobs.
    const requeued = answersChanged ? await requeueAnswered(req.userId, config) : 0;
    // New tidy rules apply to what is already in the inbox, not just to the
    // next harvest.
    const tidied = tidyChanged ? await tidyInbox(req.userId, config, req.platform) : 0;
    res.json({ config: configView(config, req.platform), ...scheduleView(site.schedule), requeued, tidied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/config/test-answer — the answer-bank tester. Runs the exact
// same resolver the worker uses, so what you see here is what would be typed.
router.post('/config/test-answer', async (req, res) => {
  try {
    const question = str((req.body || {}).question, 1000);
    if (!question) return res.status(400).json({ error: 'question is required' });
    const config = await NaukriConfig.getForUser(req.userId);
    const result = resolveAnswer(question, { answers: config.answers, profile: config.profile });
    res.json({
      question,
      matched: result.matched,
      answer: result.answer || null,
      kind: result.kind || null,
      pattern: result.rule ? result.rule.pattern : null,
      ruleIndex: result.index != null ? result.index : null,
      reason: result.reason || null,
      missing: result.missing || [],
      // What would actually happen to a job asking this, which is the question
      // the user is really asking. The worker always skips an unanswered
      // question (onUnknownQuestion 'apply-anyway' was never honoured by it, and
      // is no longer offered), so this must not claim otherwise.
      wouldSkip: !result.matched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/config/preview-filters — replay the filters against what the
// last harvest actually saw, so the card can say "would keep 18 of 47" before
// you commit. Uses the same lib the worker does.
router.post('/config/preview-filters', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const filters = (req.body || {}).filters || siteOf(config, req.platform).filters;
    const jobs = await NaukriJob.find({ userId: req.userId, ...PQ(req), ...BASE_FILTER })
      .sort({ lastSeenAt: -1 }).limit(200)
      .select('title company location experienceMin experienceMax salaryText postedText')
      .lean();
    const { counts, dropped } = applyFilters(jobs, filters);
    res.json({
      counts,
      // A handful of worked examples beats a number: it shows WHICH job a rule
      // just excluded, which is how you notice a rule is too aggressive.
      examples: dropped.slice(0, 10).map(d => ({ title: d.job.title, company: d.job.company, reason: d.reason })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/naukri/config/unknown-questions — the questions that caused skips,
// most frequent first. This is the loop by which the answer bank fills itself:
// every skip becomes a one-click suggestion in the config UI.
router.get('/config/unknown-questions', async (req, res) => {
  try {
    const [rows, config] = await Promise.all([
      NaukriJob.aggregate([
        { $match: { userId: req.userId, ...SKIP_BUCKETS['needs-answer'], ...PQ(req), deleted: { $ne: true } } },
        { $group: { _id: '$unknownQuestion', count: { $sum: 1 }, lastSeenAt: { $max: '$updatedAt' } } },
        { $sort: { count: -1, lastSeenAt: -1 } },
        { $limit: 50 },
      ]),
      NaukriConfig.getForUser(req.userId),
    ]);

    // Only questions that STILL have no rule. The list is a to-do, so a question
    // you have already answered must leave it — otherwise it reads as "this is
    // still broken" and you add the rule twice. Resolved with the same matcher
    // the worker uses, so "covered" here means genuinely covered at apply time,
    // including a rule whose placeholders resolve from your profile.
    const answered = (q) => resolveAnswer(q, { answers: config.answers, profile: config.profile }).matched;

    res.json({
      questions: rows
        .filter(r => !answered(r._id))
        .slice(0, 25)
        .map(r => ({ question: r._id, count: r.count, lastSeenAt: r.lastSeenAt })),
      // What the list would hold without that filter, so "nothing here" is
      // distinguishable from "you have answered them all".
      answeredCount: rows.filter(r => answered(r._id)).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/config/starter-rules — "Add common rules". Appends the
// starter rules (lib/naukriAnswers.js STARTER_RULES) you do not already have,
// at the END, so any rule you wrote yourself still wins.
// POST /api/naukri/inbox/tidy — run the tidy rules over the inbox now.
router.post('/inbox/tidy', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const site = siteOf(config, req.platform);
    if (!site.inboxTidy || !site.inboxTidy.enabled) return res.status(409).json({ error: 'Inbox tidy is off — turn it on in Configuration → Filters' });
    res.json({ tidied: await tidyInbox(req.userId, config, req.platform) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/config/profile-from-resume — SUGGESTED profile values read
// from the resume by AI (lib/naukriProfile.js). Nothing is saved here: the
// Profile card shows them beside what you have, and you apply the ones you want.
router.post('/config/profile-from-resume', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const text = await resumeTextFor(req.userId, config);
    const out = await profileFromResume(text, { userId: req.userId });
    if (!out.ok) return res.status(out.code === 'AI_KEY_REQUIRED' ? 409 : 422).json({ error: out.error, code: out.code || null });
    res.json({ suggested: out.profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/config/starter-rules', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const have = new Set(config.answers.map(a => a.pattern));
    const add = STARTER_RULES.filter(r => !have.has(r.pattern));
    for (const r of add) config.answers.push({ pattern: r.pattern, answer: r.answer, kind: r.kind, enabled: r.enabled !== false });
    await config.save();
    const requeued = add.length ? await requeueAnswered(req.userId, config) : 0;
    res.json({ config: config.toJSON(), added: add.length, requeued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Needs answer ───────────────────────────────────────────────────────────
// Jobs skipped for a screening question, grouped BY question — one answer
// unblocks every job that asked it — with the AI draft for each.

const sameQuestion = (a, b) => matchable(a) === matchable(b);

// What a draft was written from, as a short fingerprint of the resume text
// and profile. Ignored drafts are your decision and never expire; every other
// draft is only good for the resume and profile it saw.
//
// Answers you give are NOT in it any more. They used to be, so every new rule
// made every draft stale and the next visit redrafted all of them — on top of
// live answering adding rules mid-run, that used up Groq's daily token limit.
// Now a new answer only reopens the "don't say" drafts it could help: ones
// sharing a word with it (draftStillGood).
const draftBasis = (resumeText, profile) => require('crypto').createHash('sha1')
  .update(String(resumeText || '')).update(JSON.stringify(profile || {}))
  .digest('hex').slice(0, 16);
// The previous formula, so drafts saved before this change are not all
// treated as stale (and redrafted) at once.
const legacyBasis = (resumeText, profile, answers = []) => require('crypto').createHash('sha1')
  .update(String(resumeText || '')).update(JSON.stringify(profile || {}))
  .update(JSON.stringify((answers || []).filter(a => a.enabled !== false).map(a => [a.pattern, a.answer])))
  .digest('hex').slice(0, 16);
const plainAnswers = (config) => (config.answers || []).map(a => (a.toObject ? a.toObject() : a));
const draftStillGood = (d, basis, rules = [], legacy = null) => {
  if (!d) return false;
  if (d.status === 'ignored') return true;
  if (d.status === 'error') return false;
  if (d.basis !== basis && d.basis !== legacy) return false;
  // A "don't say" draft reopens when an answer given since could speak to it.
  if (d.status === 'unknown' && d.createdAt) {
    const since = new Date(d.createdAt).getTime();
    const newer = (rules || []).filter(r => r && r.createdAt && new Date(r.createdAt).getTime() > since);
    if (newer.length && naukriDraft.relevantRules(newer, d.question, 1).length) return false;
  }
  return true;
};

// One AI attempt, for a question's history on Needs answer (drafts[].attempts).
const ATTEMPTS_KEPT = 3;
function attemptOf(out, where, min) {
  const ready = out.status === 'ready';
  const confidence = ready ? (out.confidence || 0) : (out.rawConfidence || 0);
  const outcome = ready ? (confidence >= min ? 'used' : 'below-bar')
    : out.status === 'error' ? 'error' : out.why && out.why !== 'not-stated' ? 'rejected' : 'not-stated';
  return {
    at: new Date(), where, outcome, confidence,
    answer: ready ? out.answer : (out.rawAnswer || ''),
    quote: ready ? out.quote : (out.rawQuote || ''),
    why: out.status === 'error' ? (out.note || 'AI busy') : (out.why || ''),
  };
}
// Replace a question's draft, carrying its earlier attempts forward. Two
// atomic writes rather than config.save(): several drafts are written at once.
async function saveDraft(userId, draft, attempt) {
  const cfg = await NaukriConfig.findOne({ userId }, { drafts: 1 }).lean();
  const prev = ((cfg && cfg.drafts) || []).find(d => sameQuestion(d.question, draft.question));
  const attempts = [attempt, ...((prev && prev.attempts) || [])].slice(0, ATTEMPTS_KEPT);
  await NaukriConfig.updateOne({ userId }, { $pull: { drafts: { question: draft.question } } });
  await NaukriConfig.updateOne({ userId }, { $push: { drafts: { $each: [{ ...draft, attempts }], $slice: -300 } } });
}

// GET /api/naukri/needs-answer
// Save a confident AI answer as an 'auto' rule at the top of the bank and put
// every job parked on its question back in Waiting. One place for it, used by
// the live path (/ai-answer) and by drafts written or already sitting on the
// Needs answer page while auto-answer is on — so "the AI is sure enough"
// means the same thing wherever the draft came from. Returns jobs requeued.
async function saveAutoRule(userId, { question, answer, options = [], confidence, quote }) {
  const pattern = matchable(question).slice(0, 300);
  const kind = options.length ? 'choice' : /^\d+(\.\d+)?$/.test(answer) ? 'number' : 'text';
  const rule = { pattern, answer, kind, enabled: true, origin: 'auto', confidence, quote, createdAt: new Date() };
  // Atomic, and only if no rule with this pattern exists yet — two jobs
  // asking the same question at once must not add it twice.
  await NaukriConfig.updateOne(
    { userId, 'answers.pattern': { $ne: pattern } },
    { $push: { answers: { $each: [rule], $position: 0 } }, $pull: { drafts: { question } } },
  );
  const fresh = await NaukriConfig.getForUser(userId);
  return { rule, requeued: await requeueAnswered(userId, fresh) };
}

// With auto-answer on, a draft that passed every check and reached the bar is
// used, not left waiting for a click. Covers jobs skipped before auto-answer
// was switched on, whose drafts were written later on this page.
async function promoteConfidentDrafts(userId, config) {
  const auto = config.autoAnswer || {};
  if (!auto.enabled) return 0;
  const min = auto.minConfidence || 85;
  const text = await resumeTextFor(userId, config);
  const prof = config.profile && config.profile.toObject ? config.profile.toObject() : config.profile;
  const rules = plainAnswers(config);
  const basis = draftBasis(text, prof);
  const legacy = legacyBasis(text, prof, rules);
  let requeued = 0;
  for (const d of config.drafts || []) {
    if (d.status !== 'ready' || (d.confidence || 0) < min || !draftStillGood(d, basis, rules, legacy)) continue;
    requeued += (await saveAutoRule(userId, { question: d.question, answer: d.answer, options: d.options || [], confidence: d.confidence, quote: d.quote })).requeued;
  }
  return requeued;
}

router.get('/needs-answer', async (req, res) => {
  try {
    // Confident drafts first, so the list below no longer shows what they solved.
    const autoRequeued = await promoteConfidentDrafts(req.userId, await NaukriConfig.getForUser(req.userId));
    const [rows, config] = await Promise.all([
      NaukriJob.aggregate([
        // This platform's questions (all of them in the All view). The answer
        // bank they go into is shared, so answering one here also frees jobs
        // on every other platform that asked it.
        { $match: { userId: req.userId, ...SKIP_BUCKETS['needs-answer'], ...PQ(req), deleted: { $ne: true } } },
        { $sort: { updatedAt: -1 } },
        { $group: {
            _id: '$unknownQuestion',
            count: { $sum: 1 },
            lastSeenAt: { $max: '$updatedAt' },
            options: { $max: '$questionOptions' },
            jobs: { $push: { id: { $toString: '$_id' }, title: '$title', company: '$company', url: '$url', platform: { $ifNull: ['$platform', 'naukri'] } } },
            platforms: { $addToSet: { $ifNull: ['$platform', 'naukri'] } },
        } },
        { $sort: { count: -1, lastSeenAt: -1 } },
        { $limit: 100 },
      ]),
      NaukriConfig.getForUser(req.userId),
    ]);
    const drafts = config.drafts || [];
    const text = await resumeTextFor(req.userId, config);
    const prof = config.profile && config.profile.toObject ? config.profile.toObject() : config.profile;
    const rulesNow = plainAnswers(config);
    const basis = draftBasis(text, prof);
    const legacy = legacyBasis(text, prof, rulesNow);
    res.json({
      aiDrafts: !!config.aiDrafts,
      hasResumeText: !!text.trim(),
      questions: rows.map((r) => {
        // A stale draft (different resume or profile, or the AI was busy) is
        // reported as missing, so the tab asks for a fresh one.
        const stored = drafts.find(x => sameQuestion(x.question, r._id));
        const d = stored && draftStillGood(stored, basis, rulesNow, legacy) ? stored : null;
        return {
          question: r._id,
          count: r.count,
          lastSeenAt: r.lastSeenAt,
          options: r.options || [],
          jobs: r.jobs.slice(0, 5),
          platforms: r.platforms || ['naukri'],
          draft: d ? { answer: d.answer, quote: d.quote, source: d.source, status: d.status, confidence: d.confidence || 0 } : null,
          // Every time the AI was asked, even when that draft has since gone stale.
          attempts: (stored && stored.attempts) || [],
          // Answers you gave to questions LIKE this one — a suggestion, never used on their own.
          similar: similarRules(r._id, { answers: rulesNow, profile: prof }),
        };
      }),
      autoAnswer: { enabled: !!(config.autoAnswer && config.autoAnswer.enabled), minConfidence: (config.autoAnswer && config.autoAnswer.minConfidence) || 85 },
      // Answers the AI gave during applies, for you to keep, edit or remove.
      autoRequeued,
      autoAnswered: (config.answers || []).filter(a => a.origin === 'auto').map(a => ({
        pattern: a.pattern, answer: a.answer, confidence: a.confidence, quote: a.quote || '', createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/needs-answer/draft { question } — draft one answer with AI.
// One question per request, so each stays far inside the 60s function limit;
// the tab asks for the ones it is missing, a few at a time.
router.post('/needs-answer/draft', async (req, res) => {
  try {
    const question = str((req.body || {}).question, 1000);
    if (!question) return res.status(400).json({ error: 'question is required' });
    const config = await NaukriConfig.getForUser(req.userId);
    if (!config.aiDrafts) return res.status(409).json({ error: 'AI drafts are off — turn them on under Configuration → Answers' });

    const job = await NaukriJob.findOne(
      { userId: req.userId, unknownQuestion: question, ...BASE_FILTER },
      { questionOptions: 1 },
    ).sort({ updatedAt: -1 }).lean();
    const options = (job && job.questionOptions) || [];

    const resumeTextNow = await resumeTextFor(req.userId, config);
    const profile = config.profile && config.profile.toObject ? config.profile.toObject() : config.profile;
    const rules = plainAnswers(config);
    const out = await naukriDraft.draftAnswer(question, { resumeText: resumeTextNow, profile, options, rules, userId: req.userId });
    // Not saved as an 'error' draft: nothing is wrong with the question, and the
    // tab retries missing drafts on its next load once a key is added.
    if (out.code === 'AI_KEY_REQUIRED') return res.status(409).json({ error: out.note, code: out.code });
    const draft = {
      question, answer: out.answer, quote: out.quote, source: out.source, status: out.status, options,
      confidence: out.confidence || 0, basis: draftBasis(resumeTextNow, profile), createdAt: new Date(),
    };
    // Atomic replace rather than config.save(): the tab drafts several
    // questions in parallel, and concurrent document saves would conflict.
    // Sure enough while auto-answer is on: used straight away, like a live answer.
    const auto = config.autoAnswer || {};
    const min = auto.enabled ? (auto.minConfidence || 85) : 101;   // off: nothing counts as "used"
    if (auto.enabled && draft.status === 'ready' && draft.confidence >= min) {
      const { requeued } = await saveAutoRule(req.userId, { question, answer: draft.answer, options, confidence: draft.confidence, quote: draft.quote });
      return res.json({ draft: { answer: draft.answer, quote: draft.quote, source: draft.source, status: draft.status, confidence: draft.confidence }, autoUsed: true, requeued });
    }
    const attempt = attemptOf(out, 'page', min);
    await saveDraft(req.userId, draft, attempt);
    res.json({ draft: { answer: draft.answer, quote: draft.quote, source: draft.source, status: draft.status, confidence: draft.confidence }, attempt, note: out.note || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/needs-answer/use { question, answer, pattern? } — turn an
// answer (the AI's, or yours) into a rule, then put every job it unblocks back
// in Waiting. THE step that makes an answer real; nothing else does.
router.post('/needs-answer/use', async (req, res) => {
  try {
    const body = req.body || {};
    const question = str(body.question, 1000);
    const answer = str(body.answer, 2000);
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (!answer) return res.status(400).json({ error: 'Type an answer first' });
    // The whole question by default, so the rule answers exactly this and not
    // every question that happens to share a phrase with it.
    const pattern = (str(body.pattern, 300) || matchable(question).slice(0, 300)).toLowerCase();

    const config = await NaukriConfig.getForUser(req.userId);
    const rule = { pattern, answer, kind: 'text', enabled: true, origin: 'you', createdAt: new Date() };
    if (!resolveAnswer(question, { answers: [rule], profile: config.profile }).matched) {
      return res.status(400).json({ error: 'That pattern does not match the question — it would never be used' });
    }
    // At the TOP: first match wins, and a rule written for this exact question
    // must beat a broader one further down.
    config.answers.unshift(rule);
    config.drafts = (config.drafts || []).filter(d => !sameQuestion(d.question, question));
    await config.save();
    const freed = new Set();
    const requeued = await requeueAnswered(req.userId, config, freed);
    res.json({ requeued, rule, platforms: [...freed].map(p => ({ id: p, label: labelOf(p) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/needs-answer/auto { pattern, action: 'keep'|'remove'|'edit', answer? }
// Review an answer the AI gave during an apply. Keep or edit make it yours;
// remove deletes the rule (the job it was used on has already gone out).
router.post('/needs-answer/auto', async (req, res) => {
  try {
    const { pattern, action } = req.body || {};
    const p = str(pattern, 300).toLowerCase();
    const config = await NaukriConfig.getForUser(req.userId);
    const rule = (config.answers || []).find(a => a.pattern === p && a.origin === 'auto');
    if (!rule) return res.status(404).json({ error: 'No AI answer with that question' });
    if (action === 'remove') {
      config.answers = config.answers.filter(a => a !== rule);
    } else if (action === 'keep' || action === 'edit') {
      if (action === 'edit') {
        const answer = str((req.body || {}).answer, 2000);
        if (!answer) return res.status(400).json({ error: 'Type an answer first' });
        rule.answer = answer;
      }
      rule.origin = 'you';
    } else {
      return res.status(400).json({ error: 'action must be keep, edit or remove' });
    }
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/ai-answer { runId, jobId, question, options } — worker
// token. The live half of auto-answer: the worker is mid-questionnaire with a
// question no rule answers, and asks whether the AI is sure enough to answer
// it. Only a draft that passed every check in lib/naukriDraft.js AND reached
// your threshold comes back as an answer; it is saved as an 'auto' rule at the
// top of the bank (so the same question never stops a job again) and any job
// already parked on it goes back to Waiting. Anything else is kept as a Needs
// answer draft and the worker skips the job, as before.
const MAX_AI_PER_RUN = 15;

router.post('/ai-answer', async (req, res) => {
  try {
    const { runId, question: rawQ, options: rawOptions } = req.body || {};
    const question = str(rawQ, 1000);
    if (!runId || !question) return res.status(400).json({ error: 'runId and question are required' });
    const options = cleanList(rawOptions, 20, 200);

    const config = await NaukriConfig.getForUser(req.userId);
    const auto = config.autoAnswer || {};
    if (!auto.enabled) return res.json({ answer: null, reason: 'off' });
    const min = auto.minConfidence || 85;

    // Per-run cap, taken atomically so parallel calls cannot overshoot it.
    const slot = await NaukriRun.findOneAndUpdate(
      { _id: runId, userId: req.userId, status: 'running', 'stats.aiAsked': { $lt: MAX_AI_PER_RUN }, ...PQ(req), ...BASE_FILTER },
      { $inc: { 'stats.aiAsked': 1 } },
      { new: true, projection: { _id: 1 } },
    );
    if (!slot) return res.json({ answer: null, reason: `AI answer limit for this run (${MAX_AI_PER_RUN}) reached, or the run is not running` });

    const text = await resumeTextFor(req.userId, config);
    const profile = config.profile && config.profile.toObject ? config.profile.toObject() : config.profile;
    const rules = plainAnswers(config);
    const out = await naukriDraft.draftAnswer(question, { resumeText: text, profile, options, rules, userId: req.userId });
    const confidence = out.confidence || 0;

    if (out.status === 'ready' && confidence >= min) {
      const { rule } = await saveAutoRule(req.userId, { question, answer: out.answer, options, confidence, quote: out.quote });
      await NaukriRun.updateOne({ _id: runId, userId: req.userId }, { $inc: { 'stats.aiAnswered': 1 } });
      return res.json({ answer: out.answer, confidence, rule });
    }

    // Not sure enough: keep the draft (with its %) for Needs answer.
    if (out.code !== 'AI_KEY_REQUIRED') {
      const draft = {
        question, answer: out.answer, quote: out.quote, source: out.source, status: out.status, options, confidence,
        basis: draftBasis(text, profile), createdAt: new Date(),
      };
      await saveDraft(req.userId, draft, attemptOf(out, 'apply', min));
    }
    res.json({
      answer: null, confidence,
      reason: out.code === 'AI_KEY_REQUIRED' ? out.note
        : out.status === 'ready' ? `AI was ${confidence}% sure — below your ${min}%`
        : out.status === 'error' ? (out.note || 'AI busy') : 'Your resume and answers do not say',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/ai-note { runId, jobId, kind, question? } — worker token. The
// message (or one open answer) that goes with an application, written for THIS
// job from the resume and the job's own text (lib/applyNote.js). Never saved as
// an answer rule: it belongs to one company. No note → the worker sends no
// application rather than an empty or doubtful one.
const MAX_NOTES_PER_RUN = 30;

router.post('/ai-note', async (req, res) => {
  try {
    const { runId, jobId, kind: rawKind, question: rawQ, maxChars } = req.body || {};
    const kind = rawKind === 'question' ? 'question' : 'message';
    const question = str(rawQ, 1000);
    if (!runId || !jobId) return res.status(400).json({ error: 'runId and jobId are required' });
    if (kind === 'question' && !question) return res.status(400).json({ error: 'question is required' });

    const job = await NaukriJob.findOne({ _id: jobId, userId: req.userId, ...PQ(req), ...BASE_FILTER }).lean();
    if (!job) return res.status(404).json({ error: 'No such job' });

    const slot = await NaukriRun.findOneAndUpdate(
      { _id: runId, userId: req.userId, status: 'running', 'stats.aiNotes': { $lt: MAX_NOTES_PER_RUN }, ...PQ(req), ...BASE_FILTER },
      { $inc: { 'stats.aiNotes': 1 } },
      { new: true, projection: { _id: 1 } },
    );
    if (!slot) return res.json({ text: null, reason: `AI note limit for this run (${MAX_NOTES_PER_RUN}) reached, or the run is not running` });

    const config = await NaukriConfig.getForUser(req.userId);
    const profile = config.profile && config.profile.toObject ? config.profile.toObject() : config.profile;
    const out = await applyNote.writeNote({
      job, resumeText: await resumeTextFor(req.userId, config), profile, userId: req.userId,
      kind, question, maxChars: Number(maxChars) || undefined,
      recruiter: (job.recruiters && job.recruiters[0] && job.recruiters[0].name) || '',
    });
    if (out.text) {
      await NaukriJob.updateOne({ _id: job._id }, kind === 'message'
        ? { $set: { sentMessage: out.text } }
        : { $push: { sentAnswers: { $each: [{ q: question.slice(0, 300), a: out.text }], $slice: -10 } } });
    }
    res.json({ text: out.text || null, reason: out.reason || '', code: out.code || '', declined: !!out.declined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/needs-answer/ignore { question } — you will not answer this
// one. Its jobs are dismissed (off every list and count), and the draft is
// kept as ignored so it is not drafted again.
router.post('/needs-answer/ignore', async (req, res) => {
  try {
    const question = str((req.body || {}).question, 1000);
    if (!question) return res.status(400).json({ error: 'question is required' });
    const now = new Date();
    const result = await NaukriJob.updateMany(
      { userId: req.userId, ...SKIP_BUCKETS['needs-answer'], unknownQuestion: question, ...BASE_FILTER },
      { $set: { applyStatus: 'dismissed', retryable: false, priority: 0 },
        $push: { applyHistory: { at: now, from: 'skipped', to: 'dismissed', note: 'question ignored by you' } } },
    );
    await NaukriConfig.updateOne({ userId: req.userId }, { $pull: { drafts: { question } } });
    await NaukriConfig.updateOne({ userId: req.userId }, {
      $push: { drafts: { $each: [{ question, status: 'ignored', createdAt: now }], $slice: -300 } },
    });
    res.json({ dismissed: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plain text out of an uploaded resume, for AI drafts. PDF only — Word files
// have no extractor here, and the Resume card says so and offers a paste box.
// Never throws: a resume that will not parse is still a resume to attach.
async function resumeText(file) {
  if (!file || file.mimetype !== 'application/pdf') return '';
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
  } catch (_) {
    return '';
  }
}

// ── Resume ─────────────────────────────────────────────────────────────────

router.post('/resume', (req, res) => {
  upload.single('resume')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const config = await NaukriConfig.getForUser(req.userId);
      const text = await resumeText(req.file);
      config.resume = {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        data: req.file.buffer,
        size: req.file.size,
        uploadedAt: new Date(),
        // A new file replaces the text too — unless it yielded none (a Word
        // file, a scanned PDF), in which case what you pasted before is kept.
        text: text || (config.resume && config.resume.text) || '',
        textFrom: text ? 'naukri' : ((config.resume && config.resume.textFrom) || ''),
      };
      await config.save();
      res.json({
        resume: { filename: config.resume.filename, size: config.resume.size, uploadedAt: config.resume.uploadedAt },
        resumeText: config.resume.text,
        extracted: !!text,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// The resume Naukri uses: a Naukri-only upload if there is one, otherwise the
// one in Settings — so nobody has to upload the same file twice. `withData`
// loads the bytes; without it only the facts are read.
async function effectiveResume(userId, config, { withData = false } = {}) {
  if (config && config.resume && config.resume.size > 0) {
    const r = config.resume;
    return { source: 'naukri', filename: r.filename, contentType: r.contentType, size: r.size, uploadedAt: r.uploadedAt, data: withData ? r.data : undefined };
  }
  const s = await Settings.findOne({ userId }, withData ? { resume: 1 } : { 'resume.data': 0 }).lean();
  if (!s || !s.resume || !s.resume.size) return null;
  const r = s.resume;
  return { source: 'settings', filename: r.filename, contentType: r.contentType, size: r.size, uploadedAt: r.uploadedAt, data: withData ? r.data : undefined };
}

// The text AI drafts are written from. Typed/pasted text and text from a
// Naukri-only upload are kept as they are. Otherwise it is read from the
// Settings resume the first time it is needed, and read again whenever that
// file has been replaced. '' when there is nothing readable.
async function resumeTextFor(userId, config) {
  const r = config.resume || {};
  const from = r.textFrom || (r.text ? 'manual' : '');
  if (from === 'manual' || from === 'naukri') return r.text || '';
  const eff = await effectiveResume(userId, config);
  if (!eff || eff.source !== 'settings') return r.text || '';
  const stamp = `settings:${eff.uploadedAt ? new Date(eff.uploadedAt).toISOString() : eff.size}`;
  if (from === stamp && r.text) return r.text;
  const full = await effectiveResume(userId, config, { withData: true });
  const data = full && full.data && (full.data.buffer ? Buffer.from(full.data.buffer) : Buffer.from(full.data));
  const text = data ? await resumeText({ mimetype: full.contentType, buffer: data }) : '';
  await NaukriConfig.updateOne({ userId }, { $set: { 'resume.text': text, 'resume.textFrom': stamp } });
  if (config.resume) { config.resume.text = text; config.resume.textFrom = stamp; }
  return text;
}

async function sendResume(req, res) {
  try {
    const config = await NaukriConfig.findOne({ userId: req.userId });
    const r = await effectiveResume(req.userId, config, { withData: true });
    if (!r || !r.data) {
      return res.status(404).json({ error: 'No resume uploaded — add one in Settings' });
    }
    const data = r.data.buffer && !Buffer.isBuffer(r.data) ? Buffer.from(r.data.buffer) : r.data;
    res.set('Content-Type', r.contentType);
    res.set('Content-Disposition', `attachment; filename="${String(r.filename).replace(/"/g, '')}"`);
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/resume', sendResume);

// GET /api/naukri/worker-resume — the same bytes, on a path the worker token is
// allowed to reach. Deliberately NOT the owner's /resume: WORKER_PATHS in
// server.js matches on path and not method, so exposing that path would also
// hand a worker token the DELETE below.
router.get('/worker-resume', sendResume);

router.delete('/resume', async (req, res) => {
  try {
    await NaukriConfig.findOneAndUpdate({ userId: req.userId }, { $unset: { resume: '' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Runs ───────────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = { userId: req.userId, ...PQ(req), ...BASE_FILTER };
    if (KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
    const [runs, total] = await Promise.all([
      NaukriRun.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      NaukriRun.countDocuments(filter),
    ]);
    res.json({ runs: runs.map(serialize), total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by the manual button and by an approval, which queues an apply run.
async function queueRun(userId, kind, trigger = 'manual', { sources = null, platform = 'naukri' } = {}) {
  const [worker, fullConfig] = await Promise.all([
    NaukriWorker.getForUser(userId, platform),
    NaukriConfig.getForUser(userId),
  ]);
  const config = siteOf(fullConfig, platform);
  const label = labelOf(platform);
  const pq = platformQuery(platform);

  if (!isEnabled(config, platform)) {
    return { error: `${label} is turned off. Turn it on in Configuration → Platforms.`, code: 409 };
  }
  // A step this platform has no driver for, or apply while apply is off.
  const notAllowed = kindBlocked(kind, config, platform);
  if (notAllowed) return { error: notAllowed, code: 409 };

  if (config.safety.pauseAll) {
    return {
      error: platform === 'naukri'
        ? 'Naukri is paused. Turn off "Pause all" in Configuration to run anything.'
        : `${label} is paused. Turn off "Pause ${label}" in Configuration to run anything.`,
      code: 423,
    };
  }
  const blockedUntil = blockedUntilOf(worker);
  if (blockedUntil) {
    return {
      error: `${label} showed a captcha on the last run. Everything is paused until `
           + blockedUntil.toISOString() + ' — do not work around this.',
      code: 423, blockedUntil,
    };
  }

  // Today's limit already used: say so now, rather than queue a run that the
  // worker can only finish empty ("nothing to do") a few seconds later.
  if (kind === 'apply') {
    const done = await appliedToday(userId, config.schedule.timezone, platform);
    if (done >= config.apply.maxPerDay) {
      return {
        error: `Today's limit of ${config.apply.maxPerDay} applications is used up (${done} sent). `
             + 'Raise Max per day in Configuration → Apply behaviour & safety, or they go out tomorrow.',
        code: 409, limitReached: true,
      };
    }
  }

  await failStaleRuns(userId);
  // One active run per PLATFORM: an Instahyre harvest never waits on a Naukri
  // apply. The shared Chrome is serialised on the Mac (worker/chrome-lock.js).
  const active = await NaukriRun.findOne({ userId, status: { $in: ACTIVE }, ...pq, ...BASE_FILTER }).lean();
  if (active) {
    // An apply run queued by an approval while one is already pending is a
    // no-op, not an error: the pending run will pick up the new approvals when
    // it claims, because it reads them at claim time.
    if (kind === 'apply' && active.kind === 'apply') return { run: active, deduped: true };
    return { error: `A ${label} ${active.kind} is already ${active.status}`, code: 409, run: serialize(active) };
  }

  const run = await NaukriRun.create({
    userId, platform, kind, trigger, dryRun: applyModeOf(config, platform) === 'dry-run',
    // A harvest can be pointed at one source for this run only.
    sources: kind === 'harvest' && sources ? sources : null,
  });
  return { run: run.toJSON() };
}

router.post('/runs', async (req, res) => {
  try {
    const kind = str((req.body || {}).kind, 20);
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    }
    let sources = null;
    if (kind === 'harvest' && (req.body || {}).sources) {
      const cfg = await NaukriConfig.getForUser(req.userId);
      sources = cleanSources(req.body.sources, siteOf(cfg, req.platform).sources);
      if (!sources) return res.status(400).json({ error: 'Pick searches, recommended jobs, or both' });
    }
    const out = await queueRun(req.userId, kind, 'manual', { sources, platform: req.platform });
    if (out.error) return res.status(out.code).json(out);
    res.status(201).json({ run: out.run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/runs/:id/cancel', async (req, res) => {
  try {
    // Only a queued run can be cancelled — a running one is a live Chrome
    // session on the Mac that this process cannot reach.
    const run = await NaukriRun.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId, status: 'queued', ...PQ(req), ...BASE_FILTER },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
      { new: true }
    );
    if (!run) return res.status(404).json({ error: 'No queued run with that id' });
    res.json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jobs: the review queue and the applied board ───────────────────────────

// Regex-escaped, because the search box is free text and a stray "(" or "+"
// in a job title would otherwise throw rather than find nothing.
const rx = (v, max = 100) => new RegExp(str(v, max).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// How many rows the salary/age refinement may consider. Those two live in free
// text ("8-12 Lacs PA", "3+ weeks ago") and cannot be queried in Mongo, so they
// are applied in JS after the indexed filters have already cut the set down.
// The review queue is a daily skim, not an archive, so this ceiling is never
// reached in practice — and if it were, the count would be honest about it.
const REFINE_CAP = 1000;

// ── Activity: what recruiters are doing on your jobs ───────────────────────
// Read-only. Every status a job site showed for one of your applications —
// viewed, resume viewed, shortlisted, contacted, not shortlisted — newest first,
// across platforms. "Applied" / "Application Sent" are your own send, not a
// recruiter action, so they are left out. Built from naukriTimeline (the track
// run's reading of the site); nothing is written.
const recruiterKind = (v) => {
  const t = String(v || '').toLowerCase();
  if (/not\s*shortlisted|not\s*suitable|unsuitable|rejected|not selected|declined/.test(t)) return 'not-shortlisted';
  if (/shortlist/.test(t)) return 'shortlisted';
  if (/contact|message|reply|replied|interested|invited|interview|offer/.test(t)) return 'contacted';
  if (/view|seen|opened|read|download/.test(t)) return 'viewed';
  return 'other';
};
const OWN_SEND = /^(applied|application sent|application submitted)$/i;
router.get('/activity', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const limit = Math.min(400, Math.max(20, parseInt(req.query.limit, 10) || 100));
    const since = new Date(Date.now() - days * 86400000);
    const wanted = new Set(String(req.query.types || '').split(',').filter(Boolean));

    const base = { userId: oidOf(req.userId), ...PQ(req), deleted: { $ne: true } };
    // Some sites (Instahyre) print no date on a status, so the job's own stage time
    // — when the track run first saw it — stands in, rather than hiding the job.
    const jobs = await NaukriJob.find({ ...base, $or: [{ 'naukriTimeline.at': { $gte: since } }, { naukriStageAt: { $gte: since } }] },
      { title: 1, company: 1, platform: 1, url: 1, naukriTimeline: 1, naukriStage: 1, naukriStageAt: 1, recruiters: 1 })
      .sort({ naukriStageAt: -1 }).limit(1500).lean();

    const all = [];
    for (const j of jobs) {
      for (const t of j.naukriTimeline || []) {
        const when = t.at || j.naukriStageAt || null;
        if (!when || when < since || !t.value || OWN_SEND.test(String(t.value).trim())) continue;
        all.push({
          jobId: String(j._id), title: j.title, company: j.company || '', platform: j.platform || 'naukri', url: j.url || '',
          at: when, type: recruiterKind(t.value), label: String(t.value).slice(0, 80), stage: j.naukriStage || null,
          recruiter: ((j.recruiters || [])[0] || {}).name || '',
        });
      }
    }
    all.sort((a, b) => b.at - a.at);

    // The headline numbers are JOBS, counted exactly as Analytics counts them:
    // sent applications by the furthest stage a recruiter took them to, all time
    // (the period only narrows the list below, not these).
    const stageRows = await NaukriJob.aggregate([
      { $match: { ...base, applyStatus: { $in: SENT_STATUSES }, naukriStage: { $in: ['viewed', 'shortlisted', 'contacted', 'not-shortlisted'] } } },
      { $group: { _id: { p: { $ifNull: ['$platform', 'naukri'] }, s: '$naukriStage' }, n: { $sum: 1 } } },
    ]);
    const counts = { stages: {}, platforms: {}, responded: 0, shortlisted: 0 };
    for (const r of stageRows) {
      counts.stages[r._id.s] = (counts.stages[r._id.s] || 0) + r.n;
      counts.platforms[r._id.p] = (counts.platforms[r._id.p] || 0) + r.n;
      counts.responded += r.n;
      if (r._id.s === 'shortlisted' || r._id.s === 'contacted') counts.shortlisted += r.n;
    }
    counts.stages.other = new Set(all.filter((e) => e.type === 'other').map((e) => e.jobId)).size;
    // A chip lists the updates OF that kind (a Shortlisted chip shows the shortlistings, not the views that led up to them).
    const events = wanted.size ? all.filter((e) => wanted.has(e.type)) : all;
    res.json({ since, days, total: events.length, counts, events: events.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { userId: req.userId, ...PQ(req), ...BASE_FILTER };
    // Each row comes back with `dup`: its furthest-along copy on another
    // platform (lib/jobDupes.js), worked out now from that copy's live state.
    const dupWindow = ((await NaukriConfig.findOne({ userId: req.userId }, { duplicates: 1 }).lean()) || {}).duplicates;
    const withDupes = async (rows) => {
      const dupes = await dupesFor(NaukriJob, req.userId, rows, { windowDays: (dupWindow && dupWindow.windowDays) || 60 });
      return rows.map((r) => {
        const o = serialize(r);
        const d = dupes.get(String(r._id));
        o.dup = d ? { ...d, text: dupText(d) } : null;
        return o;
      });
    };
    // `bucket=waiting` is the Waiting tab asking for exactly what its badge
    // counts, rather than reproducing the rule and hoping the two agree.
    if (req.query.bucket === 'waiting') Object.assign(filter, WAITING_FILTER);
    else if (SKIP_BUCKETS[req.query.bucket]) Object.assign(filter, SKIP_BUCKETS[req.query.bucket]);
    else if (req.query.bucket === 'skipped') Object.assign(filter, ALL_SKIPPED);
    else if (['pending', 'approved', 'rejected'].includes(req.query.approval)) filter.approval = req.query.approval;
    // 'sent' is what the Applied board asks for: things that actually went out.
    // 'any' is kept for anything that wants every outcome including skips.
    if (req.query.applyStatus === 'sent') filter.applyStatus = { $in: SENT_STATUSES };
    else if (req.query.applyStatus === 'any') filter.applyStatus = { $ne: 'none' };
    else if (req.query.applyStatus) filter.applyStatus = req.query.applyStatus;

    if (req.query.q) {
      const r = rx(req.query.q);
      filter.$or = [{ title: r }, { company: r }, { tags: r }];
    }
    // Which kind of apply. `external` means the employer has been seen handing
    // off to their own site before; `native` means they have not — a prediction,
    // not a guarantee, which is why the UI never calls it "will apply".
    // hideExternal is the older spelling of applyType=native, still accepted.
    if (req.query.applyType === 'external') filter.likelyExternal = true;
    else if (req.query.applyType === 'native' || req.query.hideExternal === '1') {
      filter.likelyExternal = { $ne: true };
    }
    // Where it was found. Rows harvested before origins existed came from a
    // search, so 'search' also matches rows with no origins at all.
    // Applied last (after the experience bands) via $and, so it never
    // collides with the search box's $or; the chip counts are taken without it.
    const ORIGIN = {
      recommended: { origins: 'recommended' },
      recruiter: { origins: 'recruiter' },
      search: { $or: [{ origins: 'search' }, { origins: { $size: 0 } }] },
    };
    const originCond = ORIGIN[req.query.origin] || null;
    if (req.query.location) {
      // Naukri writes "Bengaluru"; people type "Bangalore". Matching literally
      // returned one row out of a hundred, which reads as a broken filter.
      const names = cityVariants(req.query.location);
      filter.location = names.length > 1
        ? new RegExp(names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
        : rx(req.query.location);
    }

    // Experience is a band on both sides, so this keeps a job when the two bands
    // OVERLAP rather than when the job's band sits inside yours — a "3-8 Yrs"
    // listing is a real match at 4 years, and requiring containment would hide
    // most of the board. Same rule as lib/naukriFilters.js, deliberately.
    const minExp = num(req.query.minExp, { min: 0, max: 50 });
    const maxExp = num(req.query.maxExp, { min: 0, max: 50 });
    const bands = [];
    if (maxExp != null) bands.push({ $or: [{ experienceMin: null }, { experienceMin: { $lte: maxExp } }] });
    if (minExp != null) bands.push({ $or: [{ experienceMax: null }, { experienceMax: { $gte: minExp } }] });
    if (bands.length) filter.$and = [...(filter.$and || []), ...bands];
    const noOrigin = { ...filter };
    if (originCond) filter.$and = [...(filter.$and || []), originCond];

    const SORTS = {
      // Best fit first; unscored rows (harvested before scoring) last.
      score: { score: -1, lastSeenAt: -1 },
      // The order an apply run claims in, so Waiting's positions are true.
      queue: { priority: -1, approvedAt: 1 },
      newest: { lastSeenAt: -1 },
      oldest: { lastSeenAt: 1 },
      experience: { experienceMin: 1, lastSeenAt: -1 },
      company: { company: 1, lastSeenAt: -1 },
    };
    const sort = SORTS[req.query.sort] || SORTS.newest;
    // Applied, by what the recruiter did (furthest stage from the track run).
    // 'none' = no recruiter action seen yet.
    const STAGE_FILTER = {
      none: { $or: [{ naukriStage: null }, { naukriStage: 'applied' }] },
      viewed: { naukriStage: 'viewed' },
      shortlisted: { naukriStage: 'shortlisted' },
      contacted: { naukriStage: 'contacted' },
      'not-shortlisted': { naukriStage: 'not-shortlisted' },
    };
    const stageBase = { ...filter };
    if (STAGE_FILTER[req.query.stage]) filter.$and = [...(filter.$and || []), STAGE_FILTER[req.query.stage]];
    // Chip counts, taken without the stage filter so every chip shows its own size.
    const stageCounts = req.query.applyStatus !== 'sent' ? null : async () => {
      const out = {};
      await Promise.all(Object.entries(STAGE_FILTER).map(async ([k, f]) => {
        out[k] = await NaukriJob.countDocuments({ ...stageBase, $and: [...(stageBase.$and || []), f] });
      }));
      return out;
    };
    // Jobs the inbox tidy cleared away, for "Show tidied" and Restore.
    if (req.query.tidied === '1') { filter.approval = 'rejected'; filter.tidiedAt = { $ne: null }; }

    const minSalaryLpa = num(req.query.minSalary, { min: 0, max: 1000 });
    const maxPostedAgeDays = num(req.query.maxAge, { min: 1, max: 365, integer: true });
    const needsRefine = minSalaryLpa != null || maxPostedAgeDays != null;

    // Counts for the apply-type chips, computed WITHOUT the type facet so each
    // chip shows how many it would give you rather than how many match the one
    // already selected — a chip reading 0 because it is not the active one is
    // worse than no chip.
    const typeFilter = { ...filter };
    delete typeFilter.likelyExternal;
    const typeCounts = async () => {
      const [external, all] = await Promise.all([
        NaukriJob.countDocuments({ ...typeFilter, likelyExternal: true }),
        NaukriJob.countDocuments(typeFilter),
      ]);
      return { all, external, native: all - external };
    };
    // Same idea for the Searches / Recommended chips. A job found both ways
    // counts under both, so the two can add up to more than All.
    const originCounts = async () => {
      const and = (c) => ({ ...noOrigin, $and: [...(noOrigin.$and || []), c] });
      const [all, recommended, search] = await Promise.all([
        NaukriJob.countDocuments(noOrigin),
        NaukriJob.countDocuments(and(ORIGIN.recommended)),
        NaukriJob.countDocuments(and(ORIGIN.search)),
      ]);
      return { all, recommended, search };
    };

    // The Waiting list in exactly the order the next run takes them.
    if (req.query.sort === 'queue' && !needsRefine) {
      const [all, counts, origins] = await Promise.all([
        NaukriJob.find(filter).limit(5000).lean(), typeCounts(), originCounts(),
      ]);
      const ordered = queueOrder(all);
      return res.json({
        jobs: await withDupes(ordered.slice((page - 1) * limit, page * limit)),
        total: ordered.length, page, limit, pages: Math.ceil(ordered.length / limit), typeCounts: counts, originCounts: origins,
      });
    }

    if (!needsRefine) {
      const [jobs, total, counts, origins, stages] = await Promise.all([
        NaukriJob.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        NaukriJob.countDocuments(filter),
        typeCounts(),
        originCounts(),
        stageCounts ? stageCounts() : null,
      ]);
      return res.json({ jobs: await withDupes(jobs), total, page, limit, pages: Math.ceil(total / limit), typeCounts: counts, originCounts: origins, stageCounts: stages });
    }

    // Salary and posted-age are parsed from Naukri's own words by the same lib
    // the worker and the Filters preview use, so all three agree on what
    // "8-12 Lacs PA" and "3+ weeks ago" mean.
    const rows = await NaukriJob.find(filter).sort(sort).limit(REFINE_CAP).lean();
    const kept = rows.filter((j) => {
      if (minSalaryLpa != null) {
        const lpa = parseSalaryLpa(j.salaryText);
        // Undisclosed pay is KEPT. Most of Naukri hides it, and dropping those
        // would empty the queue rather than narrow it.
        if (lpa != null && lpa < minSalaryLpa) return false;
      }
      if (maxPostedAgeDays != null) {
        const age = parsePostedAgeDays(j.postedText);
        if (age != null && age > maxPostedAgeDays) return false;
      }
      return true;
    });

    const total = kept.length;
    const slice = kept.slice((page - 1) * limit, page * limit);
    res.json({
      jobs: await withDupes(slice), total, page, limit, pages: Math.ceil(total / limit),
      truncated: rows.length >= REFINE_CAP,
      typeCounts: await typeCounts(),
      originCounts: await originCounts(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/naukri/jobs/outreach?ids=a,b — for applied jobs: has a Discover search
// been run for the company from this job, how many people it found, and how many
// went to outreach / replied. Computed on read from the searches and contacts that
// carry the job's id; a separate endpoint so GET /jobs stays exactly as it was.
router.get('/jobs/outreach', async (req, res) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(','))].filter(id => mongoose.isValidObjectId(id)).slice(0, 200);
    if (!ids.length) return res.json({ jobs: {} });

    const searches = await ProspectSearch.find({ userId: req.userId, naukriJobId: { $in: ids } }, { naukriJobId: 1, domain: 1, status: 1, createdAt: 1 })
      .sort({ createdAt: -1 }).lean();
    const [people, contacts] = await Promise.all([
      searches.length
        ? Prospect.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(String(req.userId)), searchId: { $in: searches.map(s => s._id) }, deleted: { $ne: true } } },
          { $group: { _id: '$searchId', n: { $sum: 1 } } },
        ])
        : [],
      Contact.find({ userId: req.userId, naukriJobId: { $in: ids }, deleted: { $ne: true } }, { naukriJobId: 1, status: 1, repliedAt: 1 }).lean(),
    ]);
    const peopleBySearch = new Map(people.map(p => [String(p._id), p.n]));

    const out = {};
    for (const id of ids) out[id] = { searched: false, domain: null, searchId: null, searchStatus: null, people: 0, contacts: 0, replied: 0 };
    for (const s of searches) {
      const o = out[s.naukriJobId];
      if (!o) continue;
      if (!o.searched) Object.assign(o, { searched: true, domain: s.domain, searchId: String(s._id), searchStatus: s.status });
      o.people += peopleBySearch.get(String(s._id)) || 0;
    }
    for (const c of contacts) {
      const o = out[c.naukriJobId];
      if (!o) continue;
      o.contacts++;
      if (c.repliedAt || ['replied', 'follow-up-replied'].includes(c.status)) o.replied++;
    }
    res.json({ jobs: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Queue an apply run on every platform the given jobs belong to, skipping the
// ones whose apply mode is off. Returns [{ platform, run } | { platform, error }].
async function queueApplyFor(userId, ids) {
  const plats = [...new Set((await NaukriJob.find({ _id: { $in: ids }, userId }, { platform: 1 }).lean()).map(platformOfDoc))];
  const config = await NaukriConfig.getForUser(userId);
  const out = [];
  for (const p of plats) {
    if (applyModeOf(siteOf(config, p), p) === 'off') continue;
    const r = await queueRun(userId, 'apply', 'manual', { platform: p });
    out.push(r.error ? { platform: p, error: r.error } : { platform: p, run: r.run });
  }
  return out;
}

// POST /api/naukri/jobs/decide — THE authorisation point. Approving is the only
// thing in this system that permits an application to be sent, which is why it
// also queues the apply run rather than leaving that to a schedule.
router.post('/jobs/decide', async (req, res) => {
  try {
    const { ids, decision, reason } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (!['approved', 'rejected', 'pending'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approved, rejected or pending' });
    }

    const update = { approval: decision };
    if (decision === 'approved') { update.approvedAt = new Date(); update.approvedBy = 'you'; }
    if (decision === 'rejected') update.rejectedReason = str(reason, 300);

    const result = await NaukriJob.updateMany(
      // Never re-decide something already applied to: that decision has left the
      // building and the row is now an outcome, not a proposal.
      { _id: { $in: ids.slice(0, 500) }, userId: req.userId, applyStatus: { $in: ['none', 'skipped', 'failed'] }, ...BASE_FILTER },
      { $set: update }
    );

    let queuedRun = null;
    if (decision === 'approved' && result.modifiedCount > 0) {
      // One apply run per platform the approved jobs are on (the All view can
      // approve across platforms in one go). A platform with apply off just
      // keeps them in Waiting — that is not an error worth showing.
      const runs = await queueApplyFor(req.userId, ids.slice(0, 500));
      // A queue failure here must not lose the approvals — they are saved, and
      // the reason is reported so the UI can explain why nothing started.
      const first = runs[0] || null;
      queuedRun = first ? (first.error ? { error: first.error } : first.run) : null;
      return res.json({ updated: result.modifiedCount, run: queuedRun, runs });
    }

    res.json({ updated: result.modifiedCount, run: queuedRun });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/jobs/bulk — act on a selection.
//
// The actions differ by where you are, because the useful next step does:
// from Waiting you either send these now or set them aside; from Skipped you
// either put them back in the queue or drop them. One endpoint, named actions,
// so the client never has to assemble a state change field by field.
router.post('/jobs/bulk', async (req, res) => {
  try {
    const { ids, action, reason } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });

    const scope = { _id: { $in: ids.slice(0, 500) }, userId: req.userId, ...BASE_FILTER };
    const now = new Date();
    let result, run = null;

    if (action === 'apply-next') {
      // Only jobs a run could actually take. Silently including an applied one
      // would report a number that never becomes an application.
      result = await NaukriJob.updateMany(
        { ...scope, approval: 'approved', applyStatus: { $in: ['none', 'failed', 'skipped'] }, retryable: { $ne: false } },
        { $set: { priority: 1 } }
      );
      const runs = await queueApplyFor(req.userId, ids.slice(0, 500));
      const out = runs[0] || { error: 'Apply is off for this platform — they wait in Waiting.' };
      run = out.error ? { error: out.error } : out.run;

    } else if (action === 'skip') {
      // Set aside by hand. Marked not-retryable for the same reason a
      // company-site skip is: you have decided, and a run must not undo that by
      // picking it up again tomorrow.
      result = await NaukriJob.updateMany(
        { ...scope, applyStatus: { $in: ['none', 'failed'] } },
        { $set: {
            applyStatus: 'skipped', retryable: false, priority: 0,
            applyNote: str(reason, 300) || 'Set aside by you',
          },
          $push: { applyHistory: { at: now, from: 'none', to: 'skipped', note: 'set aside by you' } },
        }
      );

    } else if (action === 'requeue') {
      // Back into the queue. Clears the outcome and the note on the row, so a
      // job that said "applies on the company site" does not keep claiming that
      // after you decided to try again — but the old note goes into the
      // history first. That history is also what /ingest reads to recognise
      // company-site employers, so trying one again does not make the app
      // forget that employer's other listings go off-site.
      const rows = await NaukriJob.find({ ...scope, applyStatus: { $in: ['skipped', 'failed', 'dismissed'] } },
        { applyStatus: 1, applyNote: 1, unknownQuestion: 1 }).lean();
      for (const j of rows) {
        await NaukriJob.updateOne({ _id: j._id }, {
          $set: {
            applyStatus: 'none', retryable: true, approval: 'approved',
            approvedAt: now, applyNote: '', unknownQuestion: '', questionOptions: [],
          },
          $push: { applyHistory: { at: now, from: j.applyStatus, to: 'none',
            note: `requeued by you${j.applyNote ? ` (was: ${String(j.applyNote).slice(0, 300)})` : ''}` } },
        });
      }
      result = { modifiedCount: rows.length };

    } else if (action === 'restore') {
      // Back from the tidy, for good: tidyExempt keeps the rules off it.
      result = await NaukriJob.updateMany(
        { ...scope, approval: 'rejected', tidiedAt: { $ne: null } },
        { $set: { approval: 'pending', tidiedAt: null, tidyReason: '', rejectedReason: '', tidyExempt: true } },
      );

    } else if (action === 'dismiss') {
      // Skips and failures become 'dismissed' — off every list and count. The
      // old version only rejected them, which left them sitting in Skipped.
      const outcome = await NaukriJob.updateMany(
        { ...scope, applyStatus: { $in: ['skipped', 'failed'] } },
        { $set: { applyStatus: 'dismissed', retryable: false, priority: 0 },
          $push: { applyHistory: { at: now, from: 'skipped', to: 'dismissed', note: str(reason, 300) || 'dismissed by you' } } },
      );
      const proposal = await NaukriJob.updateMany(
        { ...scope, applyStatus: 'none' },
        { $set: { approval: 'rejected', rejectedReason: str(reason, 300) || 'dismissed' } },
      );
      result = { modifiedCount: outcome.modifiedCount + proposal.modifiedCount };

    } else if (action === 'allow-duplicate') {
      // "Apply anyway": you have seen that another platform already applied to
      // this role and want this one sent too. Back to Waiting, and the
      // apply-time duplicate skip leaves it alone from now on.
      const rows = await NaukriJob.find({ ...scope, applyStatus: { $in: ['none', 'skipped', 'failed', 'dismissed'] } }, { applyStatus: 1 }).lean();
      for (const j of rows) {
        await NaukriJob.updateOne({ _id: j._id }, {
          $set: { dupOverride: true, applyStatus: 'none', retryable: true, approval: 'approved', approvedAt: now, approvedBy: 'you', applyNote: '' },
          $push: { applyHistory: { at: now, from: j.applyStatus, to: 'none', note: 'apply anyway: duplicate allowed by you' } },
        });
      }
      result = { modifiedCount: rows.length };

    } else {
      return res.status(400).json({ error: 'action must be apply-next, skip, requeue, restore, dismiss or allow-duplicate' });
    }

    res.json({ updated: result.modifiedCount, run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/naukri/jobs/:id — manual applyStatus moves as recruiters reply.
router.patch('/jobs/:id', async (req, res) => {
  try {
    const { applyStatus, applyNote } = req.body || {};
    const job = await NaukriJob.findOne({ _id: req.params.id, userId: req.userId, ...BASE_FILTER });
    if (!job) return res.status(404).json({ error: 'No such job' });

    if (applyStatus !== undefined) {
      const allowed = NaukriJob.schema.path('applyStatus').enumValues;
      if (!allowed.includes(applyStatus)) return res.status(400).json({ error: 'Unknown applyStatus' });
      if (applyStatus !== job.applyStatus) {
        job.applyHistory.push({ at: new Date(), from: job.applyStatus, to: applyStatus, note: str(applyNote, 500) });
        job.applyStatus = applyStatus;
        if (applyStatus === 'applied' && !job.appliedAt) job.appliedAt = new Date();
      }
    }
    if (applyNote !== undefined) job.applyNote = str(applyNote, 500);

    await job.save();
    res.json({ job: job.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Worker endpoints (worker token, exact paths in server.js) ──────────────

// POST /api/naukri/claim — heartbeat, materialise due scheduled runs, then claim
// at most one. All in one round trip because the worker polls every 20s and each
// call is a serverless cold-start candidate.
router.post('/claim', async (req, res) => {
  try {
    const { host, chromeUp, naukriLoggedIn, loggedIn, nextWakeAt, probeOnly } = req.body || {};
    const platform = req.platform;
    const pq = platformQuery(platform);
    const label = labelOf(platform);

    const worker = await NaukriWorker.getForUser(req.userId, platform);
    const prevSeenAt = worker.lastSeenAt;
    worker.lastSeenAt = new Date();
    if (host !== undefined) worker.host = str(host, 200);
    if (chromeUp !== undefined) worker.chromeUp = !!chromeUp;
    // `loggedIn` from a platform worker; `naukriLoggedIn` from older Naukri
    // workers. Both fields are written so either reader is right.
    const li = loggedIn !== undefined ? loggedIn : naukriLoggedIn;
    if (li !== undefined) { worker.loggedIn = !!li; worker.naukriLoggedIn = !!li; }
    if (nextWakeAt !== undefined) {
      const d = nextWakeAt ? new Date(nextWakeAt) : null;
      worker.nextWakeAt = d && !isNaN(d.getTime()) ? d : null;
    }
    await worker.save();
    // Back after an outage long enough to have been reported: say so once.
    if (prevSeenAt && Date.now() - new Date(prevSeenAt).getTime() > WORKER_OFFLINE_MS) await workerBack(req.userId, platform, prevSeenAt);

    const fullConfig = await NaukriConfig.getForUser(req.userId);
    const config = siteOf(fullConfig, platform);
    // Sent on EVERY response, idle ones included, so a changed check-in
    // interval reaches the worker without a restart.
    const pollSeconds = (config.worker && config.worker.pollSeconds) || 20;
    // Every answer carries the check-in interval, and — for a worker that asked
    // for hints — when to come back (nextPollFor).
    const send = async (body, { fast = false } = {}) => res.json({
      ...body, pollSeconds,
      ...(req.body && req.body.hints === true
        ? { nextPollSeconds: await nextPollFor(req.userId, platform, config, worker, pollSeconds, fast) } : {}),
    });
    if (!isEnabled(config, platform)) return send({ run: null, paused: true, disabled: true });
    if (config.safety.pauseAll) return send({ run: null, paused: true });
    if (blockedUntilOf(worker)) return send({ run: null, blockedUntil: worker.blockedUntil });

    // A heartbeat with no appetite for work. The worker sends this when the
    // LinkedIn harvest is holding the shared debug Chrome: it must keep the tab
    // saying "ready" for the length of that run — which can be an hour — but
    // must not claim a run it cannot execute, and must not fire the schedule
    // below on its behalf.
    if (probeOnly) return send({ run: null, busy: true }, { fast: true });

    await failStaleRuns(req.userId);

    // Materialise the scheduled runs if an occurrence is due and nothing is
    // already active. One occurrence fans out into the runs its slot asks for,
    // created in execution order: refresh, then harvest, then apply.
    const due = dueSlot(config.schedule, new Date());
    if (due) {
      const active = await NaukriRun.findOne({ userId: req.userId, status: { $in: ACTIVE }, ...pq, ...BASE_FILTER }).lean();
      // A slot that comes due while a run is active WAITS for it rather than
      // being spent: it fires on the first poll after the active run ends, as
      // long as that is still inside catchUpHours. Spending it lost the whole
      // day's scheduled work whenever a manual run overlapped the slot.
      if (!active) {
        const dryRun = applyModeOf(config, platform) === 'dry-run';
        // Only steps this platform can do, and apply only while apply is on.
        for (const kind of due.kinds.filter(k => !kindBlocked(k, config, platform))) {
          await NaukriRun.create({ userId: req.userId, platform, kind, trigger: 'scheduled', dryRun });
        }
        // Stamped to the OCCURRENCE, not to now, so a late catch-up doesn't
        // drag the next slot forward.
        config.schedule.lastFiredAt = due.at;
        await fullConfig.save();
      }
    }

    // Optional (Configuration → Platforms): runs across platforms go out
    // oldest first. Hold this platform back while another ready platform has
    // an older queued run — its own worker will take it on its next poll.
    if (fullConfig.crossPlatformOrder) {
      const mine = await NaukriRun.findOne({ userId: req.userId, status: 'queued', ...pq, ...BASE_FILTER }, { createdAt: 1 }).sort({ createdAt: 1 }).lean();
      if (mine) {
        for (const other of PLATFORM_IDS.filter(p => p !== platform)) {
          const site = siteOf(fullConfig, other);
          if (!isEnabled(site, other) || site.safety.pauseAll) continue;
          const w = await NaukriWorker.findOne({ userId: req.userId, ...platformQuery(other) }).lean();
          if (!w || blockedUntilOf(w) || !isOnline(w)) continue;
          const older = await NaukriRun.exists({ userId: req.userId, status: 'queued', createdAt: { $lt: mine.createdAt }, ...platformQuery(other), ...BASE_FILTER });
          if (older) return send({ run: null, waiting: labelOf(other) }, { fast: true });
        }
      }
    }

    const run = await NaukriRun.findOneAndUpdate(
      { userId: req.userId, status: 'queued', ...pq, ...BASE_FILTER },
      { $set: { status: 'running', claimedAt: new Date(), workerHost: str(host, 200) } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!run) return send({ run: null });

    // Everything the worker needs to execute, in the same response — it must not
    // need a second round trip mid-run.
    const payload = {
      run: run.toJSON(),
      pollSeconds,
      config: {
        platform,
        searches: config.searches.filter(s => s.enabled),
        searchLimits: config.searchLimits,
        // This run's own choice if it made one, else the default.
        sources: (run.sources && (run.sources.searches || run.sources.recommended)) ? run.sources : config.sources,
        useRecommended: platform === 'naukri' ? fullConfig.useRecommended : !!(config.sources && config.sources.recommended),
        filters: config.filters,
        profile: fullConfig.profile,
        answers: fullConfig.answers.filter(a => a.enabled),
        // Whether the worker may ask /ai-answer mid-questionnaire. The server
        // re-checks it (and the threshold) on every call regardless.
        autoAnswer: { enabled: !!(fullConfig.autoAnswer && fullConfig.autoAnswer.enabled) },
        onUnknownQuestion: fullConfig.onUnknownQuestion,
        apply: config.apply,
        headlineVariants: platform === 'naukri' ? fullConfig.headlineVariants : [],
        headlineIndex: platform === 'naukri' ? fullConfig.headlineIndex : 0,
        dryRun: !!run.dryRun,
      },
    };

    if (run.kind === 'apply') {
      // Apply turned off (or capability withdrawn) after this run was queued:
      // it runs empty rather than sending anything.
      const mode = applyModeOf(config, platform);
      const doneToday = await appliedToday(req.userId, config.schedule.timezone, platform);
      const budget = mode === 'off' ? 0 : Math.max(0, Math.min(
        config.apply.maxPerRun,
        config.apply.maxPerDay - doneToday
      ));
      // A real run must never be handed jobs while the mode says rehearse.
      if (mode === 'dry-run' && !run.dryRun) { run.dryRun = true; await run.save(); payload.run.dryRun = true; payload.config.dryRun = true; }
      let candidates = budget === 0 ? [] : queueOrder(await NaukriJob.find({
        userId: req.userId,
        ...pq,
        // Exactly what the Waiting tab lists, so "waiting" and "what the next
        // run takes" cannot disagree. Skips are NOT claimed: one blocked on a
        // question is moved back here by requeueAnswered the moment a rule
        // answers it, and retrying it before then only re-asked the same
        // question and spent the budget the jobs behind it needed.
        ...WAITING_FILTER,
        // Predicted company-site jobs are left out too — the worker would only
        // skip them — unless you picked them yourself (priority), in which case
        // you have asked for the attempt.
        $or: [{ likelyExternal: { $ne: true } }, { priority: { $gt: 0 } }],
        ...BASE_FILTER,
      // Apply early: the order is lib/naukriQueue.js queueOrder — anything
      // you picked first, then freshest postings, then best fit. Sorted in JS
      // because "how fresh" is read from Naukri's own words ("3 days ago").
      }).limit(5000).lean());

      // Duplicates across platforms, checked HERE — at the last moment before
      // the worker clicks. Runs are serialised on the Mac (one Chrome, one
      // lock), so another platform's applications are already recorded by the
      // time this claim happens. A job another platform has applied to is
      // skipped with that reason (never sent twice), unless you chose "Apply
      // anyway". Not for a dry run: a rehearsal sends nothing.
      const dupRule = fullConfig.duplicates || {};
      if (dupRule.blockApply !== false && !run.dryRun && candidates.length) {
        const look = candidates.slice(0, budget * 3 + 20).filter(j => !j.dupOverride);
        const dupes = await dupesFor(NaukriJob, req.userId, look, { windowDays: dupRule.windowDays || 60 });
        const now = new Date();
        const dropped = new Set();
        for (const j of look) {
          const d = dupes.get(String(j._id));
          if (!blocksApply(d)) continue;
          dropped.add(String(j._id));
          const note = dupText(d);
          await NaukriJob.updateOne({ _id: j._id, userId: req.userId, applyStatus: { $in: ['none', 'failed'] } }, {
            $set: { applyStatus: 'skipped', retryable: false, priority: 0, applyNote: note, unknownQuestion: '', questionOptions: [] },
            $push: { applyHistory: { at: now, from: j.applyStatus, to: 'skipped', note } },
          });
          await NaukriRun.updateOne({ _id: run._id }, {
            $push: { results: { jobId: j._id, title: j.title, company: j.company, outcome: 'skipped', reason: note, at: now } },
            $inc: { 'stats.dupSkipped': 1 },
          });
        }
        if (dropped.size) candidates = candidates.filter(j => !dropped.has(String(j._id)));
      }
      payload.jobs = candidates.slice(0, budget).map(serialize);
      payload.budget = { perRun: config.apply.maxPerRun, perDay: config.apply.maxPerDay, doneToday, granted: budget };
    }

    // The refresh rotates through the headline variants, so each daily save is a
    // real edit rather than the same string written back. Advanced here, at
    // claim time, so a crashed run still moves on rather than retrying the same
    // variant forever.
    if (run.kind === 'refresh' && platform === 'naukri' && fullConfig.headlineVariants.length) {
      fullConfig.headlineIndex = (fullConfig.headlineIndex + 1) % fullConfig.headlineVariants.length;
      await fullConfig.save();
    }

    return send(payload, { fast: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/ingest — harvested rows from the worker. Idempotent by
// sourceKey, and it may only ever CREATE a job as pending: your approval and
// apply state go in $setOnInsert so a re-harvest cannot reset a decision.
router.post('/ingest', async (req, res) => {
  try {
    const { runId, jobs } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be an array' });

    const run = await NaukriRun.findOne({ _id: runId, userId: req.userId, ...PQ(req), ...BASE_FILTER });
    if (!run) return res.status(404).json({ error: 'No such run' });

    const platform = req.platform;
    const pq = platformQuery(platform);
    let created = 0, updated = 0, skipped = 0, autoApproved = 0, dupHeld = 0;
    const now = new Date();
    const fullConfig = await NaukriConfig.getForUser(req.userId);
    const site = siteOf(fullConfig, platform);
    // Scoring reads this platform's searches and filters with the shared profile.
    const config = platform === 'naukri' ? fullConfig
      : { searches: site.searches, filters: site.filters, profile: fullConfig.profile };
    const auto = site.apply.autoApproveEnabled && !site.safety.pauseAll;
    const minScore = site.apply.autoApproveMinScore ?? 80;
    const dupRule = fullConfig.duplicates || {};

    // Employers already known to hand off to their own site. Apply type is a
    // property of the employer far more than the role, so this predicts most of
    // them for free — no extra page loads, no extra traffic to Naukri. Computed
    // once per ingest call rather than per row. Read from the history as well
    // as the current note, so requeueing one job does not erase what was
    // learned about its employer.
    const externalCompanies = new Set(
      (await NaukriJob.distinct('company', {
        userId: req.userId,
        $or: [{ applyNote: EXTERNAL_SKIP }, { 'applyHistory.note': EXTERNAL_SKIP }],
        ...pq,
        ...BASE_FILTER,
      })).filter(Boolean).map(c => c.toLowerCase())
    );

    for (const raw of jobs.slice(0, 500)) {
      const sourceId = str(raw && raw.sourceId, 100);
      const title = str(raw && raw.title, 300);
      if (!sourceId || !title) { skipped++; continue; }
      // `naukri:<id>`, `instahyre:<id>` … — the same site id on two platforms
      // is two different jobs, and the unique index already keys on this.
      const sourceKey = `${platform}:${sourceId}`;
      const queries = cleanList(raw.queries, 20);
      // Older workers send no origins; everything they harvested came from a search.
      // 'recruiter' = a recruiter on the site reached out about it (Instahyre).
      const origins = (Array.isArray(raw.origins) ? raw.origins : ['search']).filter(o => o === 'search' || o === 'recommended' || o === 'recruiter');
      const dupKey = dupKeyOf({ company: raw.company, title });
      // Naukri's own feed (Recommended jobs) states it outright; otherwise it is
      // predicted from employers already seen sending people off-site.
      const likelyExternal = raw.companySite === true || externalCompanies.has(str(raw.company, 200).toLowerCase());
      const postedAt = raw.postedAt && !isNaN(new Date(raw.postedAt)) ? new Date(raw.postedAt) : null;
      // Scored on every harvest, so a change to your searches or skills is
      // reflected the next time a job is seen.
      const fit = scoreJob({
        title, tags: raw.tags, description: raw.description, experienceMin: raw.experienceMin,
        experienceMax: raw.experienceMax, salaryText: raw.salaryText, postedText: raw.postedText, likelyExternal, origins,
        ...(platform !== 'naukri' ? { platformLabel: labelOf(platform) } : {}),
      }, config);

      const result = await NaukriJob.updateOne(
        { userId: req.userId, sourceKey },
        {
          $set: {
            title,
            company:  str(raw.company, 200),
            location: str(raw.location, 200),
            experienceMin: num(raw.experienceMin, { min: 0, max: 50 }),
            experienceMax: num(raw.experienceMax, { min: 0, max: 50 }),
            salaryText: str(raw.salaryText, 200),
            tags: cleanList(raw.tags, 20, 60),
            url: str(raw.url, 1000),
            description: str(raw.description, 5000),
            postedText: str(raw.postedText, 100),
            lastSeenAt: now,
            // Re-evaluated on every harvest, so a company that turns out to be
            // external gets its other listings flagged next time round.
            likelyExternal,
            ...(postedAt ? { postedAt } : {}),
            score: fit.score,
            scoreReasons: fit.reasons,
            dupKey,
          },
          $setOnInsert: {
            userId: req.userId, platform, sourceId, sourceKey,
            firstSeenAt: now,
            // A harvest may only ever propose. Nothing here may pre-approve.
            approval: 'pending',
            applyStatus: 'none',
            applyHistory: [],
          },
          $inc: { seenCount: 1 },
          $addToSet: { queries: { $each: queries }, origins: { $each: origins } },
        },
        { upsert: true }
      );

      if (result.upsertedCount) created++;
      else if (result.modifiedCount) updated++;
      else skipped++;

      // Recruiters this platform showed for the job: addresses in its text plus
      // any the feed named. Pushed one by one by identity, so a re-harvest adds
      // what is new and never duplicates or drops what an earlier one found.
      for (const r of recruitersFor({ description: raw.description, feed: raw.recruiters })) {
        await NaukriJob.updateOne(
          { userId: req.userId, sourceKey, 'recruiters.key': { $ne: r.key } },
          { $push: { recruiters: { $each: [r], $slice: -MAX_RECRUITERS } } },
        );
      }

      // Auto-approve: NEW rows only, so a job you moved back to Review by hand
      // is never re-approved behind your back by the next harvest. Never a
      // predicted company-site job. Approving only moves it to Waiting — it
      // goes out at the next scheduled apply run, inside the daily cap; no run
      // is queued from here.
      if (auto && result.upsertedCount && !likelyExternal && fit.score >= minScore) {
        // Never auto-approve a role already applied to or approved on another
        // platform: it stays in the inbox with its duplicate badge, for you.
        if (dupRule.blockAuto !== false && dupKey) {
          const me = { _id: 'new', dupKey, platform };
          const d = (await dupesFor(NaukriJob, req.userId, [me], { windowDays: dupRule.windowDays || 60 })).get('new');
          if (blocksAuto(d)) { dupHeld++; continue; }
        }
        const ok = await NaukriJob.updateOne(
          { userId: req.userId, sourceKey, approval: 'pending', applyStatus: 'none' },
          { $set: { approval: 'approved', approvedAt: now, approvedBy: 'auto' } },
        );
        if (ok.modifiedCount) autoApproved++;
      }
    }

    await NaukriRun.updateOne({ _id: runId, userId: req.userId }, {
      $inc: { 'stats.found': created + updated, 'stats.new': created, 'stats.updated': updated, 'stats.autoApproved': autoApproved },
    });

    const tidied = await tidyInbox(req.userId, fullConfig, platform);
    res.json({ created, updated, skipped, autoApproved, tidied, dupHeld });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/progress — live progress. A plain overwrite with no history:
// the worker is the only writer, events arrive in order, and a dropped update is
// corrected by the next one. The worker never blocks a run on this call.
router.post('/progress', async (req, res) => {
  try {
    const { runId, progress } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!progress || typeof progress !== 'object') {
      return res.status(400).json({ error: 'progress object is required' });
    }

    // Only while the run is actually running — a late event must not resurrect
    // the progress block of a run that already failed or was cancelled.
    const run = await NaukriRun.findOneAndUpdate(
      { _id: runId, userId: req.userId, status: 'running', ...PQ(req), ...BASE_FILTER },
      { $set: { progress: {
          phase:      str(progress.phase, 40),
          label:      str(progress.label, 300),
          page:       Number(progress.page) || 0,
          pagesTotal: Number(progress.pagesTotal) || 0,
          found:      Number(progress.found) || 0,
          new:        Number(progress.new) || 0,
          applied:    Number(progress.applied) || 0,
          skipped:    Number(progress.skipped) || 0,
          failed:     Number(progress.failed) || 0,
          updatedAt:  new Date(),
        } } },
      { new: true, projection: { progress: 1, status: 1 } }
    );
    if (!run) return res.status(404).json({ error: 'No running run with that id' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/result — one job's outcome, reported as it happens rather
// than batched at the end. An apply run that dies halfway must still leave a
// truthful record of what it already sent.
router.post('/result', async (req, res) => {
  try {
    const { runId, jobId, outcome, reason, question, options, terminal } = req.body || {};
    if (!runId || !jobId) return res.status(400).json({ error: 'runId and jobId are required' });
    if (!['applied', 'skipped', 'failed', 'dry-run'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be applied, skipped, failed or dry-run' });
    }

    // Scoped to this platform: an Instahyre worker can only ever report on an
    // Instahyre job.
    const job = await NaukriJob.findOne({ _id: jobId, userId: req.userId, ...PQ(req), ...BASE_FILTER });
    if (!job) return res.status(404).json({ error: 'No such job' });

    // Already recorded: the worker retries a report whose response it never
    // saw (a network blip after the server had processed it), and replays
    // saved results when the connection comes back. Recording it twice would
    // double the history and the run's counts.
    const already = await NaukriRun.exists({
      _id: runId, userId: req.userId, results: { $elemMatch: { jobId: job._id, outcome } },
    });
    if (already) return res.json({ ok: true, duplicate: true });

    // A dry run rehearses; it must leave no trace on the job that would make it
    // look applied to, or stop a real run from picking it up later.
    if (outcome !== 'dry-run') {
      const to = outcome === 'applied' ? 'applied' : outcome;
      job.applyHistory.push({ at: new Date(), from: job.applyStatus, to, note: str(reason, 500) });
      job.applyStatus = to;
      job.applyNote = str(reason, 500);
      job.unknownQuestion = outcome === 'skipped' ? str(question, 500) : '';
      // What the question offered, so the AI draft picks one of these.
      job.questionOptions = outcome === 'skipped' && job.unknownQuestion ? cleanList(options, 20, 200) : [];
      // A terminal skip can never succeed — an external ATS, or one Naukri says
      // is already applied to. Marking it keeps the next run from spending its
      // budget re-attempting it instead of reaching the jobs behind it.
      // Inferred from the reason as well as the worker's flag, so an out-of-date
      // worker cannot quietly reintroduce the loop this prevents.
      if (terminal || TERMINAL_SKIP.test(str(reason, 500))) job.retryable = false;
      // Spent. Priority is "send this next", not "send this first forever" — a
      // job that kept it would outrank everything on every future run.
      job.priority = 0;
      if (outcome === 'applied') job.appliedAt = new Date();
      await job.save();
    }

    if (outcome === 'failed') {
      reportIssue({
        userId: req.userId, source: 'job', area: req.platform, kind: 'apply_failed',
        message: `${LABEL(req)} apply failed for "${job.title}" at ${job.company}${reason ? `: ${str(reason, 500)}` : ''}`,
        key: `apply_failed ${str(reason, 500).replace(/\d+/g, '')}`,
        meta: { runId: String(runId), jobId: String(job._id) },
      });
    }

    await NaukriRun.updateOne(
      { _id: runId, userId: req.userId, status: 'running', ...BASE_FILTER },
      { $push: { results: {
          jobId: job._id, title: job.title, company: job.company,
          outcome, reason: str(reason, 500), at: new Date(),
        } } }
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/track — worker token. Rows read from Naukri's own
// application history (applyapi/v5/history, the "My applies" page). Each is
// matched to a job WE applied to by Naukri's job id; its furthest stage
// (viewed, shortlisted, contacted, not shortlisted) is recorded, and a job
// still at "applied" in your pipeline moves on (shortlisted/contacted → in
// review, not shortlisted → rejected). Your own pipeline edits are never
// overwritten. Applications made outside this app are counted, not stored.
router.post('/track', async (req, res) => {
  try {
    const { runId, rows } = req.body || {};
    if (!runId || !Array.isArray(rows)) return res.status(400).json({ error: 'runId and rows are required' });
    const now = new Date();
    // Naukri prints "2026-10-18 11:35:12" in India time. Anything unreadable
    // becomes null rather than failing the whole sync.
    const ist = (v) => {
      if (!v) return null;
      const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(' ', 'T')}+05:30` : v);
      return isNaN(d.getTime()) ? null : d;
    };
    let matched = 0, moved = 0;
    const news = [];
    for (const row of rows.slice(0, 2000)) {
      const jobId = str(row && row.jobId, 100);
      if (!jobId) continue;
      // By the site's own job id, on THIS platform only — ids are only unique
      // within one site.
      const job = await NaukriJob.findOne({ userId: req.userId, sourceId: jobId, ...PQ(req), ...BASE_FILTER });
      if (!job) continue;
      matched++;
      const { stage, at, timeline } = readStatus(row);
      const set = {
        naukriTimeline: timeline.slice(0, 20).map(t => ({ id: t.id, value: str(t.value, 80), at: ist(t.at) })),
        listingOpen: row.isOpen === undefined ? null : String(row.isOpen) === 'true',
        trackedAt: now,
      };
      const changed = stage !== job.naukriStage;
      if (changed) {
        set.naukriStage = stage;
        set.naukriStageAt = ist(at) || now;
      }
      const update = { $set: set };
      // Move the pipeline only from 'applied' — never over your own edits.
      if (changed && job.applyStatus === 'applied' && (stage === 'shortlisted' || stage === 'contacted' || stage === 'not-shortlisted')) {
        const to = stage === 'not-shortlisted' ? 'rejected' : 'in-review';
        set.applyStatus = to;
        update.$push = { applyHistory: { at: now, from: 'applied', to, note: `${LABEL(req)}: ${stage.replace('-', ' ')}` } };
        moved++;
      }
      if (changed && (stage === 'shortlisted' || stage === 'contacted')) news.push(`${job.title} · ${job.company}`);
      await NaukriJob.updateOne({ _id: job._id }, update);
    }
    await NaukriRun.updateOne({ _id: runId, userId: req.userId }, { $inc: { 'stats.tracked': matched, 'stats.moved': moved } });
    if (news.length) {
      // Same notification types as always (no history to migrate); the
      // platform rides in the title and in meta.platform.
      const on = req.platform === 'naukri' ? '' : ` (${LABEL(req)})`;
      await notify(req.userId, {
        type: 'naukri.applied',
        title: news.length === 1 ? `Recruiter interest: ${news[0]}${on}` : `${news.length} applications shortlisted or contacted${on}`,
        body: news.slice(0, 5).join('\n'),
        link: pageLink(req.platform),
        dedupeKey: `naukri.track:${runId}:${news.length}`,
        meta: { platform: req.platform },
      });
    }
    res.json({ matched, moved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/naukri/finish — terminal state for a run.
router.post('/finish', async (req, res) => {
  try {
    const { runId, status, stats, error, exitCode } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!['done', 'failed', 'blocked'].includes(status)) {
      return res.status(400).json({ error: 'status must be done, failed or blocked' });
    }

    const update = { status, finishedAt: new Date() };
    if (error !== undefined) update.error = error ? str(error, 2000) : null;
    if (exitCode !== undefined) update.exitCode = Number.isFinite(exitCode) ? exitCode : null;
    if (stats && typeof stats === 'object') {
      // Merged, not replaced: /ingest has already been $inc-ing found/new/updated
      // across chunks, and overwriting them here would throw that away.
      for (const k of ['applied', 'skipped', 'failed', 'rehearsed', 'searches', 'recommended']) {
        if (stats[k] !== undefined) update[`stats.${k}`] = Number(stats[k]) || 0;
      }
    }

    const run = await NaukriRun.findOneAndUpdate(
      { _id: runId, userId: req.userId, ...PQ(req), ...BASE_FILTER },
      { $set: update },
      { new: true }
    );
    if (!run) return res.status(404).json({ error: 'No such run' });
    const label = LABEL(req);
    const link = pageLink(req.platform);
    const on = req.platform === 'naukri' ? '' : ` on ${label}`;

    if (status !== 'done') {
      reportIssue({
        userId: req.userId, source: 'job', area: req.platform, kind: `run_${status}`,
        message: status === 'blocked'
          ? `${label} showed a captcha — runs paused${error ? `: ${error}` : ''}`
          : `${label} run failed${error ? `: ${error}` : ''}`,
        detail: error ? String(error) : '',
        key: `${req.platform} ${status} ${exitCode == null ? '' : exitCode}`,
        meta: { runId: String(runId), exitCode: exitCode ?? null, stats: stats || null },
      });
    }

    if (status === 'done') {
      const applied = run.stats?.applied || 0;
      if (applied > 0) {
        await notify(req.userId, {
          type: 'naukri.applied',
          title: `Applied to ${applied} job${applied === 1 ? '' : 's'}${on}`,
          body: run.stats?.failed ? `${run.stats.failed} could not be applied to.` : '',
          link,
          dedupeKey: `naukri.applied:${run._id}`,
          meta: { platform: req.platform },
        });
      }
    } else {
      // A captcha or a failed run is something only the user can clear (sign in,
      // solve it on the Mac), so it is raised as "needs you".
      const reason = error ? str(error, 200).split('\n')[0] : '';
      await notify(req.userId, {
        type: 'naukri.attention',
        title: status === 'blocked' ? `${label} showed a captcha — runs paused` : `${label} run failed`,
        body: reason || (status === 'blocked'
          ? `${label} runs are paused for a week. Other platforms keep running.`
          : `Check that you are signed in to ${label} on your Mac.`),
        link,
        dedupeKey: `naukri.attention:${run._id}`,
        meta: { platform: req.platform },
      });
    }

    // A captcha means Naukri challenged the session. The answer is to stop for a
    // week, so the block lives here rather than in the worker — a restarted
    // worker must not be able to shrug it off, and neither must the schedule.
    // Only THIS platform's worker is blocked: a Hirist captcha must not stop
    // Naukri or Instahyre.
    if (status === 'blocked') {
      const worker = await NaukriWorker.getForUser(req.userId, req.platform);
      worker.blockedUntil = new Date(Date.now() + BLOCK_MS);
      worker.blockedReason = str(error, 300) || `${label} showed a captcha during a run`;
      await worker.save();
    }

    res.json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
