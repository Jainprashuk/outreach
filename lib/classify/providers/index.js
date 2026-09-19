// The provider chain: ordered, and filtered to the ones that actually have a key.

const gemini = require('./gemini');
const groq = require('./groq');
const cerebras = require('./cerebras');

const ALL = { gemini, groq, cerebras };

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

/** Providers to try, in order — those with a key, nothing else. */
function configuredChain() {
  return order().map(name => ALL[name]).filter(p => p && p.configured());
}

module.exports = { ALL, DEFAULT_ORDER, order, configuredChain };
