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

  async classify(input, { timeoutMs = 6000, signal } = {}) {
    const startedAt = Date.now();
    const client = getClient();
    if (!client) return { kind: KIND.AUTH, status: null, error: 'GEMINI_API_KEY not set', latencyMs: 0 };

    try {
      const generative = client.getGenerativeModel({
        model: model(),
        systemInstruction: SYSTEM_INSTRUCTION,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      const response = await generative.generateContent(buildPrompt(input), { timeout: timeoutMs, signal });
      const latencyMs = Date.now() - startedAt;
      const verdict = parseVerdict(response.response.text());

      if (!verdict) {
        return { kind: KIND.BAD_OUTPUT, status: 200, latencyMs, error: 'response did not parse into a known category' };
      }
      return { kind: KIND.OK, status: 200, verdict, latencyMs, error: null };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (signal && signal.aborted) {
        return { kind: KIND.ABORTED, status: null, error: err.message, latencyMs };
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
      };
    }
  },
};
