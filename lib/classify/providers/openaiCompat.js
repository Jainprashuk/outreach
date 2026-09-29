// One adapter for every provider that speaks the OpenAI /chat/completions shape. Groq and
// Cerebras differ only in base URL, key and model name, so they are two lines each rather
// than two files of duplicated error handling.

const { postJson } = require('../../http');
const { SYSTEM_INSTRUCTION, JSON_INSTRUCTION, buildPrompt, parseVerdict } = require('../prompt');
const { KIND, kindForStatus, retryAfterMs } = require('./kinds');

/**
 * @param {object} cfg
 * @param {string} cfg.name          registry key, also what lands in the activity log
 * @param {string} cfg.url           chat-completions endpoint
 * @param {string} cfg.keyEnv        env var holding the API key
 * @param {string} cfg.modelEnv      env var overriding the model
 * @param {string} cfg.defaultModel
 */
function openaiCompatProvider({ name, url, keyEnv, modelEnv, defaultModel }) {
  const model = () => process.env[modelEnv] || defaultModel;

  return {
    name,
    model,
    configured: () => !!process.env[keyEnv],

    async classify(input, { timeoutMs = 6000, signal } = {}) {
      const startedAt = Date.now();
      const res = await postJson(url, {
        timeoutMs,
        signal,
        headers: { authorization: `Bearer ${process.env[keyEnv]}` },
        body: {
          model: model(),
          temperature: 0,
          max_tokens: 200,
          // Not json_schema: an unsupported response_format is a hard 400 on EVERY request,
          // and json_object plus a tolerant parser costs nothing when a model strays.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${SYSTEM_INSTRUCTION}\n\n${JSON_INSTRUCTION}` },
            { role: 'user', content: buildPrompt(input) },
          ],
        },
      });
      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        if (signal && signal.aborted) {
          return { kind: KIND.ABORTED, status: res.status, error: res.error, latencyMs };
        }
        return {
          kind: res.status === null ? KIND.TRANSIENT : kindForStatus(res.status, res.errorBody),
          status: res.status,
          error: res.errorBody ? `${res.error}: ${res.errorBody}` : res.error,
          retryAfterMs: retryAfterMs(res.retryAfter),
          latencyMs,
        };
      }

      const text = res.data?.choices?.[0]?.message?.content;
      const verdict = parseVerdict(text);
      if (!verdict) {
        return {
          kind: KIND.BAD_OUTPUT, status: res.status, latencyMs,
          error: `unparseable response: ${String(text || '').slice(0, 120)}`,
        };
      }

      return { kind: KIND.OK, status: res.status, verdict, latencyMs, error: null };
    },

    // Free-form text (reply drafts). Same failure contract as classify, with `text` in
    // place of `verdict`.
    async complete({ system, prompt, maxTokens = 700, temperature = 0.4 }, { timeoutMs = 20000, signal } = {}) {
      const startedAt = Date.now();
      const res = await postJson(url, {
        timeoutMs,
        signal,
        headers: { authorization: `Bearer ${process.env[keyEnv]}` },
        body: {
          model: model(),
          temperature,
          // gpt-oss reasons before it answers and that counts against max_tokens, so the
          // visible reply needs headroom — and a short reasoning pass is plenty for an email.
          // reasoning_effort only for gpt-oss: another model would reject the whole request.
          max_tokens: maxTokens * 4,
          ...(/gpt-oss/.test(model()) ? { reasoning_effort: 'low' } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        if (signal && signal.aborted) return { kind: KIND.ABORTED, status: res.status, error: res.error, latencyMs };
        return {
          kind: res.status === null ? KIND.TRANSIENT : kindForStatus(res.status, res.errorBody),
          status: res.status,
          error: res.errorBody ? `${res.error}: ${res.errorBody}` : res.error,
          retryAfterMs: retryAfterMs(res.retryAfter),
          latencyMs,
        };
      }
      const text = String(res.data?.choices?.[0]?.message?.content || '').trim();
      if (!text) return { kind: KIND.BAD_OUTPUT, status: res.status, error: 'empty response', latencyMs };
      // A cut-off reply is worse than none: it reads fine until the last line.
      if (res.data?.choices?.[0]?.finish_reason === 'length') {
        return { kind: KIND.BAD_OUTPUT, status: res.status, error: 'reply was cut off (token limit)', latencyMs };
      }
      return { kind: KIND.OK, status: res.status, text, latencyMs, error: null };
    },
  };
}

module.exports = { openaiCompatProvider };
