// Duplicate-send protection: a contact emailed within COOLDOWN_MS is never
// emailed again, and — just as important — is never knocked back to `queued`,
// so an accidental re-send leaves their real status untouched.

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours between sends to the same contact
const COOLDOWN_LABEL = '24 hours';

const COOLDOWN_ERROR = `Skipped — already emailed within the last ${COOLDOWN_LABEL}.`;

/** True if `contact` was emailed inside the cooldown window. */
function inCooldown(contact, now = Date.now()) {
  if (!contact || !contact.lastSentAt) return false;
  const t = new Date(contact.lastSentAt).getTime();
  return Number.isFinite(t) && (now - t) < COOLDOWN_MS;
}

/** Milliseconds left before `contact` may be emailed again (0 if free). */
function cooldownRemaining(contact, now = Date.now()) {
  if (!inCooldown(contact, now)) return 0;
  return COOLDOWN_MS - (now - new Date(contact.lastSentAt).getTime());
}

/**
 * The status a contact should hold when a send is skipped — i.e. the last real
 * status it reached before some "Reset for sending" parked it at `queued`.
 */
function priorStatus(contact) {
  const hist = (contact && contact.statusHistory) || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].status && hist[i].status !== 'queued') return hist[i].status;
  }
  return contact && contact.followUpSentAt ? 'follow-up-sent' : 'sent';
}

module.exports = { COOLDOWN_MS, COOLDOWN_LABEL, COOLDOWN_ERROR, inCooldown, cooldownRemaining, priorStatus };
