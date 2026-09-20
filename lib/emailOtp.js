/**
 * Delivers sign-in codes through Resend's REST API.
 *
 * Plain fetch, no SDK: Node 18+ has fetch built in, and this is one POST. The
 * repo already chose crypto.scrypt over bcrypt to avoid adding a dependency
 * that has to build on Vercel; the same reasoning applies here.
 *
 * Outreach mail goes out over the user's own Gmail (lib/mailer.js). Auth mail
 * deliberately does not: a person who cannot sign in has no credential for us
 * to send with, and mixing the two would put login deliverability at the mercy
 * of whatever a user's outreach reputation looks like.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OTP_FROM_EMAIL = process.env.OTP_FROM_EMAIL;
const OTP_REPLY_TO = process.env.OTP_REPLY_TO || '';

// Without a deadline, a hung Resend call holds the whole serverless invocation
// to its wall clock and the caller gets a gateway error instead of a login page.
const SEND_TIMEOUT_MS = 8000;

// A deployment with no mail provider cannot sign anybody in, and would fall back
// to printing codes into the server log where they are useless and unsafe.
// Failing open on a missing env var is exactly the trap the old "no AUTH_PASSWORD
// means no auth" rule fell into, so refuse to boot instead. Keyed on VERCEL
// rather than NODE_ENV for the same reason lib/session.js keys Secure on it: the
// committed .env sets NODE_ENV=prod locally.
if (process.env.VERCEL && (!RESEND_API_KEY || !OTP_FROM_EMAIL)) {
  throw new Error('RESEND_API_KEY and OTP_FROM_EMAIL must be set on a deployed instance');
}

const isConfigured = () => !!(RESEND_API_KEY && OTP_FROM_EMAIL);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const textBody = (code, ttlMinutes) => `${code}

That is your Outreach sign-in code. It expires in ${ttlMinutes} minutes and can
only be used once.

If you did not try to sign in, you can ignore this email — without the code,
nothing happens.`;

// Inline styles only, and a table-free layout: email clients strip <style>
// blocks and ignore CSS custom properties, so none of the app's design tokens
// are available here.
const htmlBody = (code, ttlMinutes) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#111827">
  <div style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
    <p style="margin:0 0 18px;font-size:15px;color:#374151">Your Outreach sign-in code:</p>
    <p style="margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:8px;font-variant-numeric:tabular-nums;color:#111827">${escapeHtml(code)}</p>
    <p style="margin:0 0 6px;font-size:13px;color:#6b7280">It expires in ${ttlMinutes} minutes and can only be used once.</p>
    <p style="margin:0;font-size:13px;color:#6b7280">If you did not try to sign in, you can ignore this email.</p>
  </div>
</body></html>`;

/**
 * Sends one code. Resolves { delivered } or throws — the caller records the
 * failure on the LoginCode row and still answers the request identically, so
 * that a delivery problem cannot be used to tell a real address from an unknown
 * one.
 */
async function sendLoginCode({ to, code, ttlMinutes }) {
  if (!isConfigured()) {
    // Local development. Never reached on a deployment: the boot guard above
    // makes that impossible. Safe to print precisely because no mail provider is
    // configured, so this code cannot have been sent anywhere.
    console.log(`\n  [otp] ${to} -> ${code}  (RESEND_API_KEY not set; not emailed)\n`);
    return { delivered: false, dev: true };
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: OTP_FROM_EMAIL,
      to: [to],
      // The code is in the subject as well as the body because that is what
      // shows in a phone's notification preview, which is where most people
      // will actually read it.
      subject: `${code} is your Outreach sign-in code`,
      text: textBody(code, ttlMinutes),
      html: htmlBody(code, ttlMinutes),
      ...(OTP_REPLY_TO ? { reply_to: OTP_REPLY_TO } : {}),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 200)}`);
  }
  return { delivered: true };
}

module.exports = { sendLoginCode, isConfigured };
