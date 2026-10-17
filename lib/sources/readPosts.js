// Reads job posts (pasted messages, HN posts, search snippets) with the free AI
// providers the app already uses for reply sorting: who is hiring, for what, where.
//
// Same rules as lib/discovery/llmExtract.js:
// - Gemini on the owner's key is never used (its ~20/day free tier belongs to reply
//   sorting); a user's own Gemini key is.
// - A failure here never trips the shared cooldown breaker.
// - The model can't invent: a company it names must appear in the post text, and
//   emails are never taken from its answer (lib/sources/emails.js reads those).
//
// Several posts go in one call so a 60-message WhatsApp export costs ~12 calls.

const breaker = require('../classify/breaker');
const { chainFor, breakerKeyOf } = require('../classify/providers');
const { KIND } = require('../classify/providers/kinds');
const { newRunId } = require('../aiCallLog');
const { mapLimit } = require('../http');

const PER_CALL = 5;
const POST_MAX = 1500;

const SYSTEM = `You read short job-related posts and say what each one is.
Return JSON only, in exactly this shape:
{"posts":[{"n":1,"hiring":true,"seeker":false,"company":"","role":"","location":"","remote":false,"minYears":null}]}
One entry per post, with "n" equal to the post's number.
- hiring: true when the post offers a job or asks people to apply / send a CV.
- seeker: true when the writer is a person looking for a job for themselves.
- company: the hiring company's name exactly as written in the post, or "" if not named. Never guess.
- role: the job title being hired for, or "".
- location: city/country as written, or "".
- remote: true only if the post says the job is remote.
- minYears: the minimum years of experience asked for as a number, or null.`;

// Models sometimes write a placeholder instead of leaving a field empty.
const PLACEHOLDER = /^(?:undefined|null|none|n\/?a|unknown|not (?:specified|mentioned|given)|-+)$/i;
const clean = (s, max = 120) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  return PLACEHOLDER.test(t) ? '' : t;
};
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function parse(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

/** Pure: one model answer → readings for `texts`, dropping anything the text doesn't back up. */
function toReadings(data, texts) {
  const out = texts.map(() => null);
  const posts = data && Array.isArray(data.posts) ? data.posts : [];
  for (const p of posts) {
    const i = Number(p && p.n) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= texts.length || out[i]) continue;
    const hay = squash(texts[i]);
    let company = clean(p.company);
    // A model echoing a domain ("razorpay") gets a capital, like a name would have.
    if (company && company === company.toLowerCase()) company = company.replace(/\b[a-z]/g, c => c.toUpperCase());
    const years = Number(p.minYears);
    out[i] = {
      hiring: p.hiring === true,
      isSeeker: p.seeker === true,
      // The company must be in the post, so a model can't make one up.
      company: company && squash(company).length >= 2 && hay.includes(squash(company)) ? company : '',
      role: clean(p.role),
      location: clean(p.location, 80),
      remote: p.remote === true,
      minYears: Number.isFinite(years) && years >= 0 && years <= 30 ? years : null,
    };
  }
  return out;
}

async function readBatch(texts, { userId, runId }) {
  const chain = (await chainFor(userId, { skipOwnerGemini: true })).filter(p => typeof p.complete === 'function');
  if (!chain.length) return { readings: texts.map(() => null), error: 'No AI key on this account (Settings → AI keys)', noKey: true };
  const prompt = texts.map((t, i) => `--- Post ${i + 1} ---\n${String(t).slice(0, POST_MAX)}`).join('\n\n');
  let lastError = null;
  let tried = 0;
  for (const provider of chain) {
    if (breaker.blocked(breakerKeyOf(provider))) continue;
    const res = await provider.complete(
      { system: SYSTEM, prompt, maxTokens: 220 * texts.length, temperature: 0 },
      { timeoutMs: 20_000, logAs: { userId, feature: 'sources', runId, attempt: ++tried } },
    );
    if (res.kind !== KIND.OK) { lastError = `${provider.name}: ${res.error || res.kind}`; continue; }
    const data = parse(res.text);
    if (!data || !Array.isArray(data.posts)) { lastError = `${provider.name}: unreadable answer`; continue; }
    return { readings: toReadings(data, texts), error: null };
  }
  return { readings: texts.map(() => null), error: lastError || 'AI providers busy' };
}

/**
 * Reads every text; returns one reading (or null when the AI couldn't) per text,
 * in order, plus the last error if any batch failed.
 *
 * @returns {Promise<{ readings: (object|null)[], error: string|null }>}
 */
async function readPosts(texts, { userId, concurrency = 3 } = {}) {
  const runId = newRunId();
  const batches = [];
  for (let i = 0; i < texts.length; i += PER_CALL) batches.push(texts.slice(i, i + PER_CALL));
  const results = await mapLimit(batches, concurrency, (b) => readBatch(b, { userId, runId }));
  // mapLimit leaves `undefined` where a worker threw: that batch simply wasn't read.
  const safe = results.map((r, i) => r || { readings: batches[i].map(() => null), error: 'AI read failed' });
  return {
    readings: safe.flatMap(r => r.readings),
    error: safe.map(r => r.error).filter(Boolean)[0] || null,
  };
}

module.exports = { readPosts, toReadings, PER_CALL };
