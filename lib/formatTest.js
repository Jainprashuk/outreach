// "Test format" in Discover: what happened to one test email, worked out from the
// Contact it was sent to. Pure, so every rule here is proven by
// scripts/test-email-patterns.js. The send itself lives in routes/prospects.js.

const { HARD_BOUNCE } = require('./patternScore');

// Most bounces come back within minutes. "No bounce" is only claimed once a mailbox
// check has run at least this long after the email went out.
const WAIT_MS = 15 * 60 * 1000;

const REPLIED = new Set(['replied', 'follow-up-replied']);
const SENT = new Set(['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'closed', 'no-openings', 'in-review']);

/**
 * @param {object} test     FormatTest
 * @param {object|null} contact  the Contact it went to
 * @param {object|null} job      its SendJob (status + the one item)
 * @param {Date|null} lastCheckAt  Settings.lastMailboxCheckAt
 * @returns {{ status: 'sending'|'held'|'failed'|'waiting'|'no-bounce'|'replied'|'bounced'|'bounce-other'|'gone',
 *             reason: string, sentAt: Date|null, checkAfter: Date|null }}
 *   bounced      the address doesn't exist — wrong format, or the person left
 *   bounce-other mailbox full, spam block … says nothing about the format
 */
function testStatus(test, contact, job, lastCheckAt, now = new Date()) {
  if (!contact) return { status: 'gone', reason: 'The contact was deleted', sentAt: null, checkAfter: null };
  const sentAt = contact.lastSentAt ? new Date(contact.lastSentAt) : null;
  const replied = !!contact.repliedAt || REPLIED.has(contact.status)
    || (contact.thread || []).some(t => t && t.direction === 'inbound');

  if (replied) return { status: 'replied', reason: '', sentAt, checkAfter: null };
  if (contact.status === 'bounced') {
    const reason = contact.bounceReason || '';
    return { status: HARD_BOUNCE.test(reason) ? 'bounced' : 'bounce-other', reason, sentAt, checkAfter: null };
  }
  if (contact.status === 'blocked') return { status: 'failed', reason: 'The address is on your blocklist', sentAt, checkAfter: null };
  if (contact.status === 'failed') return { status: 'failed', reason: contact.failReason || 'The send failed', sentAt, checkAfter: null };

  const item = job && (job.items || [])[0];
  if (!sentAt || !SENT.has(contact.status)) {
    if (job && job.status === 'cancelled') return { status: 'failed', reason: 'The send was cancelled', sentAt: null, checkAfter: null };
    if (item && (item.status === 'skipped' || item.status === 'failed')) {
      return { status: 'failed', reason: item.error || 'The send was skipped', sentAt: null, checkAfter: null };
    }
    if (job && job.status === 'paused') return { status: 'held', reason: 'Waiting for Gmail’s daily limit to reset', sentAt: null, checkAfter: null };
    return { status: 'sending', reason: '', sentAt: null, checkAfter: null };
  }

  const checkAfter = new Date(sentAt.getTime() + WAIT_MS);
  if (lastCheckAt && new Date(lastCheckAt) >= checkAfter) return { status: 'no-bounce', reason: '', sentAt, checkAfter };
  return { status: 'waiting', reason: '', sentAt, checkAfter };
}

module.exports = { testStatus, WAIT_MS };
