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
const { resolveAnswer, matchable, STARTER_RULES } = require('../lib/naukriAnswers');
const { scoreJob } = require('../lib/naukriScore');
// Called through the module object (naukriDraft.draftAnswer), not a
// destructured copy, so the end-to-end test can swap in a scripted AI.
const naukriDraft = require('../lib/naukriDraft');
const { applyFilters, parseSalaryLpa, parsePostedAgeDays, cityVariants } = require('../lib/naukriFilters');
const { reportIssue } = require('../lib/issues');
const { notify } = require('../lib/notify');
const { WORKER_OFFLINE_MS, workerBack } = require('../lib/workerWatch');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };
const ACTIVE = ['queued', 'running'];
const KINDS = ['refresh', 'harvest', 'apply', 'probe'];

// A worker polls every 20s; 90s of silence means the Mac slept or the process died.
const ONLINE_MS = 90_000;
// A claimed run whose worker vanished mid-flight: nothing from it — no
// progress, no result — for this long. Measured from its LAST sign of life,
// not from when it started, so a long run that is still working is never cut
// off now that run size has no ceiling. Every job and every page posts
// progress; the slowest single step (a job with live AI answers) is ~3 min.
const STALE_RUN_MS = 30 * 60_000;
// Naukri showed a captcha. Same doctrine as the LinkedIn checkpoint: stop for a
// week, and do not let a worker restart shrug it off.
const BLOCK_MS = 7 * 24 * 3600 * 1000;

// The statuses that mean an application actually left, plus where it got to
// afterwards. Deliberately excludes 'skipped' and 'failed': those are jobs the
// worker looked at and backed out of, so listing them under "Applied" claims
// work that never happened. They remain visible in Waiting, which is where you
// can act on them.
const SENT_STATUSES = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];

// Skips that no future run can turn into an application.
//
// The worker also sends `terminal: true` for these, but the SERVER decides,
// because the worker is a separate process on a machine you update by hand. A
// worker running last week's code kept reporting company-site skips as ordinary
// ones, and they went straight back into the queue to be attempted again. The
// rule belongs where it cannot drift.
const TERMINAL_SKIP = /applies on the company site|already applied|walk-in drive|listing closed or removed/i;
// Only this one says anything about the EMPLOYER. "Already applied" is about
// you and that one listing, and counting it here flagged every other job from
// a company you had applied to once as company-site.
const EXTERNAL_SKIP = /applies on the company site/i;

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
async function requeueAnswered(userId, config) {
  const blocked = await NaukriJob.find(
    { userId, approval: 'approved', ...SKIP_BUCKETS['needs-answer'], ...BASE_FILTER },
    { unknownQuestion: 1, applyNote: 1 },
  ).lean();
  const bank = { answers: config.answers, profile: config.profile };
  const ready = blocked.filter(j => resolveAnswer(j.unknownQuestion, bank).matched);
  if (!ready.length) return 0;
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
  obj.id = doc._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

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

// A run left 'running' by a worker that was killed would block the queue
// forever, since /claim only ever starts one at a time.
const failStaleRuns = (userId) => {
  const now = new Date();
  return NaukriRun.updateMany(
    {
      userId, status: 'running', claimedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) },
      $or: [{ 'progress.updatedAt': null }, { 'progress.updatedAt': { $lt: new Date(Date.now() - STALE_RUN_MS) } }],
      ...BASE_FILTER,
    },
    { $set: { status: 'failed', error: 'Worker stopped responding mid-run', finishedAt: now } }
  ).then(r => reportStaleRuns(NaukriRun, 'naukri', userId, now, r));
};

// Reported only when a run was actually swept, so the common no-op call costs
// nothing extra.
const reportStaleRuns = async (Model, area, userId, since, result) => {
  if (!result || !result.modifiedCount) return result;
  const runs = await Model.find(
    { ...(userId ? { userId } : {}), status: 'failed', error: 'Worker stopped responding mid-run', finishedAt: { $gte: since } },
    { userId: 1, startedAt: 1, claimedAt: 1 },
  ).lean().catch(() => []);
  for (const r of runs) {
    reportIssue({
      userId: r.userId, source: 'job', area, kind: 'run_stalled',
      message: 'Worker stopped responding mid-run — the run was marked failed',
      meta: { runId: String(r._id), claimedAt: r.claimedAt || null },
    });
  }
  return result;
};

