// Outbound HTTP for the job-board sync. The server made zero outbound requests
// before this, so there was nothing to reuse — hence a small purpose-built layer
// rather than a dependency. Node 22 gives us global fetch and AbortSignal.any.

const USER_AGENT = 'outreach-app/1.0 (job board sync)';

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const RETRY_ON = [429, 500, 502, 503, 504];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * One JSON GET with a hard timeout, a streamed byte cap and bounded retries.
 *
 * NEVER throws. Returns a tagged result so the caller can tell "the board says
 * nothing is listed" from "we couldn't find out" — that distinction is the whole
 * safety property of the sync (see lib/postingSync.js), so it must not be
 * flattened into an exception.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=12000]  per-attempt timeout
 * @param {number} [opts.maxBytes]         abort past this many bytes
 * @param {number} [opts.retries=2]        additional attempts after the first
 * @param {number[]} [opts.retryOn]        status codes worth retrying
 * @param {AbortSignal} [opts.signal]      the run-wide deadline
 * @returns {Promise<{ok: boolean, status: number|null, data: any, error: string|null,
 *                    bytes: number, attempts: number, tooLarge: boolean}>}
 */
async function fetchJson(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  retries = 2,
  retryOn = RETRY_ON,
  signal,
  headers,
} = {}) {
  let attempts = 0;
  let last = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // The run deadline outranks any remaining retries — stop rather than start
    // work we know we can't finish.
    if (signal && signal.aborted) {
      return { ok: false, status: null, data: null, error: 'Run deadline reached',
               bytes: 0, attempts, tooLarge: false };
    }

    attempts++;
    last = await attemptOnce(url, { timeoutMs, maxBytes, signal, headers });

    if (last.ok) return { ...last, attempts };
    // A 404 is Lever's "unknown board" SIGNAL, not a transient failure. Retrying
    // it burns 3x the deadline to learn the same thing.
    if (last.status !== null && !retryOn.includes(last.status)) break;
    if (attempt === retries) break;

    // 250ms, 500ms, ... plus jitter so parallel boards don't retry in lockstep.
    await sleep(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 120));
  }

  return { ...last, attempts };
}

async function attemptOnce(url, { timeoutMs, maxBytes, signal, headers }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: combined,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(headers || {}) },
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false, status: null, data: null, bytes: 0, tooLarge: false,
      error: timedOut ? `Timed out after ${timeoutMs}ms` : `Network error: ${err.message}`,
    };
  }

  // Read the body even on a non-2xx so a JSON error payload is still visible,
  // but never trust it as data.
  const body = await readCapped(res, maxBytes);

  if (body.tooLarge) {
    return { ok: false, status: res.status, data: null, bytes: body.bytes, tooLarge: true,
             error: `Response exceeded ${maxBytes} bytes` };
  }
  if (body.error) {
    return { ok: false, status: res.status, data: null, bytes: body.bytes, tooLarge: false,
             error: body.error };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, data: null, bytes: body.bytes, tooLarge: false,
             error: `HTTP ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(body.text);
  } catch (_) {
    // A board serving an HTML error page must never be mistaken for an empty
    // board — that would mass-close every posting on it.
    return { ok: false, status: res.status, data: null, bytes: body.bytes, tooLarge: false,
             error: 'Invalid JSON in response' };
  }

  return { ok: true, status: res.status, data, error: null, bytes: body.bytes, tooLarge: false };
}

// res.json() offers no way to cap size, and content-length is unreliable here
// (Greenhouse's HEAD reports 0), so the cap has to be enforced while streaming.
// This is not theoretical: Greenhouse /offices is 28MB and Ashby's own board is
// 2.1MB of description HTML we throw away.
async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', bytes: 0, tooLarge: false, error: null };

  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) return { text: '', bytes, tooLarge: true, error: null };
      chunks.push(buf);
    }
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { text: '', bytes, tooLarge: false,
             error: timedOut ? 'Timed out while reading response' : `Read error: ${err.message}` };
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, tooLarge: false, error: null };
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Resolves in input
 * order. Never rejects — a worker that throws yields undefined for that slot,
 * which matters because the board adapters promise never to throw.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = undefined;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, run));
  return out;
}

/**
 * A wall-clock budget for one whole sync run. Trivial, but naming it makes the
 * "skip, don't fail, and above all don't close anything" rule readable at the
 * call site.
 *
 * @param {number} ms
 * @returns {{signal: AbortSignal, remaining: () => number, expired: () => boolean}}
 */
function deadline(ms) {
  const endsAt = Date.now() + ms;
  return {
    signal: AbortSignal.timeout(ms),
    remaining: () => Math.max(0, endsAt - Date.now()),
    expired: () => Date.now() >= endsAt,
  };
}

module.exports = { fetchJson, mapLimit, deadline, USER_AGENT, DEFAULT_MAX_BYTES };
