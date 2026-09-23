const express = require('express');
const multer = require('multer');
const NaukriRun = require('../models/NaukriRun');
const NaukriJob = require('../models/NaukriJob');
const NaukriConfig = require('../models/NaukriConfig');
const NaukriWorker = require('../models/NaukriWorker');
const { dueOccurrence, nextOccurrence, kindsFor, parseTime } = require('../lib/naukriSchedule');
const { resolveAnswer } = require('../lib/naukriAnswers');
const { applyFilters, parseSalaryLpa, parsePostedAgeDays, cityVariants } = require('../lib/naukriFilters');

const router = express.Router();

const BASE_FILTER = { deleted: { $ne: true } };
const ACTIVE = ['queued', 'running'];
const KINDS = ['refresh', 'harvest', 'apply', 'probe'];

// A worker polls every 20s; 90s of silence means the Mac slept or the process died.
const ONLINE_MS = 90_000;
// A claimed run whose worker vanished mid-flight. Longer than the longest
// plausible run (8 pages of harvest, or 20 applies with 4s gaps).
const STALE_RUN_MS = 90 * 60_000;
// Naukri showed a captcha. Same doctrine as the LinkedIn checkpoint: stop for a
// week, and do not let a worker restart shrug it off.
const BLOCK_MS = 7 * 24 * 3600 * 1000;

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

// A run left 'running' by a worker that was killed would block the queue
// forever, since /claim only ever starts one at a time.
const failStaleRuns = (userId) =>
  NaukriRun.updateMany(
    { userId, status: 'running', claimedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) }, ...BASE_FILTER },
    { $set: { status: 'failed', error: 'Worker stopped responding mid-run', finishedAt: new Date() } }
  );

const blockedUntilOf = (worker) => {
  const until = worker && worker.blockedUntil ? new Date(worker.blockedUntil) : null;
  return until && until > new Date() ? until : null;
};

