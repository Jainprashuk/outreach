const mongoose = require('mongoose');

// One role harvested from Naukri.
//
// Deliberately NOT a JobPosting. JobPosting models a role pulled from a public
// ATS board over HTTP, keyed by `${source}:${boardToken}:${sourceId}` and synced
// against a board that tells us when a listing closes. A NaukriJob comes from a
// browser session driving a site that exposes no API, has no board token, and
// never tells us a job closed. It also carries a field JobPosting has no reason
// to know about: `approval`, the human gate that decides whether the worker may
// apply. Keeping the two apart is what lets Naukri be deleted in one revert.
const naukriJobSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },

  // ── identity ───────────────────────────────────────────────────────────────
  // Naukri's own job id, lifted from the listing URL and always stringified.
  sourceId:  { type: String, required: true },
  // `naukri:<sourceId>`. Precomputed so the harvest upsert is one indexed filter
  // rather than a compound match, the same trick Lead.dedupeKey uses.
  sourceKey: { type: String, required: true },

  // ── content ────────────────────────────────────────────────────────────────
  title:      { type: String, required: true },
  company:    { type: String, default: '' },
  location:   { type: String, default: '' },
  // Naukri publishes experience as a band ("3-6 Yrs"); both ends in years, null
  // when the listing omits it rather than 0, which would mean "fresher".
  experienceMin: { type: Number, default: null },
  experienceMax: { type: Number, default: null },
  // Left as the site's own text ("Not disclosed", "8-12 Lacs PA"). Parsing it
  // into a number would invent precision Naukri does not publish; the filter
  // that needs a number parses it at read time and skips what it can't read.
  salaryText: { type: String, default: '' },
  tags:       { type: [String], default: [] },
  url:        { type: String, default: '' },
  description: { type: String, default: '' },
  // "3 days ago" as printed. Same reasoning as salaryText: kept verbatim, with
  // `postedAt` holding the resolved instant when it could be derived.
  postedText: { type: String, default: '' },
  postedAt:   { type: Date, default: null },

  // Which saved searches surfaced this job. An array because the same role
  // legitimately turns up under several searches, and collapsing that to one
  // would misattribute which search actually works.
  queries: { type: [String], default: [] },
  // Where it was found: 'search' (one of your searches) and/or 'recommended'
  // (Naukri's Recommended jobs). Both, when it turned up both ways.
  origins: { type: [String], default: [] },

  // ── what WE observed ───────────────────────────────────────────────────────
  firstSeenAt: { type: Date, default: Date.now },  // written once, via $setOnInsert
  lastSeenAt:  { type: Date, default: Date.now },  // stamped every harvest it appears in
  seenCount:   { type: Number, default: 1 },

  // ── the gate ───────────────────────────────────────────────────────────────
  // The only thing in this system that authorises an application. A harvest may
  // only ever create this as 'pending'; nothing but an explicit decision (or
  // auto-approve, which is off by default) may move it forward.
  approval:   { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedAt: { type: Date, default: null },
  // Who approved it: you, or auto-approve (score at or above your threshold).
  approvedBy: { type: String, enum: ['you', 'auto', null], default: null },
  rejectedReason: { type: String, default: '' },

  // ── the outcome ────────────────────────────────────────────────────────────
  // 'skipped' means the worker reached the job and backed out — almost always a
  // screening question with no matching answer rule. The question is kept in
  // applyNote so the config UI can offer it as a one-click addition.
  applyStatus: {
    type: String,
    // 'dismissed' = a skip you have closed. Off every list and count except
    // its own, and never claimed again.
    enum: ['none', 'applied', 'skipped', 'failed', 'dismissed', 'in-review', 'interviewing', 'offer', 'rejected'],
    default: 'none',
  },
  appliedAt:    { type: Date, default: null },
  applyNote:    { type: String, default: '' },
  // Whether a future run should try this job again.
  //
  // Not every skip is the same. A skip caused by an unanswered screening
  // question CAN succeed later — but only once a rule answers it. Such a job is
  // not claimed while it sits in 'skipped'; saving a rule that resolves its
  // question moves it back to 'none' (requeueAnswered in routes/naukri.js), so
  // it is retried exactly when retrying can work, and never before.
  // A skip caused by "Apply on company site", or by Naukri saying you already
  // applied, can never succeed no matter how many times it is attempted.
  //
  // Without this distinction the permanent ones are re-attempted on every run,
  // silently eating the per-run budget so the jobs actually waiting behind them
  // are never reached. That is not a slow failure; it is a stuck queue.
  retryable:    { type: Boolean, default: true },
  // Predicted, at harvest time, to apply on the company site rather than on
  // Naukri — i.e. one this worker will skip.
  //
  // It is a prediction, not a fact: the search card says nothing about where
  // Apply goes, and Naukri offers no facet for it, so the only way to KNOW is
  // to open the listing. What we can do for free is learn from the ones already
  // tried: apply type is a property of the employer far more than the role
  // (17 of the first 38 externals were one company), so a job from an employer
  // known to do this is flagged on arrival. Labelled, never auto-rejected —
  // a guess must not silently throw away a job you might want.
  likelyExternal: { type: Boolean, default: false },
  // Jump the queue. A run claims by `priority` descending then `approvedAt`
  // ascending, so picking specific jobs and pressing Apply sends THOSE rather
  // than whatever happens to be oldest — which is the whole point of choosing.
  // Zero for everything else, so the default order is unchanged.
  priority:     { type: Number, default: 0 },
  // The unanswered question text, when applyStatus === 'skipped'. Its own field
  // rather than parsed back out of applyNote, because the config UI queries it.
  unknownQuestion: { type: String, default: '' },
  // The choices offered for that question, when it was a radio or checkbox.
  // An AI draft must pick one of these, never invent its own.
  questionOptions: { type: [String], default: [] },

  // ── fit ────────────────────────────────────────────────────────────────────
  // 0–100 from lib/naukriScore.js, recomputed on every harvest it appears in.
  // Sorts the inbox and gates auto-approve. Null for rows harvested before
  // scoring existed.
  score:        { type: Number, default: null },
  scoreReasons: { type: [String], default: [] },

  // ── tidied out of the inbox ────────────────────────────────────────────────
  // Set when the inbox tidy rules (Configuration → Filters) cleared a job you
  // had not looked at yet. It is 'rejected' with this reason; Restore puts it
  // back and marks it exempt, so the rules never clear it again.
  tidiedAt:   { type: Date, default: null },
  tidyReason: { type: String, default: '' },
  tidyExempt: { type: Boolean, default: false },

  // ── what the recruiter did ─────────────────────────────────────────────────
  // Read daily from Naukri's own application history (the "track" run). The
  // furthest stage reached — applied, viewed, shortlisted, contacted,
  // not-shortlisted — when, and every status as Naukri printed it.
  naukriStage:    { type: String, enum: ['applied', 'viewed', 'shortlisted', 'contacted', 'not-shortlisted', null], default: null },
  naukriStageAt:  { type: Date, default: null },
  naukriTimeline: { type: [{ _id: false, id: Number, value: String, at: Date }], default: [] },
  listingOpen:    { type: Boolean, default: null },
  trackedAt:      { type: Date, default: null },
  applyHistory: {
    type: [{
      _id:  false,
      at:   { type: Date, default: Date.now },
      from: String,
      to:   String,
      note: String,
    }],
    default: [],
  },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// The harvest upsert. Unique per user, not globally: two accounts tracking the
// same job are two rows, because the approval and apply state on each are one
// person's decisions.
naukriJobSchema.index({ userId: 1, sourceKey: 1 }, { unique: true });
// The review queue.
naukriJobSchema.index({ userId: 1, approval: 1, lastSeenAt: -1 });
// The inbox, best first.
naukriJobSchema.index({ userId: 1, approval: 1, score: -1 });
// The applied view, and the per-day apply cap.
naukriJobSchema.index({ userId: 1, applyStatus: 1, appliedAt: -1 });

naukriJobSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('NaukriJob', naukriJobSchema);
