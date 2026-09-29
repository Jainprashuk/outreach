// Whose move is it? One answer per conversation, kept on Contact.action.
//
// A classified reply says what the person wrote; it doesn't say whether you've dealt with
// it. That's what this tracks: every contact who has replied sits in exactly one bucket
//   needs-you  — they're waiting on you (a question, a resume request, your snooze ran out)
//   follow-up  — you're chasing them: no answer NUDGE_DAYS after your reply or their
//                "reviewing", or a "stay in touch" whose RECONNECT_DAYS are up
//   waiting    — you've done your part (or they said "reviewing"); not due yet
//   snoozed    — parked until dueAt (by you, or by a "stay in touch" reply)
//   done       — nothing left to do
//
// Only four of those are stored states. follow-up is never written: it's a waiting item, or
// a "reconnect" snooze, whose dueAt has passed — and a snooze you set yourself comes back to
// needs-you instead. Time never writes anything: those items are simply MATCHED by the
// bucket's filter, so no cron has to wake them up and the badge can't lag.
//
// The count and the list both come from bucketFilter() — never a second copy of the rule.
// Naukri's badge and list once disagreed (55 vs 259) because each wrote its own filter.

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_DAYS = 7;
const RECONNECT_DAYS = 60;

const STATES = ['needs-you', 'waiting', 'snoozed', 'done'];      // what Contact.action.state stores
const QUEUE_BUCKETS = ['needs-you', 'follow-up', 'waiting', 'snoozed', 'done'];
const BUCKETS = [...QUEUE_BUCKETS, 'all'];

// Categories that put the ball in your court.
const ACTIONABLE = ['resume-requested', 'needs-attention'];

// The rule that recognises out-of-office / automated replies (lib/classify/rules.js). Such a
// reply carries no decision of its own, so it must not replace one that does.
const AUTO_REPLY_RULE = 'OTHER-1';

const REPLIED_ERROR = "Skipped — they replied and you haven't answered yet. Reply to them from the Mailbox.";

const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);

/**
 * The query for one bucket, as of `now`. Items whose time is up leave `waiting`/`snoozed`
 * for `follow-up` (you're chasing) or `needs-you` (your own snooze) — so every contact
 * lands in exactly one bucket.
 */
function bucketFilter(bucket, now = new Date()) {
  const isDue = { 'action.dueAt': { $lte: now } };
  const notDue = { $or: [{ 'action.dueAt': null }, { 'action.dueAt': { $gt: now } }] };
  const chase = { $or: [{ 'action.state': 'waiting' }, { 'action.state': 'snoozed', 'action.reason': 'reconnect' }] };
  switch (bucket) {
    case 'needs-you': return { $or: [
      { 'action.state': 'needs-you' },
      { 'action.state': 'snoozed', 'action.reason': { $ne: 'reconnect' }, ...isDue },
    ] };
    case 'follow-up': return { $and: [chase, isDue] };
    case 'waiting':   return { 'action.state': 'waiting', ...notDue };
    case 'snoozed':   return { 'action.state': 'snoozed', ...notDue };
    case 'done':      return { 'action.state': 'done' };
    default:          return { 'action.state': { $in: STATES } };
  }
}

const NEEDS_YOU_FILTER = (now = new Date()) => bucketFilter('needs-you', now);

/** The bucket a single contact is in right now — the in-memory twin of bucketFilter. */
function bucketOf(action, now = new Date()) {
  const state = action && action.state;
  if (!state) return null;
  if ((state === 'waiting' || state === 'snoozed') && action.dueAt && new Date(action.dueAt) <= now) {
    return state === 'waiting' || action.reason === 'reconnect' ? 'follow-up' : 'needs-you';
  }
  return state;
}

/**
 * Why an item that has come back is back. A waiting item returns because they went quiet;
 * a snoozed one returns for the reason it was parked with.
 */
function effectiveReason(action, now = new Date()) {
  if (!action) return null;
  if (action.state === 'waiting' && bucketOf(action, now) === 'follow-up') return 'no-response';
  return action.reason || null;
}

const make = (state, reason, at, extra = {}) => ({
  state, reason, since: at, dueAt: null, resolvedBy: null, ...extra,
});

/**
 * A reply arrived. Returns `{ action, keepCategory }`:
 *   action       — the new Contact.action
 *   keepCategory — true when the reply is an auto-reply that must NOT replace the
 *                  existing category (the caller then leaves replyCategory alone)
 *
 * @param {object|null} prev    the contact's current action
 * @param {object} verdict      {success, category, provider, rule} from classifyReply
 * @param {Date} at             when the reply was sent
 * @param {string|null} prevCategory  the contact's current replyCategory
 */
