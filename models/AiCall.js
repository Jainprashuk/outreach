const mongoose = require('mongoose');

/**
 * One request to an AI provider (Gemini, Groq, Cerebras) — what was sent, what
 * came back, how long it took and what it cost in tokens. Read only by the
 * admin's Gemini logs tab (routes/admin.js); written only by lib/aiCallLog.js.
 *
 * One row per ATTEMPT, not per feature call: when Groq is rate-limited and
 * Gemini answers, that is two rows sharing a runId — the failover is exactly
 * what this log exists to show.
 *
 * Rows with source 'history' were rebuilt from the activity log by
 * scripts/backfill-ai-calls.js for calls made before this log existed. Those
 * have no raw output or system text, and their prompt (when present) was
 * reconstructed from the stored reply — `note` says what is missing.
 *
 * Holds FULL prompt and output text — reply bodies, conversation transcripts,
 * reply profiles — by the owner's explicit choice (2026-10-08), the same
 * exception to the admin "counts only" rule as the Issues tab.
 */
const aiCallSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // classify: sorting an inbound reply · draft: writing a reply · discover: reading
  // a team page for names · other: anything without a caller label (scripts)
  feature: { type: String, enum: ['classify', 'draft', 'discover', 'other'], default: 'other' },
  runId: { type: String, default: null },       // shared by every attempt of one feature call
  attempt: { type: Number, default: 1 },        // 1 = the first provider tried in that run
  provider: { type: String, required: true },   // gemini | groq | cerebras
  model: { type: String, default: null },
  method: { type: String, enum: ['classify', 'complete'], required: true },
  // ok · rate-limited · auth · transient · bad-output · aborted (lib/classify/providers/kinds.js)
  outcome: { type: String, required: true },
  status: { type: Number, default: null },      // HTTP status, when there was one
  latencyMs: { type: Number, default: null },
  error: { type: String, default: null },
  system: { type: String, default: '' },
  prompt: { type: String, default: '' },
  output: { type: String, default: '' },        // the raw text the model returned
  result: { type: mongoose.Schema.Types.Mixed, default: null },  // parsed verdict, when classify succeeded
  finishReason: { type: String, default: null },
  tokens: {
    input: { type: Number, default: null },
    output: { type: Number, default: null },
    thinking: { type: Number, default: null },
    total: { type: Number, default: null },
  },
  params: { type: mongoose.Schema.Types.Mixed, default: null },  // temperature, maxTokens …
  context: {
    contactEmail: { type: String, default: null },
    contactName: { type: String, default: null },
    contactId: { type: String, default: null },
    company: { type: String, default: null },
  },
  source: { type: String, enum: ['live', 'history'], default: 'live' },
  note: { type: String, default: null },        // what a history row could not recover
  createdAt: { type: Date, default: Date.now },
  // Live rows expire; history rows have none and are kept — they are all there is.
  expireAt: { type: Date, default: null },
}, { versionKey: false });

aiCallSchema.index({ createdAt: -1 });
aiCallSchema.index({ provider: 1, createdAt: -1 });
aiCallSchema.index({ userId: 1, createdAt: -1 });
aiCallSchema.index({ runId: 1 });
// Full prompts are large; a month is enough to see how the providers behave.
// Set per row by lib/aiCallLog.js (createdAt + 30 days); a null never expires.
aiCallSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiCall', aiCallSchema);
