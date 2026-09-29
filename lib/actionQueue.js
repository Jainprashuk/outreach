// Whose move is it? One answer per conversation, kept on Contact.action.
//
// A classified reply says what the person wrote; it doesn't say whether you've dealt with
// it. That's what this tracks: every contact who has replied sits in exactly one of
//   needs-you  — you have to do something
//   waiting    — you've done your part (or they said "reviewing"); comes back after NUDGE_DAYS
//   snoozed    — parked until dueAt (by you, or by a "stay in touch" reply)
//   done       — nothing left to do
//
// State is written only at events (a reply arrives, you reply, you press a button). Time
// never writes anything: a waiting or snoozed item whose dueAt has passed is simply
// MATCHED by NEEDS_YOU_FILTER, so no cron has to wake it up and the badge can't lag.
//
// The count and the list both come from bucketFilter() — never a second copy of the rule.
// Naukri's badge and list once disagreed (55 vs 259) because each wrote its own filter.

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_DAYS = 7;
const RECONNECT_DAYS = 60;

const STATES = ['needs-you', 'waiting', 'snoozed', 'done'];
const BUCKETS = [...STATES, 'all'];

// Categories that put the ball in your court.
const ACTIONABLE = ['resume-requested', 'needs-attention'];

// The rule that recognises out-of-office / automated replies (lib/classify/rules.js). Such a
// reply carries no decision of its own, so it must not replace one that does.
const AUTO_REPLY_RULE = 'OTHER-1';

const REPLIED_ERROR = "Skipped — they replied and you haven't answered yet. Reply to them from the Mailbox.";

const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);

/**
 * The query for one bucket, as of `now`. `needs-you` includes waiting/snoozed items whose
 * time is up, and `waiting`/`snoozed` exclude them — so every contact lands in one bucket.
 */
function bucketFilter(bucket, now = new Date()) {
  const due = { 'action.state': { $in: ['waiting', 'snoozed'] }, 'action.dueAt': { $lte: now } };
  const notDue = { $or: [{ 'action.dueAt': null }, { 'action.dueAt': { $gt: now } }] };
  switch (bucket) {
    case 'needs-you': return { $or: [{ 'action.state': 'needs-you' }, due] };
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
  if ((state === 'waiting' || state === 'snoozed') && action.dueAt && new Date(action.dueAt) <= now) return 'needs-you';
  return state;
}

/**
 * Why an item that has come back is back. A waiting item returns because they went quiet;
 * a snoozed one returns for the reason it was parked with.
 */
function effectiveReason(action, now = new Date()) {
  if (!action) return null;
  if (action.state === 'waiting' && bucketOf(action, now) === 'needs-you') return 'no-response';
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
 * the item was waiting on you, it now waits on them. Returns null when nothing changes.
 *
 * Only a needs-you item moves: sending a note to someone you'd marked done doesn't reopen
 * it, and a snooze you chose isn't cut short by an email.
 */
function onOutbound(prev, at, lastInboundAt, now = new Date()) {
  if (!prev || !prev.state) return null;
  if (lastInboundAt && new Date(at) <= new Date(lastInboundAt)) return null;
  if (bucketOf(prev, now) !== 'needs-you') return null;
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
    return new Date(bucketOf(a, now) === 'needs-you' && a.dueAt && a.state !== 'needs-you' ? a.dueAt : a.since || 0).getTime();
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
  NUDGE_DAYS, RECONNECT_DAYS, STATES, BUCKETS, REPLIED_ERROR,
  bucketFilter, NEEDS_YOU_FILTER, bucketOf, effectiveReason,
  onInbound, onOutbound, forCategory, manual, sortNeedsYou, hasUnansweredReply, addDays,
};
