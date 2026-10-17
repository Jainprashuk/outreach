const mongoose = require('mongoose');

// Everything the Naukri worker is allowed to decide, in one doc per user.
//
// The rule this model exists to enforce: the worker hard-codes no preference.
// It reads this at the start of every run. If behaviour can change, it changes
// here and nowhere else — which is also why there is no Naukri setting anywhere
// in Settings.js.
//
// The resume lives here too, as its own copy of the Settings.resume shape. That
// is a deliberate duplicate: sharing it would mean Naukri reads a document that
// the rest of the app writes, and the scope rule for this feature is that it can
// be deleted in one revert.

const MAX_APPLIES_PER_RUN = 20;   // also enforced in the worker; see below

const searchSchema = new mongoose.Schema({
  _id:     false,
  label:   { type: String, default: '' },
  keywords: { type: String, default: '' },
  location: { type: String, default: '' },
  experienceYears: { type: Number, default: null },
  // A pasted Naukri search URL wins over the fields above when present — it is
  // the one way to express a filter combination the form doesn't model.
  url:     { type: String, default: '' },
  enabled: { type: Boolean, default: true },
});

const answerSchema = new mongoose.Schema({
  _id: false,
  // Lowercased substring, matched against the question text. Order matters:
  // first match wins, which is why the UI lets you drag rows.
  pattern: { type: String, required: true },
  // The literal text typed, or the option chosen. May contain {{placeholders}}
  // resolved from `profile` at apply time, so changing your CTC in one field
  // updates every answer that quotes it.
  answer:  { type: String, default: '' },
  kind:    { type: String, enum: ['text', 'choice', 'number', 'yesno'], default: 'text' },
  enabled: { type: Boolean, default: true },
});

// Extra times of day the schedule fires, beyond the original `time` (slot 1).
// Each carries its own run kinds, so a 14:00 slot can be apply-only.
const slotSchema = new mongoose.Schema({
  _id: false,
  time:       { type: String, required: true },   // 'HH:mm'
  runRefresh: { type: Boolean, default: false },
  runHarvest: { type: Boolean, default: false },
  runApply:   { type: Boolean, default: true },
});

