/**
 * First-run setup state, shared by the onboarding routes, the send guard and the
 * migration that backfills existing accounts.
 */

// Bump to make every existing account re-run the wizard. Stored on each user as
// onboarding.version so that a bump is a comparison, not a migration.
const ONBOARDING_VERSION = 1;

const STEPS = ['gmail', 'identity', 'starter'];
const REQUIRED_STEPS = ['gmail', 'identity'];

// Settings ships these as schema defaults, so "the user has not set a sender
// name" reads as this exact string rather than as an empty field.
const DEFAULT_SENDER_NAME = 'Your Name';
const DEFAULT_SENDER_COMPANY = 'Your Company';

const isOnboarded = (user) =>
  !!(user && user.onboarding && user.onboarding.completedAt
     && (user.onboarding.version || 0) >= ONBOARDING_VERSION);

/** What still has to happen before POST /api/onboarding/complete will pass. */
function checkReadiness(settings) {
  const senderName = String((settings && settings.senderName) || '').trim();
  return {
    gmail: !!(settings && settings.gmailAppPasswordEnc),
    identity: !!senderName && senderName !== DEFAULT_SENDER_NAME,
  };
}

module.exports = {
  ONBOARDING_VERSION,
  STEPS,
  REQUIRED_STEPS,
  DEFAULT_SENDER_NAME,
  DEFAULT_SENDER_COMPANY,
  isOnboarded,
  checkReadiness,
};
