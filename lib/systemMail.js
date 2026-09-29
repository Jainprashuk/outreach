/**
 * Mail FROM the product (lifecycle emails, weekly reports) through Resend.
 *
 * Deliberately separate from lib/emailOtp.js, which it does not touch: sign-in
 * codes keep their own sender address so that a spam complaint about a weekly
 * report can never hurt anybody's ability to log in. Both share RESEND_API_KEY.
 *
 * Never the user's Gmail (lib/mailer.js): these arrive before Gmail is connected,
 * and they must not spend the user's outreach reputation.
 *
 * NOT configured — and therefore sending nothing — unless LIFECYCLE_FROM_EMAIL
 * is set. That is the second, deployment-level gate behind the admin's master
 * switch: a deploy that forgets the variable is silent, not noisy.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15000;   // longer than OTP's 8s: these can carry a PDF

const apiKey = () => process.env.RESEND_API_KEY || '';
const fromAddress = () => process.env.LIFECYCLE_FROM_EMAIL || '';
const replyTo = () => process.env.LIFECYCLE_REPLY_TO || '';

// Tests swap the transport so nothing reaches Resend. Production never sets it.
let _transport = null;
const setTransportForTests = (fn) => { _transport = fn; };

const isConfigured = () => !!_transport || !!(apiKey() && fromAddress());

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * @param {{ to: string, subject: string, text: string, html: string,
 *           attachments?: Array<{ filename: string, content: Buffer }>,
 *           headers?: Record<string,string> }} msg
 * @returns {Promise<{ id: string|null }>}  throws on failure
 */
async function sendSystemEmail(msg) {
  if (_transport) return _transport(msg);
  if (!isConfigured()) throw new Error('Lifecycle mail is not configured (LIFECYCLE_FROM_EMAIL / RESEND_API_KEY)');

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress(),
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(replyTo() ? { reply_to: replyTo() } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.attachments && msg.attachments.length
        ? { attachments: msg.attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })) }
        : {}),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 200)}`);
  }
  const body = await res.json().catch(() => ({}));
  return { id: body.id || null };
}

module.exports = { sendSystemEmail, isConfigured, escapeHtml, setTransportForTests };
