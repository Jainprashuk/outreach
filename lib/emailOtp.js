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
const { layout, heading, para, callout, button, escapeHtml, appTextLine } = require('./emailLayout');

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

const textBody = (code, ttlMinutes) => `${code}

That is your Outreach sign-in code. It expires in ${ttlMinutes} minutes and can
only be used once.

If you did not try to sign in, you can ignore this email — without the code,
nothing happens.
${appTextLine()}`;

// The shared layout (lib/emailLayout.js) is pure string building with no
// requires, so using it keeps this sender fully separate from lifecycle mail.
const htmlBody = (code, ttlMinutes) => layout({
  width: 460,
  preheader: `${code} is your sign-in code. It expires in ${ttlMinutes} minutes.`,
  body: `
    ${heading('Your sign-in code')}
    ${para('Enter this code on the Outreach sign-in screen:')}
    ${callout(`<div style="font-size:34px;line-height:1.2;font-weight:700;letter-spacing:8px;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center">${escapeHtml(code)}</div>`)}
    ${para(`It expires in ${ttlMinutes} minutes and can only be used once.`, { muted: true, small: true })}
    ${para('If you did not try to sign in, you can ignore this email — without the code, nothing happens.', { muted: true, small: true, last: true })}`,
  footer: 'Outreach will never ask you for this code by phone, chat or email.',
});

const approvedHtml = (link) => layout({
  width: 460,
  preheader: 'You can now sign in with this email address.',
  body: `
    ${heading("You're in")}
    ${para('Your request for Outreach access has been approved.')}
    ${para('Sign in with this email address. Each time, a six-digit code is sent here — there is no password to remember.', { last: !link })}
    ${link ? button(`${link}/login`, 'Sign in to Outreach') : ''}`,
});

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

/**
 * Tells somebody their access request was approved.
 *
 * Only the approval is emailed. A rejection is not: a silent "no" is kinder than
 * a form letter, it gives nobody a reason to argue with, and it keeps the admin
 * from having to justify a decision to a stranger.
 *
 * Never throws — an approval that cannot be emailed is still an approval, and
 * failing the admin's click because of a mail hiccup would be the wrong end to
 * break.
 */
async function sendAccessApproved({ to, appUrl }) {
  const link = appUrl || '';
  if (!isConfigured()) {
    console.log(`\n  [access] approved ${to} (RESEND_API_KEY not set; not emailed)\n`);
    return { delivered: false, dev: true };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: OTP_FROM_EMAIL,
        to: [to],
        subject: 'Your Outreach access has been approved',
        text: `Your request for Outreach access has been approved.\n\n${link ? `Sign in: ${link}/login\n\n` : ''}Sign in with this email address. Each time, a six-digit code is sent here. There is no password to remember.\n${appTextLine()}`,
        html: approvedHtml(link),
        ...(OTP_REPLY_TO ? { reply_to: OTP_REPLY_TO } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[access] approval email failed: Resend ${res.status}: ${detail.slice(0, 200)}`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    console.error(`[access] approval email failed: ${err.message}`);
    return { delivered: false };
  }
}

module.exports = { sendLoginCode, sendAccessApproved, isConfigured };
