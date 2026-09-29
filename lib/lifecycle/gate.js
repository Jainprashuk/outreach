/**
 * The single decision "may this email go to this person, and to which address".
 *
 * Every lifecycle send passes through decide() immediately before it is sent —
 * the sweep, the Inngest worker, the manual "email it to me" button — so a
 * switch flipped a second ago is honoured. The preview script calls it too,
 * which is what makes its answer trustworthy.
 *
 * The order is the spec's order, and ANY off stops the email:
 *   1. the master switch            (admin, app-wide)
 *   2. the type's switch            (admin, app-wide)
 *   3. the type for this user       (admin, per user)
 *   4. the user's own opt-out       (the user; the admin cannot override it)
 * plus two facts: disabled accounts get nothing, and a deployment with no
 * lifecycle sender configured sends nothing.
 */
const { TYPES } = require('./types');
const systemMail = require('../systemMail');
const unsubscribe = require('./unsubscribe');

/**
 * @param {string} type
 * @param {{email:string,status?:string,emailOptOut?:string[],emailBlockedByAdmin?:string[]}} user
 * @param {object} config  from getLifecycleConfig()
 * @param {{ ignoreMaster?: boolean }} opts  ignoreMaster is ONLY for the
 *   preview's "what if you switched it on" column. Nothing that sends passes it.
 * @returns {{ send: boolean, reason: string|null, to: string, testMode: boolean }}
 */
function decide(type, user, config, opts = {}) {
  const no = (reason) => ({ send: false, reason, to: '', testMode: !!config.testMode });
  const spec = TYPES[type];
  if (!spec) return no('unknown-type');
  if (!user || !user.email) return no('no-user');
  if (user.status === 'disabled') return no('disabled');

  if (!opts.ignoreMaster && !config.enabled) return no('master-off');
  if (config.types[type] !== true) return no('type-off');
  if ((user.emailBlockedByAdmin || []).includes(type)) return no('user-blocked');
  if (spec.pref && (user.emailOptOut || []).includes(spec.pref)) return no('opted-out');
  if (!systemMail.isConfigured()) return no('sender-not-configured');
  // Every link in these emails, and the unsubscribe link the law expects on all
  // but the welcome, needs the public URL and a signing key.
  if (!unsubscribe.appUrl() || !unsubscribe.isConfigured()) return no('links-not-configured');

  if (config.testMode) {
    // Test mode is "send only to me": the admin who switched it on gets their
    // OWN emails, and everyone else's are recorded but go nowhere. It does NOT
    // redirect other people's mail to the admin — a weekly report lists the
    // user's contacts, and the admin sees aggregates only, never another
    // account's rows. Fails closed: no recipient means nobody.
    if (!config.testRecipient) return no('test-mode-no-recipient');
    if (String(user.email).toLowerCase() !== String(config.testRecipient).toLowerCase()) return no('test-mode');
    return { send: true, reason: null, to: user.email, testMode: true };
  }
  return { send: true, reason: null, to: user.email, testMode: false };
}

// Plain-language versions for the admin panel and the preview script.
const REASONS = {
  'master-off': 'all lifecycle emails are switched off',
  'type-off': 'this email type is switched off app-wide',
  'user-blocked': 'switched off for this user by an admin',
  'opted-out': 'the user opted out',
  disabled: 'the account is disabled',
  'sender-not-configured': 'LIFECYCLE_FROM_EMAIL / RESEND_API_KEY are not set',
  'links-not-configured': 'OUTREACH_URL / CREDENTIAL_KEY are not set',
  'test-mode': 'test mode is on, so only the admin\'s own emails are sent',
  'test-mode-no-recipient': 'test mode is on but has no recipient',
  'no-user': 'the account no longer exists',
  'not-due': 'no longer due',
};

module.exports = { decide, REASONS };
