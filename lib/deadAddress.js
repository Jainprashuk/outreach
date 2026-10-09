// Never send to an address that has already bounced (or was blocklisted).
//
// The contact's own `status` is not enough: a campaign reserves contacts as
// `in-campaign` and "Reset for sending" parks them at `queued`, which hides the
// bounce. So the check reads the last REAL status — the newest one that is not
// a reservation — from the contact's history.
//
// One exception: Gmail refusing to send from YOUR account (its spam block,
// support answer 69585, or the daily limit, 5.4.5) is reported as a bounce but
// says nothing about the recipient's address, so those stay sendable.

const DEAD_STATUSES = new Set(['bounced', 'blocked']);
const RESERVED_STATUSES = new Set(['queued', 'in-campaign']);
const SENDER_SIDE_REFUSAL = /answer\/69585|\b5\.4\.5\b|sending limit exceeded/i;

const DEAD_ADDRESS_ERROR = 'Skipped — this address bounced before.';

/** The newest status that is not just a reservation (queued / in-campaign), or null. */
function lastRealStatus(contact) {
  if (!contact) return null;
  if (contact.status && !RESERVED_STATUSES.has(contact.status)) return contact.status;
  const hist = contact.statusHistory || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] && hist[i].status && !RESERVED_STATUSES.has(hist[i].status)) return hist[i].status;
  }
  return null;
}

/** True if this contact's address is known not to accept mail. */
function isDeadAddress(contact) {
  const status = lastRealStatus(contact);
  if (!DEAD_STATUSES.has(status)) return false;
  return !(status === 'bounced' && SENDER_SIDE_REFUSAL.test(contact.bounceReason || ''));
}

module.exports = { DEAD_ADDRESS_ERROR, lastRealStatus, isDeadAddress };