// An AI-drafted answer to a screening question the answer bank has no rule for.
// A draft is never typed into a form: it becomes a rule only when you press
// Use, which is what keeps every answer a recruiter sees one you have read.
const draftSchema = new mongoose.Schema({
  _id: false,
  question: { type: String, required: true },
  answer:   { type: String, default: '' },
  // The resume or profile line the answer came from, shown beside it so you can
  // check it at a glance.
  quote:    { type: String, default: '' },
  source:   { type: String, enum: ['resume', 'profile', ''], default: '' },
  // ready = has an answer · unknown = the resume does not say · error = AI busy
  // (retried later) · ignored = you dismissed it
  status:   { type: String, enum: ['ready', 'unknown', 'error', 'ignored'], default: 'ready' },
  options:  { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

const naukriConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },

  // ── schedule ───────────────────────────────────────────────────────────────
  schedule: {
    enabled:      { type: Boolean, default: false },
    days:         { type: [Number], default: [1, 2, 3, 4, 5] },   // 0 = Sunday
    time:         { type: String, default: '09:30' },             // 'HH:mm'
    timezone:     { type: String, default: 'Asia/Kolkata' },
    catchUpHours: { type: Number, default: 6 },
    lastFiredAt:  { type: Date, default: null },
    // Which kinds fire on a scheduled wake. Apply is off by default: it should
    // only ever run off your approvals, not off a clock.
    runRefresh: { type: Boolean, default: true },
    runHarvest: { type: Boolean, default: true },
    runApply:   { type: Boolean, default: false },
    // Slots 2 and 3. Empty = the single daily time above, as before.
    extraSlots: { type: [slotSchema], default: [] },
  },

  // How often the worker checks in. Sent back on every /claim, so a change
  // takes effect on the next check-in without restarting the worker.
  worker: {
    pollSeconds: { type: Number, default: 20, min: 15, max: 120 },
  },

  // Harvest size. Clamped again in the worker to its hard caps (10 searches,
  // 8 pages), so the UI can only ever lower them.
  searchLimits: {
    maxSearches: { type: Number, default: 10, min: 1, max: 10 },
    maxPages:    { type: Number, default: 8, min: 1, max: 8 },
  },

  // ── what to harvest ────────────────────────────────────────────────────────
  searches:       { type: [searchSchema], default: [] },
  // Legacy and unused: it was saved but never read by the worker. `sources`
  // replaces it.
  useRecommended: { type: Boolean, default: true },
  // Where a harvest looks, by default (scheduled runs, and Harvest with no
  // choice made). The Harvest button can override it for one run.
  sources: {
    searches:    { type: Boolean, default: true },
    recommended: { type: Boolean, default: false },
    // Which Recommended-jobs tabs to read: apply (similar to your applies),
    // profile, preference, similar_jobs ("You might like"). Empty = all.
    recommendedTabs: { type: [String], default: ['apply', 'profile', 'preference', 'similar_jobs'] },
  },

  // ── filters, applied before anything reaches the review queue ──────────────
  filters: {
    titleInclude:   { type: [String], default: [] },
    titleExclude:   { type: [String], default: [] },
    companyExclude: { type: [String], default: [] },
    locations:      { type: [String], default: [] },
    remoteOnly:     { type: Boolean, default: false },
    minExperienceYears: { type: Number, default: null },
    maxExperienceYears: { type: Number, default: null },
    minSalaryLpa:       { type: Number, default: null },
    maxPostedAgeDays:   { type: Number, default: 14 },
    // Naukri marks jobs you've already applied to; don't re-surface them.
    skipAlreadyApplied: { type: Boolean, default: true },
  },

  // ── you, for the screening questions ───────────────────────────────────────
  profile: {
    fullName:  { type: String, default: '' },
    email:     { type: String, default: '' },
    phone:     { type: String, default: '' },
    noticePeriodDays:      { type: Number, default: null },
    currentCtcLpa:         { type: Number, default: null },
    expectedCtcLpa:        { type: Number, default: null },
    totalExperienceMonths: { type: Number, default: null },
    currentCompany:     { type: String, default: '' },
    currentDesignation: { type: String, default: '' },
    currentLocation:    { type: String, default: '' },
    preferredLocations: { type: [String], default: [] },
    willingToRelocate:  { type: Boolean, default: true },
    highestQualification: { type: String, default: '' },
    skills: { type: [String], default: [] },
  },

  // ── the answer bank ────────────────────────────────────────────────────────
  answers: { type: [answerSchema], default: [] },
  // 'skip' is the default and should stay it. Guessing at a screening question
  // is how you end up telling a recruiter something untrue in writing.
  onUnknownQuestion: { type: String, enum: ['skip', 'apply-anyway'], default: 'skip' },
  // Draft answers from your resume for questions with no rule. Drafts only:
  // see draftSchema.
  aiDrafts: { type: Boolean, default: true },
  drafts:   { type: [draftSchema], default: [] },

  // ── apply behaviour ────────────────────────────────────────────────────────
  apply: {
    // Clamped to MAX_APPLIES_PER_RUN on save. The cap is not negotiable from the
    // UI, because the thing it protects against is your own enthusiasm at 2am.
    maxPerRun: { type: Number, default: 20, min: 1, max: MAX_APPLIES_PER_RUN },
    maxPerDay: { type: Number, default: 40, min: 1 },
    // THE GATE. While false, nothing is applied to without an explicit approval
    // click. Everything else in this file is a preference; this is the safety
    // story.
    autoApproveEnabled:  { type: Boolean, default: false },
    autoApproveMinScore: { type: Number, default: 80 },
    delayMinMs: { type: Number, default: 1500, min: 500 },
    delayMaxMs: { type: Number, default: 4000, min: 500 },
    coverNote:  { type: String, default: '' },
  },

  // ── resume ─────────────────────────────────────────────────────────────────
  resume: {
    filename:    { type: String, default: '' },
    contentType: { type: String, default: '' },
    data:        { type: Buffer, default: null },
    size:        { type: Number, default: 0 },
    uploadedAt:  { type: Date, default: null },
    // Plain text pulled from the file at upload, editable in the Resume card.
    // What the AI drafts answers from; the file itself is what gets attached.
    text:        { type: String, default: '' },
    // Where `text` came from: 'naukri' (the file above), 'manual' (typed or
    // pasted), or 'settings:<uploadedAt>' (read from the Settings resume — and
    // read again when that file is replaced). '' = nothing yet.
    textFrom:    { type: String, default: '' },
  },
  // The daily refresh rotates through these, so the profile save is a real edit
  // rather than the same string written back. Empty = round-trip whatever is
  // already there.
  headlineVariants: { type: [String], default: [] },
  headlineIndex:    { type: Number, default: 0 },

  // ── safety ─────────────────────────────────────────────────────────────────
  safety: {
    // One kill switch. While true, /claim hands out nothing.
    pauseAll: { type: Boolean, default: false },
    // Walk the whole apply flow, fill everything, submit nothing, log what it
    // would have sent. How you verify a selector fix without spending a real
    // application.
    dryRun:   { type: Boolean, default: false },
  },
}, { timestamps: true });

naukriConfigSchema.statics.getForUser = async function (userId) {
  let doc = await this.findOne({ userId });
  if (!doc) doc = await this.create({ userId });
  return doc;
};

// Never ship the resume bytes to the client — the config endpoint is polled.
naukriConfigSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.resume) delete ret.resume.data;
    return ret;
  }
});

naukriConfigSchema.statics.MAX_APPLIES_PER_RUN = MAX_APPLIES_PER_RUN;

module.exports = mongoose.model('NaukriConfig', naukriConfigSchema);
