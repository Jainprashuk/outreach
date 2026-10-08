/**
 * The admin's Gemini logs tab: every request to an AI provider, in full. See
 * models/AiCall.js for what a row is.
 *
 * withCallLog() wraps a provider adapter so that every classify()/complete()
 * call is recorded, whichever feature made it. Callers say who it was for by
 * passing `logAs: { userId, feature, runId, attempt, contactEmail, … }` in the
 * call options; a call without it is still recorded, as feature 'other'.
 *
 * Recording NEVER throws and never changes what the caller gets back. It is
 * awaited (a few ms against a provider call of 500ms+) so a serverless instance
 * cannot freeze before the row lands, but only when the database is already
 * connected — a script without a connection must not sit in mongoose's buffer.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const AiCall = require('../models/AiCall');

const SYSTEM_MAX = 8_000;
const PROMPT_MAX = 40_000;
const OUTPUT_MAX = 20_000;
const ERROR_MAX = 4_000;
// Hard ceiling per instance, so a retry loop cannot turn into a write loop.
const MAX_WRITES_PER_MIN = 600;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const FEATURES = ['classify', 'draft', 'discover'];

let windowStart = Date.now();
let windowWrites = 0;

const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
const orNull = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

const newRunId = () => crypto.randomBytes(8).toString('hex');

async function record(provider, method, res, logAs = {}) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; windowWrites = 0; }
    if (++windowWrites > MAX_WRITES_PER_MIN) return;

    const t = res.trace || {};
    await AiCall.create({
      userId: logAs.userId && mongoose.isValidObjectId(logAs.userId) ? logAs.userId : null,
      feature: FEATURES.includes(logAs.feature) ? logAs.feature : 'other',
      runId: logAs.runId || null,
      attempt: logAs.attempt || 1,
      provider: provider.name,
      model: typeof provider.model === 'function' ? provider.model() : null,
      method,
      outcome: res.kind || 'unknown',
      status: typeof res.status === 'number' ? res.status : null,
      latencyMs: typeof res.latencyMs === 'number' ? res.latencyMs : null,
      error: orNull(res.error, ERROR_MAX),
      system: str(t.system, SYSTEM_MAX),
      prompt: str(t.prompt, PROMPT_MAX),
      output: str(t.output != null ? t.output : res.text, OUTPUT_MAX),
      result: res.verdict || null,
      finishReason: t.finishReason ? String(t.finishReason) : null,
      tokens: t.tokens || {},
      params: t.params || null,
      context: {
        contactEmail: orNull(logAs.contactEmail, 200),
        contactName: orNull(logAs.contactName, 200),
        contactId: orNull(logAs.contactId, 40),
        company: orNull(logAs.company, 200),
      },
      expireAt: new Date(now + KEEP_MS),
    });
  } catch (err) {
    console.error('[aiCallLog] write failed:', err.message);
  }
}

// The adapter's trace is for this log only — callers get the result without it.
const strip = ({ trace, ...rest }) => rest;

/** The same adapter, with every call recorded. */
function withCallLog(provider) {
  const wrapped = { ...provider };
  for (const method of ['classify', 'complete']) {
    if (typeof provider[method] !== 'function') continue;
    wrapped[method] = async (input, opts = {}) => {
      const { logAs, ...rest } = opts || {};
      const res = await provider[method](input, rest);
      await record(provider, method, res || {}, logAs);
      return res ? strip(res) : res;
    };
  }
  return wrapped;
}

module.exports = { withCallLog, newRunId };
