/**
 * Public, signed-link unsubscribe — no session, because the whole point is that
 * it works from an email client on a phone that has never signed in.
 *
 * Mounted ahead of attachUser, and let through requireAuth by EXACT path only
 * (PUBLIC_EMAIL_PATHS in server.js). The HMAC token in `t` is the credential;
 * it names one account and one preference, and can do nothing else.
 *
 *   GET  → a confirmation page with a button (link scanners prefetch GETs, so a
 *          GET must not change anything)
 *   POST → unsubscribes. Also the RFC 8058 one-click target that Gmail's own
 *          "Unsubscribe" button posts to.
 */
const express = require('express');
const User = require('../models/User');
const { readToken } = require('../lib/lifecycle/unsubscribe');
const { PREFS } = require('../lib/lifecycle/types');
const { escapeHtml: e } = require('../lib/systemMail');
const { logEvent } = require('../lib/activityLog');

const router = express.Router();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title></head>
<body style="margin:0;padding:40px 16px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#111827">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;font-size:14px;line-height:1.55;color:#374151">
${body}</div></body></html>`;

router.get('/unsubscribe', (req, res) => {
  const tok = readToken(req.query.t);
  if (!tok) return res.status(400).send(page('Link not valid', '<p style="margin:0">This unsubscribe link is not valid. You can change email preferences in Outreach under Settings.</p>'));
  const label = PREFS[tok.pref].label.toLowerCase();
  res.send(page('Unsubscribe', `
<p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#111827">Stop ${e(label)}?</p>
<form method="post" action="/api/email/unsubscribe?t=${encodeURIComponent(req.query.t)}">
  <button type="submit" style="background:#4f46e5;color:#fff;border:0;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Unsubscribe</button>
</form>
<p style="margin:16px 0 0;font-size:12.5px;color:#6b7280">You can turn it back on any time in Settings.</p>`));
});

router.post('/unsubscribe', async (req, res) => {
  const tok = readToken(req.query.t);
  if (!tok) return res.status(400).send(page('Link not valid', '<p style="margin:0">This unsubscribe link is not valid.</p>'));
  try {
    const r = await User.updateOne({ _id: tok.userId }, { $addToSet: { emailOptOut: tok.pref } });
    if (r.matchedCount) {
      logEvent({ userId: tok.userId, category: 'email', action: 'unsubscribed', message: `Unsubscribed from ${PREFS[tok.pref].label.toLowerCase()} via email link`, meta: { pref: tok.pref } }).catch(() => {});
    }
    res.send(page('Unsubscribed', `<p style="margin:0 0 10px;font-size:16px;font-weight:600;color:#111827">Done.</p>
<p style="margin:0">You won't get ${e(PREFS[tok.pref].label.toLowerCase())} any more. You can turn it back on in Settings.</p>`));
  } catch (err) {
    res.status(503).send(page('Try again', '<p style="margin:0">Something went wrong. Please try the link again in a minute.</p>'));
  }
});

module.exports = router;
