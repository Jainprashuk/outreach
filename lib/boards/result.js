// Builders for the BoardFetchResult contract.
//
// Adapters answer exactly one question — "what does this board list right now?"
// — with enough fidelity that the caller can tell "nothing is listed" from
// "we could not find out". lib/postingSync.js closes postings on the first and
// never on the second, so collapsing these four kinds into a boolean would
// destroy the only safety property that matters here.

/** The board listed these postings. */
const ok = (postings, raw = {}) => ({
  kind: 'ok', httpStatus: 200, error: null, postings,
  raw: { count: postings.length, bytes: 0, filtered: 0, ...raw },
});

/** The board answered, and the answer is "nothing". Closes everything. */
const empty = (raw = {}) => ({
  kind: 'empty', httpStatus: 200, error: null, postings: [],
  raw: { count: 0, bytes: 0, filtered: 0, ...raw },
});

/** No such board. Closes NOTHING — this is "no information". */
const notFound = (error, raw = {}) => ({
  kind: 'not-found', httpStatus: 404, error: error || 'Board not found', postings: [],
  raw: { count: 0, bytes: 0, filtered: 0, ...raw },
});

/** We could not find out. Closes NOTHING. */
const error = (message, httpStatus = null, raw = {}) => ({
  kind: 'error', httpStatus, error: message || 'Unknown error', postings: [],
  raw: { count: 0, bytes: 0, filtered: 0, ...raw },
});

/**
 * Map a failed lib/http.js result onto a kind. Only called when `res.ok` is
 * false, so it never has to decide ok-vs-empty — that is each adapter's shape
 * guard, because only the adapter knows where its array lives.
 */
const fromFailedFetch = (res) => {
  const raw = { bytes: res.bytes || 0 };
  if (res.status === 404) return notFound('Board not found (HTTP 404)', raw);
  if (res.tooLarge) return error(res.error, res.status, { ...raw, tooLarge: true });
  return error(res.error, res.status, raw);
};

module.exports = { ok, empty, notFound, error, fromFailedFetch };