const blockedUntilOf = (worker) => {
  const until = worker && worker.blockedUntil ? new Date(worker.blockedUntil) : null;
  return until && until > new Date() ? until : null;
};

// How many applications have gone out since midnight in YOUR timezone (the
// schedule's), for apply.maxPerDay. The server runs in UTC, and counting from
// its midnight reset the cap at 05:30 IST. Counted from NaukriJob rather than
// summed off run stats, because the jobs are the thing that actually left — a
// failed run that applied to three before dying still spent three.
const appliedToday = (userId, timeZone) => {
  let since;
  try { since = startOfDayIn(timeZone || 'Asia/Kolkata'); }
  catch (_) { since = new Date(); since.setHours(0, 0, 0, 0); }
  return NaukriJob.countDocuments({ userId, appliedAt: { $gte: since }, ...BASE_FILTER });
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

// ── Owner endpoints ────────────────────────────────────────────────────────
// IMPORTANT: literal paths are declared before any /:id route, or Express
// matches them as an id.

// GET /api/naukri/overview — one call drives the whole tab. The worker fields
// exist so the UI can say "your Mac is asleep, this runs at 09:25" BEFORE you
// trigger anything, rather than leaving a queued row looking broken.
router.get('/overview', async (req, res) => {
  try {
    await failStaleRuns(req.userId);
    const config = await NaukriConfig.getForUser(req.userId);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [worker, activeRun, queued, history, reviewCount, appliedCount, todayCount, waitingCount, skippedCount, needsAnswerCount, week] = await Promise.all([
      NaukriWorker.getForUser(req.userId),
      NaukriRun.findOne({ userId: req.userId, status: 'running', ...BASE_FILTER }).sort({ createdAt: 1 }).lean(),
      NaukriRun.find({ userId: req.userId, status: 'queued', ...BASE_FILTER }).sort({ createdAt: 1 }).limit(10).lean(),
      NaukriRun.find({ userId: req.userId, status: { $nin: ACTIVE }, ...BASE_FILTER }).sort({ createdAt: -1 }).limit(20).lean(),
      NaukriJob.countDocuments({ userId: req.userId, approval: 'pending', ...BASE_FILTER }),
      NaukriJob.countDocuments({ userId: req.userId, applyStatus: { $in: SENT_STATUSES }, ...BASE_FILTER }),
      appliedToday(req.userId, config.schedule.timezone),
      // Approved and genuinely queued to be sent. Deliberately excludes skips:
      // those have been looked at and backed out of, which is a different state
      // with a different next action, and mixing them made "138 waiting" mean
      // two unrelated things at once. They have their own tab.
      //
      // Appended LAST, matching the destructuring above. Adding a query in the
      // middle silently shifts every position after it — that is how the panel
      // once reported the waiting count as "applied today".
      NaukriJob.countDocuments({ userId: req.userId, ...WAITING_FILTER, ...BASE_FILTER }),
      NaukriJob.countDocuments({ userId: req.userId, ...ALL_SKIPPED, ...BASE_FILTER }),
      NaukriJob.countDocuments({ userId: req.userId, ...SKIP_BUCKETS['needs-answer'], ...BASE_FILTER }),
      // This week's outcomes, from the history entries the worker writes as it
      // goes — so a job retried twice counts as what it ended up as each time,
      // not as whatever it is now.
      NaukriJob.aggregate([
        { $match: { userId: req.userId, 'applyHistory.at': { $gte: weekAgo }, deleted: { $ne: true } } },
        { $unwind: '$applyHistory' },
        { $match: { 'applyHistory.at': { $gte: weekAgo }, 'applyHistory.to': { $in: ['applied', 'skipped', 'failed'] } } },
        { $group: { _id: '$applyHistory.to', n: { $sum: 1 } } },
      ]),
    ]);
    const weekOf = (k) => (week.find(w => w._id === k) || {}).n || 0;

    const lastSeenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt) : null;
    res.json({
      activeRun: serialize(activeRun),
      queuedRuns: queued.map(serialize),
      history: history.map(serialize),
      worker: {
        everSeen: !!lastSeenAt,
        online: !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_MS,
        lastSeenAt,
        host: worker.host || '',
        chromeUp: !!worker.chromeUp,
        naukriLoggedIn: !!worker.naukriLoggedIn,
        nextWakeAt: worker.nextWakeAt || null,
      },
      schedule: config.schedule,
      ...scheduleView(config.schedule),
      reviewCount,
      needsAnswerCount,
      week: { applied: weekOf('applied'), skipped: weekOf('skipped'), failed: weekOf('failed') },
      perRun: config.apply.maxPerRun,
      perDay: config.apply.maxPerDay,
      sources: config.sources,
      appliedCount,
      appliedToday: todayCount,
      waitingCount,
      skippedCount,
      // Surfaced separately from the config blob so the header can warn about
      // them without the client having to know which fields mean "unsafe".
      paused: !!config.safety.pauseAll,
      dryRun: !!config.safety.dryRun,
      autoApprove: !!config.apply.autoApproveEnabled,
      blockedUntil: blockedUntilOf(worker),
      blockedReason: worker.blockedReason || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration ──────────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try {
    const config = await NaukriConfig.getForUser(req.userId);
    const [eff, text] = await Promise.all([effectiveResume(req.userId, config), resumeTextFor(req.userId, config)]);
    const json = config.toJSON();
    // The resume the card shows is the one Naukri will USE — the Settings one
    // when no Naukri-only file was uploaded.
    json.resume = eff
      ? { filename: eff.filename, size: eff.size, uploadedAt: eff.uploadedAt, source: eff.source, text }
      : { filename: '', size: 0, uploadedAt: null, source: null, text };
    res.json({
      config: json,
      ...scheduleView(config.schedule),
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
    const config = await NaukriConfig.getForUser(req.userId);

    if (body.schedule) {
      const s = body.schedule;
      if (s.time !== undefined) {
        if (!parseTime(s.time)) return res.status(400).json({ error: 'time must be HH:mm' });
        config.schedule.time = str(s.time, 5);
      }
      if (s.days !== undefined) {
        const clean = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))]
          .filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
        if (!clean.length) return res.status(400).json({ error: 'Pick at least one day' });
        config.schedule.days = clean;
      }
      if (s.timezone !== undefined) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(s.timezone) }); }
        catch (_) { return res.status(400).json({ error: `Unknown timezone: ${s.timezone}` }); }
        config.schedule.timezone = String(s.timezone);
      }
      if (s.catchUpHours !== undefined) {
        const n = num(s.catchUpHours, { min: 0, max: 12 });
        if (n == null) return res.status(400).json({ error: 'catchUpHours must be between 0 and 12' });
        config.schedule.catchUpHours = n;
      }
      for (const k of ['runRefresh', 'runHarvest', 'runApply']) {
        if (s[k] !== undefined) config.schedule[k] = !!s[k];
      }
      // Slots 2 and 3. Each needs a valid time and at least one kind, and no
      // two slots may share a time — that would fire the same wake twice.
      if (s.extraSlots !== undefined) {
        const raw = Array.isArray(s.extraSlots) ? s.extraSlots : [];
        if (raw.length > MAX_SLOTS - 1) return res.status(400).json({ error: `At most ${MAX_SLOTS} times a day` });
        const seen = new Set([config.schedule.time]);
        const clean = [];
        for (const x of raw) {
          const time = str(x && x.time, 5);
          if (!parseTime(time)) return res.status(400).json({ error: `Each time must be HH:mm (got "${time}")` });
          if (seen.has(time)) return res.status(400).json({ error: `${time} is listed twice` });
          seen.add(time);
          const slot = { time, runRefresh: !!(x && x.runRefresh), runHarvest: !!(x && x.runHarvest), runApply: !!(x && x.runApply) };
          if (!slot.runRefresh && !slot.runHarvest && !slot.runApply) {
            return res.status(400).json({ error: `The ${time} slot has nothing to do — tick refresh, harvest or apply` });
          }
          clean.push(slot);
        }
        config.schedule.extraSlots = clean;
      }
      if (s.enabled !== undefined) {
        if (s.enabled && slotsOf({ ...config.schedule.toObject(), ...s, extraSlots: config.schedule.extraSlots }).length === 0) {
          return res.status(400).json({ error: 'Turn on at least one of refresh, harvest or apply' });
        }
        config.schedule.enabled = !!s.enabled;
        // Turning the schedule on must not immediately fire an occurrence from
        // earlier today — that would spend the day's budget the instant you
        // saved the form.
        if (s.enabled) config.schedule.lastFiredAt = new Date();
      }
    }

    if (body.searches !== undefined) {
      config.searches = (Array.isArray(body.searches) ? body.searches : []).slice(0, 20).map(s => ({
        label:    str(s && s.label, 100),
        keywords: str(s && s.keywords, 200),
        location: str(s && s.location, 100),
        experienceYears: num(s && s.experienceYears, { min: 0, max: 50, integer: true }),
        url:      str(s && s.url, 1000),
        enabled:  s && s.enabled !== false,
      })).filter(s => s.keywords || s.url);
    }
    if (body.useRecommended !== undefined) config.useRecommended = !!body.useRecommended;
    if (body.sources) {
      const next = cleanSources(body.sources, config.sources);
      if (!next) return res.status(400).json({ error: 'Pick at least one place to harvest from: your searches or recommended jobs' });
      config.sources = next;
    }
    if (body.searchLimits) {
      const l = body.searchLimits;
      if (l.maxSearches !== undefined) config.searchLimits.maxSearches = num(l.maxSearches, { min: 1, max: 10, integer: true }) ?? 10;
      if (l.maxPages !== undefined) config.searchLimits.maxPages = num(l.maxPages, { min: 1, max: 8, integer: true }) ?? 8;
    }
    if (body.worker && body.worker.pollSeconds !== undefined) {
      config.worker.pollSeconds = num(body.worker.pollSeconds, { min: 15, max: 120, integer: true }) ?? 20;
    }
    if (body.aiDrafts !== undefined) config.aiDrafts = !!body.aiDrafts;
    if (body.resumeText !== undefined) {
      config.resume.text = str(body.resumeText, 20000);
      // Cleared = go back to reading the resume file; anything typed is kept as yours.
      config.resume.textFrom = config.resume.text ? 'manual' : '';
    }

    if (body.filters) {
      const f = body.filters;
      for (const k of ['titleInclude', 'titleExclude', 'companyExclude', 'locations']) {
        if (f[k] !== undefined) config.filters[k] = cleanList(f[k]);
      }
      if (f.remoteOnly !== undefined) config.filters.remoteOnly = !!f.remoteOnly;
      if (f.skipAlreadyApplied !== undefined) config.filters.skipAlreadyApplied = !!f.skipAlreadyApplied;
      if (f.minExperienceYears !== undefined) config.filters.minExperienceYears = num(f.minExperienceYears, { min: 0, max: 50 });
      if (f.maxExperienceYears !== undefined) config.filters.maxExperienceYears = num(f.maxExperienceYears, { min: 0, max: 50 });
      if (f.minSalaryLpa !== undefined) config.filters.minSalaryLpa = num(f.minSalaryLpa, { min: 0, max: 1000 });
      if (f.maxPostedAgeDays !== undefined) config.filters.maxPostedAgeDays = num(f.maxPostedAgeDays, { min: 1, max: 365, integer: true });
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
      if (a.maxPerRun !== undefined) config.apply.maxPerRun = num(a.maxPerRun, { min: 1, integer: true }) ?? config.apply.maxPerRun;
      if (a.maxPerDay !== undefined) config.apply.maxPerDay = num(a.maxPerDay, { min: 1, integer: true }) ?? config.apply.maxPerDay;
      if (a.autoApproveEnabled !== undefined) config.apply.autoApproveEnabled = !!a.autoApproveEnabled;
      // Floor of 50: below that, "auto-approve" is approving jobs that match
      // under half of what you asked for.
      if (a.autoApproveMinScore !== undefined) config.apply.autoApproveMinScore = num(a.autoApproveMinScore, { min: 50, max: 100, integer: true }) ?? 80;
      if (a.delayMinMs !== undefined) config.apply.delayMinMs = num(a.delayMinMs, { min: 500, max: 60000, integer: true });
      if (a.delayMaxMs !== undefined) config.apply.delayMaxMs = num(a.delayMaxMs, { min: 500, max: 60000, integer: true });
      if (a.coverNote !== undefined) config.apply.coverNote = str(a.coverNote, 4000);
      // A max below the min would make the randomised gap negative, which reads
      // to Naukri as a script.
      if (config.apply.delayMaxMs < config.apply.delayMinMs) {
        config.apply.delayMaxMs = config.apply.delayMinMs;
      }
    }

    if (body.headlineVariants !== undefined) {
      config.headlineVariants = cleanList(body.headlineVariants, 20, 250);
    }

    if (body.safety) {
      if (body.safety.pauseAll !== undefined) config.safety.pauseAll = !!body.safety.pauseAll;
      if (body.safety.dryRun !== undefined) config.safety.dryRun = !!body.safety.dryRun;
    }

    await config.save();
    // A new rule — or a profile field a rule quotes — can unblock skipped jobs.
    const requeued = answersChanged ? await requeueAnswered(req.userId, config) : 0;
    res.json({ config: config.toJSON(), ...scheduleView(config.schedule), requeued });
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
    const filters = (req.body || {}).filters || config.filters;
    const jobs = await NaukriJob.find({ userId: req.userId, ...BASE_FILTER })
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
        { $match: { userId: req.userId, ...SKIP_BUCKETS['needs-answer'], deleted: { $ne: true } } },
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
        { $match: { userId: req.userId, ...SKIP_BUCKETS['needs-answer'], deleted: { $ne: true } } },
        { $sort: { updatedAt: -1 } },
        { $group: {
            _id: '$unknownQuestion',
            count: { $sum: 1 },
            lastSeenAt: { $max: '$updatedAt' },
            options: { $max: '$questionOptions' },
            jobs: { $push: { id: { $toString: '$_id' }, title: '$title', company: '$company', url: '$url' } },
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
        const d = drafts.find(x => sameQuestion(x.question, r._id) && draftStillGood(x, basis, rulesNow, legacy));
        return {
          question: r._id,
          count: r.count,
          lastSeenAt: r.lastSeenAt,
          options: r.options || [],
          jobs: r.jobs.slice(0, 5),
          draft: d ? { answer: d.answer, quote: d.quote, source: d.source, status: d.status, confidence: d.confidence || 0 } : null,
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
    if (auto.enabled && draft.status === 'ready' && draft.confidence >= (auto.minConfidence || 85)) {
      const { requeued } = await saveAutoRule(req.userId, { question, answer: draft.answer, options, confidence: draft.confidence, quote: draft.quote });
      return res.json({ draft: { answer: draft.answer, quote: draft.quote, source: draft.source, status: draft.status, confidence: draft.confidence }, autoUsed: true, requeued });
    }
    await NaukriConfig.updateOne({ userId: req.userId }, { $pull: { drafts: { question } } });
    await NaukriConfig.updateOne({ userId: req.userId }, { $push: { drafts: { $each: [draft], $slice: -300 } } });
    res.json({ draft: { answer: draft.answer, quote: draft.quote, source: draft.source, status: draft.status, confidence: draft.confidence }, note: out.note || null });
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
    const requeued = await requeueAnswered(req.userId, config);
    res.json({ requeued, rule });
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
      { _id: runId, userId: req.userId, status: 'running', 'stats.aiAsked': { $lt: MAX_AI_PER_RUN }, ...BASE_FILTER },
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
      await NaukriConfig.updateOne({ userId: req.userId }, { $pull: { drafts: { question } } });
      await NaukriConfig.updateOne({ userId: req.userId }, { $push: { drafts: { $each: [draft], $slice: -300 } } });
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
    const filter = { userId: req.userId, ...BASE_FILTER };
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
async function queueRun(userId, kind, trigger = 'manual', { sources = null } = {}) {
  const [worker, config] = await Promise.all([
    NaukriWorker.getForUser(userId),
    NaukriConfig.getForUser(userId),
  ]);

  if (config.safety.pauseAll) {
    return { error: 'Naukri is paused. Turn off "Pause all" in Configuration to run anything.', code: 423 };
  }
  const blockedUntil = blockedUntilOf(worker);
  if (blockedUntil) {
    return {
      error: 'Naukri showed a captcha on the last run. Everything is paused until '
           + blockedUntil.toISOString() + ' — do not work around this.',
      code: 423, blockedUntil,
    };
  }

  // Today's limit already used: say so now, rather than queue a run that the
  // worker can only finish empty ("nothing to do") a few seconds later.
  if (kind === 'apply') {
    const done = await appliedToday(userId, config.schedule.timezone);
    if (done >= config.apply.maxPerDay) {
      return {
        error: `Today's limit of ${config.apply.maxPerDay} applications is used up (${done} sent). `
             + 'Raise Max per day in Configuration → Apply behaviour & safety, or they go out tomorrow.',
        code: 409, limitReached: true,
      };
    }
  }

  await failStaleRuns(userId);
  const active = await NaukriRun.findOne({ userId, status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
  if (active) {
    // An apply run queued by an approval while one is already pending is a
    // no-op, not an error: the pending run will pick up the new approvals when
    // it claims, because it reads them at claim time.
    if (kind === 'apply' && active.kind === 'apply') return { run: active, deduped: true };
    return { error: `A Naukri ${active.kind} is already ${active.status}`, code: 409, run: serialize(active) };
  }

  const run = await NaukriRun.create({
    userId, kind, trigger, dryRun: !!config.safety.dryRun,
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
      sources = cleanSources(req.body.sources, cfg.sources);
      if (!sources) return res.status(400).json({ error: 'Pick searches, recommended jobs, or both' });
    }
    const out = await queueRun(req.userId, kind, 'manual', { sources });
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
      { _id: req.params.id, userId: req.userId, status: 'queued', ...BASE_FILTER },
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

router.get('/jobs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { userId: req.userId, ...BASE_FILTER };
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

    if (!needsRefine) {
      const [jobs, total, counts, origins] = await Promise.all([
        NaukriJob.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        NaukriJob.countDocuments(filter),
        typeCounts(),
        originCounts(),
      ]);
      return res.json({ jobs: jobs.map(serialize), total, page, limit, pages: Math.ceil(total / limit), typeCounts: counts, originCounts: origins });
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
      jobs: slice.map(serialize), total, page, limit, pages: Math.ceil(total / limit),
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
      const out = await queueRun(req.userId, 'apply', 'manual');
      // A queue failure here must not lose the approvals — they are saved, and
      // the reason is reported so the UI can explain why nothing started.
      queuedRun = out.error ? { error: out.error } : out.run;
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
      const out = await queueRun(req.userId, 'apply', 'manual');
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

    } else {
      return res.status(400).json({ error: 'action must be apply-next, skip, requeue or dismiss' });
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
    const { host, chromeUp, naukriLoggedIn, nextWakeAt, probeOnly } = req.body || {};

    const worker = await NaukriWorker.getForUser(req.userId);
    const prevSeenAt = worker.lastSeenAt;
    worker.lastSeenAt = new Date();
    if (host !== undefined) worker.host = str(host, 200);
    if (chromeUp !== undefined) worker.chromeUp = !!chromeUp;
    if (naukriLoggedIn !== undefined) worker.naukriLoggedIn = !!naukriLoggedIn;
    if (nextWakeAt !== undefined) {
      const d = nextWakeAt ? new Date(nextWakeAt) : null;
      worker.nextWakeAt = d && !isNaN(d.getTime()) ? d : null;
    }
    await worker.save();
    // Back after an outage long enough to have been reported: say so once.
    if (prevSeenAt && Date.now() - new Date(prevSeenAt).getTime() > WORKER_OFFLINE_MS) await workerBack(req.userId, 'naukri', prevSeenAt);

    const config = await NaukriConfig.getForUser(req.userId);
    // Sent on EVERY response, idle ones included, so a changed check-in
    // interval reaches the worker without a restart.
    const pollSeconds = (config.worker && config.worker.pollSeconds) || 20;
    if (config.safety.pauseAll) return res.json({ run: null, paused: true, pollSeconds });
    if (blockedUntilOf(worker)) return res.json({ run: null, blockedUntil: worker.blockedUntil, pollSeconds });

    // A heartbeat with no appetite for work. The worker sends this when the
    // LinkedIn harvest is holding the shared debug Chrome: it must keep the tab
    // saying "ready" for the length of that run — which can be an hour — but
    // must not claim a run it cannot execute, and must not fire the schedule
    // below on its behalf.
    if (probeOnly) return res.json({ run: null, busy: true, pollSeconds });

    await failStaleRuns(req.userId);

    // Materialise the scheduled runs if an occurrence is due and nothing is
    // already active. One occurrence fans out into the runs its slot asks for,
    // created in execution order: refresh, then harvest, then apply.
    const due = dueSlot(config.schedule, new Date());
    if (due) {
      const active = await NaukriRun.findOne({ userId: req.userId, status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
      // A slot that comes due while a run is active WAITS for it rather than
      // being spent: it fires on the first poll after the active run ends, as
      // long as that is still inside catchUpHours. Spending it lost the whole
      // day's scheduled work whenever a manual run overlapped the slot.
      if (!active) {
        for (const kind of due.kinds) {
          await NaukriRun.create({ userId: req.userId, kind, trigger: 'scheduled', dryRun: !!config.safety.dryRun });
        }
        // Stamped to the OCCURRENCE, not to now, so a late catch-up doesn't
        // drag the next slot forward.
        config.schedule.lastFiredAt = due.at;
        await config.save();
      }
    }

    const run = await NaukriRun.findOneAndUpdate(
      { userId: req.userId, status: 'queued', ...BASE_FILTER },
      { $set: { status: 'running', claimedAt: new Date(), workerHost: str(host, 200) } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!run) return res.json({ run: null, pollSeconds });

    // Everything the worker needs to execute, in the same response — it must not
    // need a second round trip mid-run.
    const payload = {
      run: run.toJSON(),
      pollSeconds,
      config: {
        searches: config.searches.filter(s => s.enabled),
        searchLimits: config.searchLimits,
        // This run's own choice if it made one, else the default.
        sources: (run.sources && (run.sources.searches || run.sources.recommended)) ? run.sources : config.sources,
        useRecommended: config.useRecommended,
        filters: config.filters,
        profile: config.profile,
        answers: config.answers.filter(a => a.enabled),
        // Whether the worker may ask /ai-answer mid-questionnaire. The server
        // re-checks it (and the threshold) on every call regardless.
        autoAnswer: { enabled: !!(config.autoAnswer && config.autoAnswer.enabled) },
        onUnknownQuestion: config.onUnknownQuestion,
        apply: config.apply,
        headlineVariants: config.headlineVariants,
        headlineIndex: config.headlineIndex,
        dryRun: !!config.safety.dryRun,
      },
    };

    if (run.kind === 'apply') {
      const doneToday = await appliedToday(req.userId, config.schedule.timezone);
      const budget = Math.max(0, Math.min(
        config.apply.maxPerRun,
        config.apply.maxPerDay - doneToday
      ));
      payload.jobs = budget === 0 ? [] : await NaukriJob.find({
        userId: req.userId,
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
      // Priority first, then oldest approval. Picking jobs in the UI sets
      // priority, so "apply to these" means these — not "these, eventually".
      }).sort({ priority: -1, approvedAt: 1 }).limit(budget).lean().then(rows => rows.map(serialize));
      payload.budget = { perRun: config.apply.maxPerRun, perDay: config.apply.maxPerDay, doneToday, granted: budget };
    }

    // The refresh rotates through the headline variants, so each daily save is a
    // real edit rather than the same string written back. Advanced here, at
    // claim time, so a crashed run still moves on rather than retrying the same
    // variant forever.
    if (run.kind === 'refresh' && config.headlineVariants.length) {
      config.headlineIndex = (config.headlineIndex + 1) % config.headlineVariants.length;
      await config.save();
    }

    res.json(payload);
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

    const run = await NaukriRun.findOne({ _id: runId, userId: req.userId, ...BASE_FILTER });
    if (!run) return res.status(404).json({ error: 'No such run' });

    let created = 0, updated = 0, skipped = 0, autoApproved = 0;
    const now = new Date();
    const config = await NaukriConfig.getForUser(req.userId);
    const auto = config.apply.autoApproveEnabled && !config.safety.pauseAll;
    const minScore = config.apply.autoApproveMinScore ?? 80;

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
        ...BASE_FILTER,
      })).filter(Boolean).map(c => c.toLowerCase())
    );

    for (const raw of jobs.slice(0, 500)) {
      const sourceId = str(raw && raw.sourceId, 100);
      const title = str(raw && raw.title, 300);
      if (!sourceId || !title) { skipped++; continue; }
      const sourceKey = `naukri:${sourceId}`;
      const queries = cleanList(raw.queries, 20);
      // Older workers send no origins; everything they harvested came from a search.
      const origins = (Array.isArray(raw.origins) ? raw.origins : ['search']).filter(o => o === 'search' || o === 'recommended');
      // Naukri's own feed (Recommended jobs) states it outright; otherwise it is
      // predicted from employers already seen sending people off-site.
      const likelyExternal = raw.companySite === true || externalCompanies.has(str(raw.company, 200).toLowerCase());
      const postedAt = raw.postedAt && !isNaN(new Date(raw.postedAt)) ? new Date(raw.postedAt) : null;
      // Scored on every harvest, so a change to your searches or skills is
      // reflected the next time a job is seen.
      const fit = scoreJob({
        title, tags: raw.tags, description: raw.description, experienceMin: raw.experienceMin,
        experienceMax: raw.experienceMax, salaryText: raw.salaryText, postedText: raw.postedText, likelyExternal, origins,
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
          },
          $setOnInsert: {
            userId: req.userId, sourceId, sourceKey,
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

      // Auto-approve: NEW rows only, so a job you moved back to Review by hand
      // is never re-approved behind your back by the next harvest. Never a
      // predicted company-site job. Approving only moves it to Waiting — it
      // goes out at the next scheduled apply run, inside the daily cap; no run
      // is queued from here.
      if (auto && result.upsertedCount && !likelyExternal && fit.score >= minScore) {
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

    res.json({ created, updated, skipped, autoApproved });
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
      { _id: runId, userId: req.userId, status: 'running', ...BASE_FILTER },
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

    const job = await NaukriJob.findOne({ _id: jobId, userId: req.userId, ...BASE_FILTER });
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
        userId: req.userId, source: 'job', area: 'naukri', kind: 'apply_failed',
        message: `Naukri apply failed for "${job.title}" at ${job.company}${reason ? `: ${str(reason, 500)}` : ''}`,
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
      { _id: runId, userId: req.userId, ...BASE_FILTER },
      { $set: update },
      { new: true }
    );
    if (!run) return res.status(404).json({ error: 'No such run' });

    if (status !== 'done') {
      reportIssue({
        userId: req.userId, source: 'job', area: 'naukri', kind: `run_${status}`,
        message: status === 'blocked'
          ? `Naukri showed a captcha — runs paused${error ? `: ${error}` : ''}`
          : `Naukri run failed${error ? `: ${error}` : ''}`,
        detail: error ? String(error) : '',
        key: `naukri ${status} ${exitCode == null ? '' : exitCode}`,
        meta: { runId: String(runId), exitCode: exitCode ?? null, stats: stats || null },
      });
    }

    if (status === 'done') {
      const applied = run.stats?.applied || 0;
      if (applied > 0) {
        await notify(req.userId, {
          type: 'naukri.applied',
          title: `Applied to ${applied} job${applied === 1 ? '' : 's'}`,
          body: run.stats?.failed ? `${run.stats.failed} could not be applied to.` : '',
          link: '/naukri',
          dedupeKey: `naukri.applied:${run._id}`,
        });
      }
    } else {
      // A captcha or a failed run is something only the user can clear (sign in,
      // solve it on the Mac), so it is raised as "needs you".
      const reason = error ? str(error, 200).split('\n')[0] : '';
      await notify(req.userId, {
        type: 'naukri.attention',
        title: status === 'blocked' ? 'Naukri showed a captcha — runs paused' : 'Naukri run failed',
        body: reason || (status === 'blocked' ? 'Naukri runs are paused for a week.' : 'Check that you are signed in to Naukri on your Mac.'),
        link: '/naukri',
        dedupeKey: `naukri.attention:${run._id}`,
      });
    }

    // A captcha means Naukri challenged the session. The answer is to stop for a
    // week, so the block lives here rather than in the worker — a restarted
    // worker must not be able to shrug it off, and neither must the schedule.
    if (status === 'blocked') {
      const worker = await NaukriWorker.getForUser(req.userId);
      worker.blockedUntil = new Date(Date.now() + BLOCK_MS);
      worker.blockedReason = str(error, 300) || 'Naukri showed a captcha during a run';
      await worker.save();
    }

    res.json({ run: run.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
