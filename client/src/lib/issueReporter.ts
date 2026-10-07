// Reports what broke in the browser to the admin's Issues tab (POST /api/issues).
// The server already records every failed API response itself, so this only
// covers what it cannot see: crashes in the page, and requests that never got a
// readable answer (offline, a platform timeout, an HTML error page).
//
// Never throws, never retries, and goes through plain fetch rather than
// apiFetch — a failing report must not report itself.

export type ClientIssueKind = 'js_error' | 'unhandled_rejection' | 'render_crash' | 'network_error';

const MAX_PER_PAGE_LOAD = 20;
const REPEAT_WINDOW_MS = 60_000;
const lastSent = new Map<string, number>();
let sent = 0;

export function reportClientIssue(kind: ClientIssueKind, message: string, extra: { stack?: string; url?: string; method?: string; area?: string } = {}) {
  try {
    const key = `${kind}|${message}`;
    const now = Date.now();
    if ((lastSent.get(key) ?? 0) > now - REPEAT_WINDOW_MS || sent >= MAX_PER_PAGE_LOAD) return;
    lastSent.set(key, now);
    sent++;
    fetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        kind,
        message: String(message || 'Unknown error').slice(0, 2000),
        stack: extra.stack ? String(extra.stack).slice(0, 8000) : '',
        page: window.location.pathname + window.location.hash,
        url: extra.url,
        method: extra.method,
        area: extra.area,
      }),
    }).catch(() => {});
  } catch { /* never let reporting break the page */ }
}

let installed = false;
/** Uncaught errors and unhandled promise rejections, page-wide. Call once. */
export function installGlobalIssueHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // A failed <img>/<script> load fires here too, with no message — skip those.
    if (!e.message) return;
    reportClientIssue('js_error', e.message, { stack: e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = e.reason;
    reportClientIssue('unhandled_rejection', r?.message || String(r), { stack: r?.stack });
  });
}
