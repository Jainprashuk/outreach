// The shared vocabulary every provider adapter answers in.
//
// Adapters return a tagged result instead of throwing, the same way lib/boards/* does,
// because the orchestrator's entire failover policy rests on distinctions an Error flattens:
// "this key is throttled" (fail over, come back in a minute), "this key is wrong" (fail
// over, don't come back for an hour), and "the model babbled" (fail over, nothing is broken).

const KIND = {
  OK: 'ok',
  RATE_LIMITED: 'rate-limited',
  AUTH: 'auth',
  TRANSIENT: 'transient',
  BAD_OUTPUT: 'bad-output',
  ABORTED: 'aborted',
};

// Providers word exhaustion differently and not all of them use 429 for it: Gemini's SDK
// surfaces RESOURCE_EXHAUSTED, and some gateways return a 400 or 403 whose body is the only
// place the word "quota" appears.
const QUOTA_TEXT = /quota|rate.?limit|too many requests|RESOURCE_EXHAUSTED|insufficient_quota/i;

/** The kind implied by an HTTP status plus whatever the error body said. */
function kindForStatus(status, bodyText) {
  if (status === 429) return KIND.RATE_LIMITED;
  // 402 before the text sniff: Cerebras answers an out-of-credit account with
  // "Payment required ... quota", and treating that as throttling would re-ask a provider
  // that cannot serve anyone until someone visits a billing page.
  if (status === 402) return KIND.AUTH;
  if (QUOTA_TEXT.test(bodyText || '')) return KIND.RATE_LIMITED;
  if (status === 401 || status === 403 || status === 404) return KIND.AUTH;
  return KIND.TRANSIENT;
}

/** `Retry-After` in ms (seconds or an HTTP date), or null when absent/unparseable. */
function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

module.exports = { KIND, QUOTA_TEXT, kindForStatus, retryAfterMs };
