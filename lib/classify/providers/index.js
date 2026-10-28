// The provider chain: ordered, and filtered to the ones that actually have a key.

const gemini = require('./gemini');
const groq = require('./groq');
const cerebras = require('./cerebras');
const { withCallLog } = require('../../aiCallLog');
const { resolveKeys, keyMode, orderKeys, noteResult, MAIN } = require('../../ai/keys');

// Every call through the chain lands in the admin's Gemini logs tab (lib/aiCallLog.js).
const ALL = { gemini: withCallLog(gemini), groq: withCallLog(groq), cerebras: withCallLog(cerebras) };

// Groq first, not Gemini. Gemini's free tier is 20 generate_content requests PER DAY on
// gemini-3-flash — less than a single mailbox sweep — while Groq's is orders of magnitude
// larger and answered in ~500ms against Gemini's multi-second cold call. Gemini stays in the
// chain because those 20 requests are still free and it is the only provider here doing true
// constrained decoding; it is simply not a sensible primary.
const DEFAULT_ORDER = ['groq', 'gemini', 'cerebras'];

/** The configured order, honouring CLASSIFIER_PROVIDER_ORDER. */
function order() {
  const raw = process.env.CLASSIFIER_PROVIDER_ORDER;
  if (!raw) return DEFAULT_ORDER;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  // Unknown names are dropped silently so a typo degrades the chain rather than crashing
  // the mailbox scan. Listing a subset is the supported way to switch a provider off
  // without unsetting its key.
  return names.filter(name => ALL[name]);
}

/**
 * Providers to try, in order — those with an OWNER env key, nothing else. Scripts only:
 * every feature that runs for a user goes through chainFor(userId).
 */
function configuredChain() {
  return order().map(name => ALL[name]).filter(p => p && p.configured());
}

// A provider bound to one key. Same contract as the adapter, plus:
//   keySource  'user' | 'owner' — whose key it spends
//   breakerKey what the cooldown breaker keys on. The owner key keeps the bare name, as
//              before; a user's key gets its own, so one person's bad or exhausted key
//              never cools the provider down for everyone else.
function bind(provider, { key, source, id = MAIN, no = 1 }, userId) {
  const name = provider.name;
  // A user's own Gemini key may run a model with a bigger free allowance than the owner's.
  const modelOverride = source === 'user' && name === 'gemini' ? (process.env.GEMINI_USER_MODEL || null) : null;
  const bound = {
    ...provider,
    keySource: source,
    breakerKey: source === 'user' ? (id === MAIN ? `${name}:${userId}` : `${name}:${userId}:${id}`) : name,
    configured: () => true,
    model: modelOverride ? () => modelOverride : provider.model,
  };
  for (const method of ['classify', 'complete']) {
    if (typeof provider[method] !== 'function') continue;
    bound[method] = async (input, opts = {}) => {
      const logAs = {
        ...((opts && opts.logAs) || {}), keySource: source, ...(modelOverride ? { model: modelOverride } : {}),
        // Which of the user's keys (never the key itself): its place in Settings and its last 4.
        ...(source === 'user' ? { keyNo: no, keyTail: String(key).slice(-4) } : {}),
      };
      const res = await provider[method](input, { ...opts, apiKey: key, ...(modelOverride ? { model: modelOverride } : {}), logAs });
      if (source === 'user' && res) noteResult(userId, name, res.kind, res.error, id);
      return res;
    };
  }
  return bound;
}

/**
 * Providers to try for this user, in order, each bound to the key it runs on
 * (lib/ai/keys.js). Empty when the user has no key and may not use the owner's.
 *
 * skipOwnerGemini: the features that never used Gemini (Naukri drafts, Discover, lead
 * sources) still don't on the OWNER key — its small free allowance is for reply
 * sorting — but do on the user's own.
 */
async function chainFor(userId, { skipOwnerGemini = false } = {}) {
  const keys = await resolveKeys(userId);
  const mode = await keyMode(userId);
  // One entry per key: a provider with two keys appears twice in a row, so a
  // rate-limited key 1 is followed by key 2 before the next provider is tried.
  // Each key has its own breaker and its own status.
  return order()
    .flatMap(name => {
      const k = keys[name];
      if (!k || !ALL[name]) return [];
      if (skipOwnerGemini && name === 'gemini' && k.source === 'owner') return [];
      if (k.source !== 'user' || !k.all || k.all.length < 2) return [bind(ALL[name], k, userId)];
      return orderKeys(k.all, mode, `${userId}:${name}`).map(one => bind(ALL[name], { key: one.key, id: one.id, no: k.all.findIndex(x => x.id === one.id) + 1, source: 'user' }, userId));
    })
    .filter(Boolean);
}

/** The breaker key for a provider from either chain. */
const breakerKeyOf = (p) => p.breakerKey || p.name;

module.exports = { ALL, DEFAULT_ORDER, order, configuredChain, chainFor, breakerKeyOf };
