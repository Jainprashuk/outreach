// Remembers which providers are currently unusable, so a rate limit costs one request
// instead of one per reply.
//
// Deliberately in-memory and not persisted. The dominant win is WITHIN one invocation:
// runBackfillBatch classifies up to 50 contacts serially in a single process, so process
// state alone turns 50 wasted 429 round-trips into 1. Warm serverless instances carry it
// across consecutive cron ticks a good fraction of the time on top of that. A Mongo-backed
// version would add a read to the hot path of every classification to avoid a cold-start
// miss that costs exactly one wasted request and immediately re-arms the cooldown —
// bounded, self-healing, and not worth a collection.

const MAX_COOLDOWN_MS = 15 * 60 * 1000;

const state = new Map(); // name -> { until, reason }

/** True while `name` should be skipped entirely. */
function blocked(name) {
  const entry = state.get(name);
  if (!entry) return false;
  if (Date.now() >= entry.until) { state.delete(name); return false; }
  return true;
}

/** Take `name` out of the chain for `ms` (clamped), recording why. */
function trip(name, ms, reason) {
  const until = Date.now() + Math.max(0, Math.min(ms, MAX_COOLDOWN_MS));
  const existing = state.get(name);
  // Never shorten a cooldown: a long `auth` block must not be reset by a later transient.
  if (existing && existing.until > until) return;
  state.set(name, { until, reason: reason || 'unavailable' });
}

/**
 * Seconds remaining per cooled-down provider — for the activity log, so "why did Cerebras
 * answer this one?" is answerable without any new storage.
 */
function snapshot() {
  const now = Date.now();
  const out = {};
  for (const [name, entry] of state) {
    if (entry.until > now) out[name] = Math.ceil((entry.until - now) / 1000);
  }
  return out;
}

/** Test-only: forget every cooldown. */
function reset() { state.clear(); }

// ── scoped cooldowns ────────────────────────────────────────────────────────
// Features that must never pause reply sorting (Naukri answers, application
// notes, profile suggestions) still should not hit a key they just saw rate-
// limited once per question. They cool down under their own scope: a
// `jobs:groq:<user>` entry is read only by the jobs features, never by the
// reply classifier, which checks the bare key.
const { KIND } = require('./providers/kinds');
const SCOPED_COOLDOWN_MS = { [KIND.RATE_LIMITED]: 60_000, [KIND.AUTH]: 60 * 60_000, [KIND.TRANSIENT]: 15_000 };
const keyOf = (provider) => provider.breakerKey || provider.name;

/** True while `provider` is cooling down globally or in `scope`. */
function blockedIn(scope, provider) {
  const key = keyOf(provider);
  return blocked(key) || blocked(`${scope}:${key}`);
}

/** After a failed call: take `provider` out of `scope` for a while, if the failure says to. */
function coolIn(scope, provider, res) {
  const ms = res && SCOPED_COOLDOWN_MS[res.kind];
  if (!ms) return;
  trip(`${scope}:${keyOf(provider)}`, res.retryAfterMs || ms, res.kind);
}

module.exports = { blocked, trip, snapshot, reset, blockedIn, coolIn, MAX_COOLDOWN_MS };