// How many applications have gone out since local midnight, for apply.maxPerDay.
// Counted from NaukriJob rather than summed off run stats, because the jobs are
// the thing that actually left — a failed run that applied to three before dying
// still spent three.
const appliedToday = (userId) => {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return NaukriJob.countDocuments({ userId, appliedAt: { $gte: since }, ...BASE_FILTER });
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
    const [worker, config, activeRun, queued, history, reviewCount, appliedCount, todayCount] = await Promise.all([
      NaukriWorker.getForUser(req.userId),
      NaukriConfig.getForUser(req.userId),
      NaukriRun.findOne({ userId: req.userId, status: 'running', ...BASE_FILTER }).sort({ createdAt: 1 }).lean(),
      NaukriRun.find({ userId: req.userId, status: 'queued', ...BASE_FILTER }).sort({ createdAt: 1 }).limit(10).lean(),
      NaukriRun.find({ userId: req.userId, status: { $nin: ACTIVE }, ...BASE_FILTER }).sort({ createdAt: -1 }).limit(20).lean(),
      NaukriJob.countDocuments({ userId: req.userId, approval: 'pending', ...BASE_FILTER }),
      NaukriJob.countDocuments({ userId: req.userId, applyStatus: { $ne: 'none' }, ...BASE_FILTER }),
      appliedToday(req.userId),
    ]);

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
      scheduleKinds: kindsFor(config.schedule),
      nextOccurrence: nextOccurrence(config.schedule, new Date()),
      reviewCount,
      appliedCount,
      appliedToday: todayCount,
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
    res.json({
      config: config.toJSON(),
      nextOccurrence: nextOccurrence(config.schedule, new Date()),
      resume: config.resume && config.resume.size
        ? { filename: config.resume.filename, size: config.resume.size, uploadedAt: config.resume.uploadedAt }
        : null,
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
        const n = num(s.catchUpHours, { min: 0, max: 24 });
        if (n == null) return res.status(400).json({ error: 'catchUpHours must be between 0 and 24' });
        config.schedule.catchUpHours = n;
      }
      for (const k of ['runRefresh', 'runHarvest', 'runApply']) {
        if (s[k] !== undefined) config.schedule[k] = !!s[k];
      }
      if (s.enabled !== undefined) {
        if (s.enabled && kindsFor({ ...config.schedule.toObject(), ...s }).length === 0) {
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

    if (body.answers !== undefined) {
      config.answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 100).map(a => ({
        pattern: str(a && a.pattern, 300).toLowerCase(),
        answer:  str(a && a.answer, 2000),
        kind:    ['text', 'choice', 'number', 'yesno'].includes(a && a.kind) ? a.kind : 'text',
        enabled: a && a.enabled !== false,
      })).filter(a => a.pattern);
    }
    if (body.onUnknownQuestion !== undefined) {
      config.onUnknownQuestion = body.onUnknownQuestion === 'apply-anyway' ? 'apply-anyway' : 'skip';
    }

    if (body.apply) {
      const a = body.apply;
      // Clamped to the model's cap regardless of what the client sends. The cap
      // is not negotiable from the UI — see NaukriConfig.
      if (a.maxPerRun !== undefined) config.apply.maxPerRun = num(a.maxPerRun, { min: 1, max: NaukriConfig.MAX_APPLIES_PER_RUN, integer: true });
      if (a.maxPerDay !== undefined) config.apply.maxPerDay = num(a.maxPerDay, { min: 1, max: 200, integer: true });
      if (a.autoApproveEnabled !== undefined) config.apply.autoApproveEnabled = !!a.autoApproveEnabled;
      if (a.autoApproveMinScore !== undefined) config.apply.autoApproveMinScore = num(a.autoApproveMinScore, { min: 0, max: 100, integer: true });
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
    res.json({ config: config.toJSON(), nextOccurrence: nextOccurrence(config.schedule, new Date()) });
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
      // the user is really asking.
      wouldSkip: !result.matched && config.onUnknownQuestion !== 'apply-anyway',
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
    const rows = await NaukriJob.aggregate([
      { $match: { userId: req.userId, applyStatus: 'skipped', unknownQuestion: { $nin: [null, ''] }, deleted: { $ne: true } } },
      { $group: { _id: '$unknownQuestion', count: { $sum: 1 }, lastSeenAt: { $max: '$updatedAt' } } },
      { $sort: { count: -1, lastSeenAt: -1 } },
      { $limit: 25 },
    ]);
    res.json({ questions: rows.map(r => ({ question: r._id, count: r.count, lastSeenAt: r.lastSeenAt })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resume ─────────────────────────────────────────────────────────────────

router.post('/resume', (req, res) => {
  upload.single('resume')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const config = await NaukriConfig.getForUser(req.userId);
      config.resume = {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        data: req.file.buffer,
        size: req.file.size,
        uploadedAt: new Date(),
      };
      await config.save();
      res.json({ resume: { filename: config.resume.filename, size: config.resume.size, uploadedAt: config.resume.uploadedAt } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

async function sendResume(req, res) {
  try {
    const config = await NaukriConfig.findOne({ userId: req.userId });
    if (!config || !config.resume || !config.resume.size) {
      return res.status(404).json({ error: 'No resume uploaded' });
    }
    res.set('Content-Type', config.resume.contentType);
    res.set('Content-Disposition', `attachment; filename="${String(config.resume.filename).replace(/"/g, '')}"`);
    res.send(config.resume.data);
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
async function queueRun(userId, kind, trigger = 'manual') {
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

  await failStaleRuns(userId);
  const active = await NaukriRun.findOne({ userId, status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
  if (active) {
    // An apply run queued by an approval while one is already pending is a
    // no-op, not an error: the pending run will pick up the new approvals when
    // it claims, because it reads them at claim time.
    if (kind === 'apply' && active.kind === 'apply') return { run: active, deduped: true };
    return { error: `A Naukri ${active.kind} is already ${active.status}`, code: 409, run: serialize(active) };
  }

  const run = await NaukriRun.create({ userId, kind, trigger, dryRun: !!config.safety.dryRun });
  return { run: run.toJSON() };
}

router.post('/runs', async (req, res) => {
  try {
    const kind = str((req.body || {}).kind, 20);
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    }
    const out = await queueRun(req.userId, kind, 'manual');
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
    if (['pending', 'approved', 'rejected'].includes(req.query.approval)) filter.approval = req.query.approval;
    if (req.query.applyStatus === 'any') filter.applyStatus = { $ne: 'none' };
    else if (req.query.applyStatus) filter.applyStatus = req.query.applyStatus;

    if (req.query.q) {
      const r = rx(req.query.q);
      filter.$or = [{ title: r }, { company: r }, { tags: r }];
    }
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

    const SORTS = {
      newest: { lastSeenAt: -1 },
      oldest: { lastSeenAt: 1 },
      experience: { experienceMin: 1, lastSeenAt: -1 },
      company: { company: 1, lastSeenAt: -1 },
    };
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const minSalaryLpa = num(req.query.minSalary, { min: 0, max: 1000 });
    const maxPostedAgeDays = num(req.query.maxAge, { min: 1, max: 365, integer: true });
    const needsRefine = minSalaryLpa != null || maxPostedAgeDays != null;

    if (!needsRefine) {
      const [jobs, total] = await Promise.all([
        NaukriJob.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        NaukriJob.countDocuments(filter),
      ]);
      return res.json({ jobs: jobs.map(serialize), total, page, limit, pages: Math.ceil(total / limit) });
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
    });
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
    if (decision === 'approved') update.approvedAt = new Date();
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
    worker.lastSeenAt = new Date();
    if (host !== undefined) worker.host = str(host, 200);
    if (chromeUp !== undefined) worker.chromeUp = !!chromeUp;
    if (naukriLoggedIn !== undefined) worker.naukriLoggedIn = !!naukriLoggedIn;
    if (nextWakeAt !== undefined) {
      const d = nextWakeAt ? new Date(nextWakeAt) : null;
      worker.nextWakeAt = d && !isNaN(d.getTime()) ? d : null;
    }
    await worker.save();

    const config = await NaukriConfig.getForUser(req.userId);
    if (config.safety.pauseAll) return res.json({ run: null, paused: true });
    if (blockedUntilOf(worker)) return res.json({ run: null, blockedUntil: worker.blockedUntil });

    // A heartbeat with no appetite for work. The worker sends this when the
    // LinkedIn harvest is holding the shared debug Chrome: it must keep the tab
    // saying "ready" for the length of that run — which can be an hour — but
    // must not claim a run it cannot execute, and must not fire the schedule
    // below on its behalf.
    if (probeOnly) return res.json({ run: null, busy: true });

    await failStaleRuns(req.userId);

    // Materialise the scheduled runs if an occurrence is due and nothing is
    // already active. One occurrence fans out into up to three runs, created in
    // execution order: refresh, then harvest, then apply.
    const due = dueOccurrence(config.schedule, new Date());
    if (due) {
      const active = await NaukriRun.findOne({ userId: req.userId, status: { $in: ACTIVE }, ...BASE_FILTER }).lean();
      if (!active) {
        for (const kind of kindsFor(config.schedule)) {
          await NaukriRun.create({ userId: req.userId, kind, trigger: 'scheduled', dryRun: !!config.safety.dryRun });
        }
      }
      // Stamped to the OCCURRENCE, not to now, so a late catch-up doesn't drag
      // tomorrow's slot forward. Stamped even when a run was already active, so
      // a busy slot is spent rather than retried in a loop.
      config.schedule.lastFiredAt = due;
      await config.save();
    }

    const run = await NaukriRun.findOneAndUpdate(
      { userId: req.userId, status: 'queued', ...BASE_FILTER },
      { $set: { status: 'running', claimedAt: new Date(), workerHost: str(host, 200) } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!run) return res.json({ run: null });

    // Everything the worker needs to execute, in the same response — it must not
    // need a second round trip mid-run.
    const payload = {
      run: run.toJSON(),
      config: {
        searches: config.searches.filter(s => s.enabled),
        useRecommended: config.useRecommended,
        filters: config.filters,
        profile: config.profile,
        answers: config.answers.filter(a => a.enabled),
        onUnknownQuestion: config.onUnknownQuestion,
        apply: config.apply,
        headlineVariants: config.headlineVariants,
        headlineIndex: config.headlineIndex,
        dryRun: !!config.safety.dryRun,
      },
    };

    if (run.kind === 'apply') {
      const doneToday = await appliedToday(req.userId);
      const budget = Math.max(0, Math.min(
        config.apply.maxPerRun,
        config.apply.maxPerDay - doneToday
      ));
      payload.jobs = budget === 0 ? [] : await NaukriJob.find({
        userId: req.userId, approval: 'approved',
        // 'skipped' is retryable on purpose: a job is skipped when a screening
        // question matched no rule, and the whole point of surfacing that
        // question in Configuration is that adding the rule makes the next run
        // succeed on it. Excluding it here would make that loop a dead end.
        // 'applied' is absent for the opposite reason — that one has left.
        applyStatus: { $in: ['none', 'failed', 'skipped'] }, ...BASE_FILTER,
      }).sort({ approvedAt: 1 }).limit(budget).lean().then(rows => rows.map(serialize));
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

    let created = 0, updated = 0, skipped = 0;
    const now = new Date();

    for (const raw of jobs.slice(0, 500)) {
      const sourceId = str(raw && raw.sourceId, 100);
      const title = str(raw && raw.title, 300);
      if (!sourceId || !title) { skipped++; continue; }
      const sourceKey = `naukri:${sourceId}`;
      const queries = cleanList(raw.queries, 20);

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
          $addToSet: { queries: { $each: queries } },
        },
        { upsert: true }
      );

      if (result.upsertedCount) created++;
      else if (result.modifiedCount) updated++;
      else skipped++;
    }

    await NaukriRun.updateOne({ _id: runId, userId: req.userId }, {
      $inc: { 'stats.found': created + updated, 'stats.new': created, 'stats.updated': updated },
    });

    res.json({ created, updated, skipped });
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
    const { runId, jobId, outcome, reason, question } = req.body || {};
    if (!runId || !jobId) return res.status(400).json({ error: 'runId and jobId are required' });
    if (!['applied', 'skipped', 'failed', 'dry-run'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be applied, skipped, failed or dry-run' });
    }

    const job = await NaukriJob.findOne({ _id: jobId, userId: req.userId, ...BASE_FILTER });
    if (!job) return res.status(404).json({ error: 'No such job' });

    // A dry run rehearses; it must leave no trace on the job that would make it
    // look applied to, or stop a real run from picking it up later.
    if (outcome !== 'dry-run') {
      const to = outcome === 'applied' ? 'applied' : outcome;
      job.applyHistory.push({ at: new Date(), from: job.applyStatus, to, note: str(reason, 500) });
      job.applyStatus = to;
      job.applyNote = str(reason, 500);
      job.unknownQuestion = outcome === 'skipped' ? str(question, 500) : '';
      if (outcome === 'applied') job.appliedAt = new Date();
      await job.save();
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
      for (const k of ['applied', 'skipped', 'failed', 'rehearsed', 'searches']) {
        if (stats[k] !== undefined) update[`stats.${k}`] = Number(stats[k]) || 0;
      }
    }

    const run = await NaukriRun.findOneAndUpdate(
      { _id: runId, userId: req.userId, ...BASE_FILTER },
      { $set: update },
      { new: true }
    );
    if (!run) return res.status(404).json({ error: 'No such run' });

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
