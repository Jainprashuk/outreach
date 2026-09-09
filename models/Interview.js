const mongoose = require('mongoose');

// An Interview is a person who actually got back to you — someone you're now
// talking to about a role. It is deliberately a SEPARATE document from the
// Contact or Lead it came from: the source row keeps its own outreach/apply
// journey untouched, and this record carries the conversation forward with its
// own status, its own contact details and its own attachments.
//
// Nothing here writes back to Contact or Lead. The link is one-way (sourceType +
// sourceId), so the existing send pipeline and apply journey are unaffected.

// Inline attachment, same shape as Settings.resume. Exactly one CV and one JD
// per interview — every role gets a different pair, which is why they live here
// rather than on the global Settings singleton. Re-uploading replaces.
const fileSchema = new mongoose.Schema({
  filename:    { type: String, required: true },
  contentType: { type: String, required: true },
  data:        { type: Buffer, required: true },
  size:        { type: Number, required: true },
  uploadedAt:  { type: Date, default: Date.now },
}, { _id: false });

const INTERVIEW_STATUSES = [
  'initial-discussion',
  'asked-to-schedule',
  'scheduled',
  'in-process',
  'selected',
  'rejected',
];

// Once you're selected or rejected there is nothing left to chase, so these are
// excluded from both the stale-follow-up sweep and the interview-day reminder.
const TERMINAL_STATUSES = ['selected', 'rejected'];

const interviewSchema = new mongoose.Schema({
  // ── Where this came from ──────────────────────────────────────────────────
  // 'manual' exists so an interview that arrived by phone, with no matching row
  // in either store, can still be tracked.
  sourceType: { type: String, enum: ['contact', 'lead', 'manual'], default: 'manual' },
  sourceId:   { type: String, default: null },   // Contact._id or Lead._id

  // ── Who ───────────────────────────────────────────────────────────────────
  // Copied from the source on create, then freely overridable here. HR often
  // calls from a different number/address than the one you cold-emailed, and
  // correcting it must not rewrite the contact you already mailed.
  name:    { type: String, required: true },
  email:   { type: String, default: '' },
  phone:   { type: String, default: '' },
  company: { type: String, default: '' },
  role:    { type: String, default: '' },

  status: { type: String, enum: INTERVIEW_STATUSES, default: 'initial-discussion' },
  // Only meaningful while status === 'rejected'; kept after a re-open so the
  // history of why it stalled isn't silently lost.
  rejectionReason: { type: String, default: '' },

  // ── Scheduling ────────────────────────────────────────────────────────────
  interviewAt:  { type: Date, default: null },   // drives the day-of reminder
  round:        { type: String, default: '' },   // "HR round", "Tech 2", ...
  mode:         { type: String, enum: ['', 'call', 'video', 'onsite'], default: '' },
  meetingLink:  { type: String, default: '' },

  // ── Compensation & logistics ──────────────────────────────────────────────
  // Strings, not numbers: real conversations produce "18-22 LPA" and
  // "45 days (negotiable)" far more often than a clean integer.
  expectedCtc:  { type: String, default: '' },
  offeredCtc:   { type: String, default: '' },
  noticePeriod: { type: String, default: '' },
  location:     { type: String, default: '' },
  workMode:     { type: String, enum: ['', 'remote', 'hybrid', 'onsite'], default: '' },

  notes: { type: String, default: '' },

  cv: { type: fileSchema, default: null },   // the CV you actually shared for THIS role
  jd: { type: fileSchema, default: null },   // the JD, once HR sends it

  statusHistory: [{
    status:    { type: String },
    changedAt: { type: Date, default: Date.now },
    note:      { type: String, default: '' },
  }],

  // Every meaningful touch stamps this: status change, field edit, attachment
  // upload, or an explicit "I followed up" click. The 3-day stale sweep reads
  // ONLY this field, so a pure re-read of the record never resets the clock.
  lastActivityAt: { type: Date, default: Date.now },

  deleted:   { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

// Default list order: soonest interview first, then most recently touched.
interviewSchema.index({ interviewAt: 1, lastActivityAt: -1 });
interviewSchema.index({ status: 1, lastActivityAt: -1 });
// The Contacts/Leads badge lookup joins on these.
interviewSchema.index({ sourceType: 1, sourceId: 1 });
interviewSchema.index({ email: 1 });

interviewSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Never let a 5MB Buffer reach the client — the UI only ever needs the
    // metadata plus the download URL.
    for (const key of ['cv', 'jd']) {
      if (ret[key]) {
        ret[key] = {
          filename: ret[key].filename,
          contentType: ret[key].contentType,
          size: ret[key].size,
          uploadedAt: ret[key].uploadedAt,
        };
      }
    }
    return ret;
  }
});

module.exports = mongoose.model('Interview', interviewSchema);
module.exports.INTERVIEW_STATUSES = INTERVIEW_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
