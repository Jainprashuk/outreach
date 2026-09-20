/* Third-party telemetry: Microsoft Clarity (session replay / heatmaps) and
 * BugTrace (JS errors, failed API calls, breadcrumbs).
 *
 * This file is NOT served straight off disk. server.js registers an explicit
 * route for /js/telemetry.js ahead of express.static and substitutes the
 * placeholder below from the environment, so the key stays a deploy-time
 * setting instead of a literal committed to the repo. (It is a publishable
 * client key either way — it ships to every browser — but keeping it in the
 * environment means dev, preview and prod can report to different projects.)
 *
 * Loaded as a plain blocking <script> in <head>, before the app's own code, so
 * BugTrace's window.onerror / fetch hooks are installed before anything can
 * throw. Both integrations are wrapped so a failure here can never take a page
 * down with it.
 */
(function () {
  'use strict';

  var CLARITY_PROJECT_ID = 'yldhruor7v';
  var BUGTRACE_API_KEY = '__BUGTRACE_API_KEY__';
  var BUGTRACE_SDK = 'https://esm.sh/bug-tracker-sdk@1.0.24';

  // ── Microsoft Clarity ──────────────────────────────────────────────────────
  try {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
  } catch (e) { /* analytics must never break the app */ }

  // ── BugTrace ───────────────────────────────────────────────────────────────
  // The SDK is ESM-only on npm and the classic pages have no bundler, so it is
  // pulled from esm.sh (which also resolves its html2canvas dependency). The
  // React client loads this same file rather than taking a build-time
  // dependency, so both UIs report through one code path.
  //
  // Nothing is initialised when the key is unset — an unconfigured environment
  // stays silent instead of firing keyless requests at the collector.
  if (!BUGTRACE_API_KEY || BUGTRACE_API_KEY.indexOf('__BUGTRACE') === 0) return;

  import(/* webpackIgnore: true */ BUGTRACE_SDK)
    .then(function (mod) {
      mod.initBugTracker({
        apiKey: BUGTRACE_API_KEY,
        features: {
          capturePerformance: true,
          // Screenshots are html2canvas rasterisations of the whole page. This
          // app's pages show recruiter names, email addresses and message
          // bodies, so shipping one with every error would put contact data in
          // the error store. Stack traces, request/response detail and
          // breadcrumbs are kept; the picture is not.
          captureScreenshots: {
            fetchErrors: false,
            axiosErrors: false,
            consoleErrors: false,
          },
        },
      });
      // Let app code report handled failures: window.BugTrace.capture(err, {...})
      window.BugTrace = { capture: mod.captureError };
    })
    .catch(function () { /* CDN blocked or offline — the app carries on */ });
})();
