// Classifies a single inbound reply: a zero-cost rules pass first, then each configured
// provider in turn until one answers.
//
// The ordering exists because the free tiers this runs on are the binding constraint. Most
// inbound mail on a cold-outreach campaign is out-of-office autoreplies, unsubscribes and
// flat rejections, and spending a request on those was what exhausted the quota — which
// then left real replies unclassified, which the backfill re-queued, which spent the next
// tick's quota on the same backlog. Rules break that loop; the provider chain means one
// exhausted key no longer means no classification at all.
//
// NEVER throws. On any failure it returns `success: false`, which is the caller's signal for
// whether this was a REAL verdict or a fallback — without it, a rate-limited call and a
// genuine "needs-attention" verdict would look identical, and the caller would persist a
// fabricated category. A rules verdict IS a real one (`success: true`): it is deterministic,
// so re-classifying it later would spend a request to produce the identical answer.
//
// contactEmail/contactName are used only for logging — they are never sent to a provider.

const { logEvent } = require('./activityLog');
const { deadline } = require('./http');
const rules = require('./classify/rules');
const breaker = require('./classify/breaker');
const { configuredChain } = require('./classify/providers');
const { CATEGORIES } = require('./classify/prompt');
const { KIND, retryAfterMs } = require('./classify/providers/kinds');

// Sized against measured latency: Groq answers in ~500ms, but a cold Gemini call has been
// seen at 12s, so a 6s per-attempt cap would have timed out the fallback it exists to be.
const TOTAL_BUDGET_MS = 15_000;  // whole call, worst case every provider fails slowly
const PER_ATTEMPT_MS = 7_000;
const MIN_ATTEMPT_MS = 1_500;    // below this there is no point starting another provider

// How long a provider sits out, by what went wrong. `auth` is the long one on purpose: a
// wrong or revoked key will still be wrong in a minute, and re-checking it once per reply
// would spend the deadline learning that.
const COOLDOWN_MS = {
  [KIND.RATE_LIMITED]: 60_000,
  [KIND.AUTH]: 60 * 60_000,
  [KIND.TRANSIENT]: 15_000,
};

/**
 * @param {object} input {subject, body, contactEmail, contactName, userId}
 * @param {object} [opts]
 * @param {Array} [opts.providers]   override the chain (tests)
 * @param {AbortSignal} [opts.signal] the caller's run budget
 * @param {boolean} [opts.log=true]
 * @returns {Promise<{category, reasoning, success, provider, rule, attempts}>}
 */
async function classifyReply({ subject, body, contactEmail, contactName, userId }, opts = {}) {
  const { providers, signal, log = true } = opts;
  const startedAt = Date.now();
  const chain = providers || configuredChain();
  const attempts = [];

  // ── the free pass ────────────────────────────────────────────────────────
  const ruled = rules.decide(subject, body);
  if (ruled) {
    const outcome = {
      category: ruled.category, reasoning: ruled.reasoning,
      success: true, provider: 'rules', rule: ruled.rule, attempts,
    };
    if (log) writeLog(outcome, { subject, contactEmail, contactName, userId, startedAt, model: null, error: null });
    return outcome;
  }

  // ── the chain ────────────────────────────────────────────────────────────
  const budget = deadline(TOTAL_BUDGET_MS);
  let lastError = chain.length ? null : 'no classifier provider is configured';

  for (const provider of chain) {
    if (signal && signal.aborted) { lastError = 'caller aborted'; break; }

    if (breaker.blocked(provider.name)) {
      attempts.push({ provider: provider.name, outcome: 'skipped-cooldown', status: null, latencyMs: 0 });
      continue;
    }

    const remaining = budget.remaining();
    if (remaining < MIN_ATTEMPT_MS) {
      attempts.push({ provider: provider.name, outcome: 'skipped-budget', status: null, latencyMs: 0 });
      lastError = lastError || 'classifier budget exhausted';
      break;
    }

    // Only ONE signal goes down, deliberately. The total budget is already enforced by
    // clamping timeoutMs to what's left of it, and every adapter composes that timeout with
    // whatever signal it is handed — so composing here as well would add nothing but a
    // listener on the caller's signal for every provider of every reply, which is how a
    // 50-contact backfill loop earns a MaxListenersExceededWarning.
    const res = await provider.classify({ subject, body }, {
      timeoutMs: Math.min(PER_ATTEMPT_MS, remaining),
      signal: signal || budget.signal,
    });

    attempts.push({
      provider: provider.name, model: provider.model(), outcome: res.kind,
      status: res.status ?? null, latencyMs: res.latencyMs ?? null,
    });

    if (res.kind === KIND.OK && CATEGORIES.includes(res.verdict.category)) {
      const outcome = {
        category: res.verdict.category, reasoning: res.verdict.reasoning,
        success: true, provider: provider.name, rule: null, attempts,
      };
      if (log) writeLog(outcome, { subject, contactEmail, contactName, userId, startedAt, model: provider.model(), error: null });
      return outcome;
    }

    lastError = `${provider.name}: ${res.error || res.kind}`;

    // An aborted attempt means the budget or the caller died, not that this provider is
    // broken — stop the chain rather than blaming and cooling down everything left in it.
    if (res.kind === KIND.ABORTED) break;

    const cooldown = COOLDOWN_MS[res.kind];
    if (cooldown) breaker.trip(provider.name, res.retryAfterMs ?? retryAfterMs(res.retryAfter) ?? cooldown, res.kind);
  }

  const outcome = { ...rules.FALLBACK, success: false, provider: null, rule: null, attempts };
  if (log) writeLog(outcome, { subject, contactEmail, contactName, userId, startedAt, model: null, error: lastError });
  return outcome;
}

// One row per call, not per attempt: a rate-limit storm would otherwise bury the Logs page
// under three rows for every reply. The failover trail lives in meta.attempts instead.
function writeLog(outcome, { subject, contactEmail, contactName, userId, startedAt, model, error }) {
  const who = contactName || contactEmail || 'unknown contact';
  const via = outcome.provider === 'rules' ? `rules (${outcome.rule})` : outcome.provider;
  const skipped = outcome.attempts
    .filter(a => a.outcome !== 'ok')
    .map(a => `${a.provider} ${a.outcome}`)
    .join(', ');

  logEvent({
    userId,
    category: 'classifier',
    action: outcome.success ? 'classify' : 'classify_failed',
    message: outcome.success
      ? `Classified reply from ${who} as "${outcome.category}" via ${via}${skipped ? ` — after ${skipped}` : ''}`
      : `Reply classification failed for ${who}: ${error}`,
    meta: {
      contactEmail: contactEmail || null,
      contactName: contactName || null,
      subject: subject || null,
      category: outcome.category,
      reasoning: outcome.reasoning,
      provider: outcome.provider,
      rule: outcome.rule,
      model,
      latencyMs: Date.now() - startedAt,
      error,
      attempts: outcome.attempts,
      cooldowns: breaker.snapshot(),
      providersConfigured: configuredChain().map(p => p.name),
    },
  }).catch(err => console.error('Activity log write failed:', err.message));
}

module.exports = { classifyReply, CATEGORIES };
