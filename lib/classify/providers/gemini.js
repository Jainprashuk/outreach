// Gemini, via the official SDK, expressed in the shared provider contract.
//
// Kept on the SDK rather than moved to its OpenAI-compatible endpoint for uniformity: it is
// the provider that already works in production, it is the only one that does TRUE
// constrained decoding (responseSchema, so a malformed category is impossible rather than
// merely unlikely), and this change should not destabilise it. Switching it later would
// delete the last SDK dependency in the repo — worth doing, but not in the same change that
// introduces the failover it is supposed to be a baseline for.

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { CATEGORIES, SYSTEM_INSTRUCTION, buildPrompt, parseVerdict } = require('../prompt');
const { KIND, kindForStatus } = require('./kinds');

const DEFAULT_MODEL = 'gemini-3-flash-preview';

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    category: { type: SchemaType.STRING, enum: CATEGORIES, format: 'enum' },
    reasoning: { type: SchemaType.STRING },
  },
  required: ['category', 'reasoning'],
};

const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

// What was sent and what came back, for the admin's AI log (lib/aiCallLog.js). Rides on
// every result, success or not — a bad answer is exactly the one worth reading in full.
function traceOf(response, err, { system, prompt, params }) {
  const r = response && response.response;
  let output = '';
  try { output = r ? r.text() : ''; } catch (e) { output = `(no text: ${e.message})`; }
  if (!r && err) output = err.message || '';
  const u = r && r.usageMetadata;
  return {
    system, prompt, params, output,
    finishReason: r?.candidates?.[0]?.finishReason || r?.promptFeedback?.blockReason || null,
    tokens: u ? {
      input: u.promptTokenCount ?? null,
      output: u.candidatesTokenCount ?? null,
      thinking: u.thoughtsTokenCount ?? null,
      total: u.totalTokenCount ?? null,
    } : null,
  };
}

let _client = null;
const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_client) _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _client;
};

module.exports = {
  name: 'gemini',
  model,
  configured: () => !!process.env.GEMINI_API_KEY,

  // Free-form text (reply drafts). Same failure contract as classify, with `text` in
  // place of `verdict`.
  async complete({ system, prompt, maxTokens = 700, temperature = 0.4 }, { timeoutMs = 20000, signal } = {}) {
    const startedAt = Date.now();
    const client = getClient();
    if (!client) return { kind: KIND.AUTH, status: null, error: 'GEMINI_API_KEY not set', latencyMs: 0 };
    const sent = { system, prompt, params: { temperature, maxTokens: maxTokens * 4 } };
    let response = null;
    try {
      const generative = client.getGenerativeModel({
        model: model(),
        systemInstruction: system,
        // Gemini 3 spends part of maxOutputTokens on its own thinking, so the visible text
        // needs headroom well beyond the reply's length or it stops mid-sentence.
        generationConfig: { maxOutputTokens: maxTokens * 4, temperature },
      });
      response = await generative.generateContent(prompt, { timeout: timeoutMs, signal });
      const latencyMs = Date.now() - startedAt;
      const trace = traceOf(response, null, sent);
      const text = String(response.response.text() || '').trim();
      if (!text) return { kind: KIND.BAD_OUTPUT, status: 200, error: 'empty response', latencyMs, trace };
      // A cut-off reply is worse than none: it reads fine until the last line.
      if (response.response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        return { kind: KIND.BAD_OUTPUT, status: 200, error: 'reply was cut off (token limit)', latencyMs, trace };
      }
      return { kind: KIND.OK, status: 200, text, latencyMs, error: null, trace };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const trace = traceOf(response, err, sent);
      if (signal && signal.aborted) return { kind: KIND.ABORTED, status: null, error: err.message, latencyMs, trace };
      const status = typeof err.status === 'number' ? err.status : null;
      return {
        kind: status === null && !/quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(err.message) ? KIND.TRANSIENT : kindForStatus(status, err.message),
        status, error: err.message, latencyMs, trace,
      };
    }
  },

  async classify(input, { timeoutMs = 6000, signal } = {}) {
    const startedAt = Date.now();
    const client = getClient();
    if (!client) return { kind: KIND.AUTH, status: null, error: 'GEMINI_API_KEY not set', latencyMs: 0 };
    const prompt = buildPrompt(input);
    const sent = { system: SYSTEM_INSTRUCTION, prompt, params: { responseSchema: 'category + reasoning' } };
    let response = null;

    try {
      const generative = client.getGenerativeModel({
        model: model(),
        systemInstruction: SYSTEM_INSTRUCTION,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      response = await generative.generateContent(prompt, { timeout: timeoutMs, signal });
      const latencyMs = Date.now() - startedAt;
      const trace = traceOf(response, null, sent);
      const verdict = parseVerdict(response.response.text());

      if (!verdict) {
        return { kind: KIND.BAD_OUTPUT, status: 200, latencyMs, error: 'response did not parse into a known category', trace };
      }
      return { kind: KIND.OK, status: 200, verdict, latencyMs, error: null, trace };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const trace = traceOf(response, err, sent);
      if (signal && signal.aborted) {
        return { kind: KIND.ABORTED, status: null, error: err.message, latencyMs, trace };
      }
      // The SDK throws GoogleGenerativeAIFetchError with `.status` on an HTTP failure and a
      // plain Error on a timeout or network fault — the message is the only quota signal in
      // the latter case, which is why kindForStatus also sniffs the text.
      const status = typeof err.status === 'number' ? err.status : null;
      return {
        kind: status === null && !/quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(err.message)
          ? KIND.TRANSIENT
          : kindForStatus(status, err.message),
        status,
        error: err.message,
        latencyMs,
        trace,
      };
    }
  },
};