function onInbound(prev, verdict, at, prevCategory = null) {
  const when = at || new Date();

  // An out-of-office on top of a real conversation: note it, change nothing.
  if (verdict.success && verdict.rule === AUTO_REPLY_RULE && prev && prev.state && prevCategory && prevCategory !== 'other') {
    return { action: prev, keepCategory: true };
  }

  if (!verdict.success) return { action: make('needs-you', 'unclassified', when), keepCategory: false };
  return { action: forCategory(verdict.category, when), keepCategory: false };
}

/** Where a reply of this category belongs. Also used when you change the category by hand. */
function forCategory(category, at = new Date()) {
  if (ACTIONABLE.includes(category)) return make('needs-you', category, at);
  if (category === 'reviewing') return make('waiting', 'reviewing', at, { dueAt: addDays(at, NUDGE_DAYS) });
  if (category === 'stay-in-touch') return make('snoozed', 'reconnect', at, { dueAt: addDays(at, RECONNECT_DAYS) });
  if (category === 'no' || category === 'other') return make('done', category === 'no' ? 'declined' : 'no-action', at, { resolvedBy: 'auto' });
  return make('needs-you', 'unclassified', at);
}

/**
 * You sent something (from Gmail or from the app). If it answers their latest message and
 * the item was waiting on you — or was due a follow-up, which this is — it now waits on
 * them. Returns null when nothing changes.
 *
 * Only a needs-you or follow-up item moves: sending a note to someone you'd marked done
 * doesn't reopen it, and a snooze you chose isn't cut short by an email.
 */
function onOutbound(prev, at, lastInboundAt, now = new Date()) {
  if (!prev || !prev.state) return null;
  if (lastInboundAt && new Date(at) <= new Date(lastInboundAt)) return null;
  if (!['needs-you', 'follow-up'].includes(bucketOf(prev, now))) return null;
  return make('waiting', 'you-replied', at, { dueAt: addDays(at, NUDGE_DAYS), resolvedBy: 'you-replied' });
}

/** Manual controls. `until` is required for snooze. */
function manual(op, now = new Date(), until = null) {
  if (op === 'done') return make('done', 'manual', now, { resolvedBy: 'manual' });
  if (op === 'reopen') return make('needs-you', 'manual', now);
  if (op === 'snooze') return make('snoozed', 'manual', now, { dueAt: until });
  return null;
}

/** Most actionable first; within a group, the one waiting longest first. */
const REASON_RANK = ['resume-requested', 'needs-attention', 'unclassified', 'no-response', 'reconnect', 'manual'];

function sortNeedsYou(contacts, now = new Date()) {
  const rank = (c) => {
    const i = REASON_RANK.indexOf(effectiveReason(c.action, now) || '');
    return i === -1 ? REASON_RANK.length : i;
  };
  // An item that came back is "waiting on you" since the moment it came back, not since it
  // was parked — otherwise a 60-day snooze would sort as the oldest thing on the list.
  const since = (c) => {
    const a = c.action || {};
    return new Date(a.state !== 'needs-you' && a.dueAt && new Date(a.dueAt) <= now ? a.dueAt : a.since || 0).getTime();
  };
  return [...contacts].sort((a, b) => rank(a) - rank(b) || since(a) - since(b));
}

/**
 * Their latest reply is newer than anything you've sent them. A templated email must not go
 * out then: it would talk past what they just wrote, and the send used to overwrite the
 * `replied` status as well. Once you've answered (from the app or Gmail) a later campaign
 * email is allowed again. `repliedAt` survives every status change, which is why it's used.
 */
function hasUnansweredReply(contact) {
  if (!contact || !contact.repliedAt) return false;
  const replied = new Date(contact.repliedAt).getTime();
  const answered = Math.max(
    contact.lastSentAt ? new Date(contact.lastSentAt).getTime() : 0,
    contact.lastOutboundAt ? new Date(contact.lastOutboundAt).getTime() : 0,
  );
  return replied > answered;
}

module.exports = {
  NUDGE_DAYS, RECONNECT_DAYS, STATES, QUEUE_BUCKETS, BUCKETS, REPLIED_ERROR,
  bucketFilter, NEEDS_YOU_FILTER, bucketOf, effectiveReason,
  onInbound, onOutbound, forCategory, manual, sortNeedsYou, hasUnansweredReply, addDays,
};
