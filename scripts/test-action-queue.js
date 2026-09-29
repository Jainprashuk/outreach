// Proves the Needs you queue rules (lib/actionQueue.js). Run with:  node scripts/test-action-queue.js
//
// No database and no network. Part 1 walks every transition. Part 2 checks that the Mongo
// filter and the in-memory bucketOf agree on every state at every point in time — they
// are two spellings of one rule, and a drift between them is exactly the "badge says 3,
// list shows 5" bug. The query is evaluated with sift (mongoose's own matcher dependency).

const q = require('../lib/actionQueue');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

const DAY = 24 * 3600 * 1000;
const t0 = new Date('2026-09-01T10:00:00Z');
const at = (days) => new Date(t0.getTime() + days * DAY);
const verdict = (category, extra = {}) => ({ success: true, category, provider: 'groq', rule: null, ...extra });

// ─────────────────────────────────────────────── part 1: transitions

console.log('\npart 1 — a reply arrives');
{
  const cases = [
    ['resume-requested', 'needs-you', 'resume-requested', null],
    ['needs-attention', 'needs-you', 'needs-attention', null],
    ['reviewing', 'waiting', 'reviewing', q.NUDGE_DAYS],
    ['stay-in-touch', 'snoozed', 'reconnect', q.RECONNECT_DAYS],
    ['no', 'done', 'declined', null],
    ['other', 'done', 'no-action', null],
  ];
  for (const [cat, state, reason, dueDays] of cases) {
    const { action } = q.onInbound(null, verdict(cat), t0);
    const dueOk = dueDays === null ? action.dueAt === null : +action.dueAt === +at(dueDays);
    ok(`${cat} → ${state} (${reason})${dueDays ? `, back in ${dueDays}d` : ''}`, action.state === state && action.reason === reason && dueOk, JSON.stringify(action));
  }

  const failed = q.onInbound(null, { success: false }, t0).action;
  ok('a failed classification is needs-you / unclassified, never a guessed category', failed.state === 'needs-you' && failed.reason === 'unclassified');

  const live = q.onInbound(null, verdict('resume-requested'), t0).action;
  const ooo = q.onInbound(live, verdict('other', { provider: 'rules', rule: 'OTHER-1' }), at(1), 'resume-requested');
  ok('an out-of-office on a live conversation keeps the place and the category', ooo.keepCategory === true && ooo.action === live);

  const unsub = q.onInbound(live, verdict('other', { provider: 'rules', rule: 'OTHER-2' }), at(1), 'resume-requested');
  ok('an unsubscribe on a live conversation does close it', unsub.keepCategory === false && unsub.action.state === 'done');

  const firstOoo = q.onInbound(null, verdict('other', { provider: 'rules', rule: 'OTHER-1' }), t0, null);
  ok('an out-of-office as the only reply is done', firstOoo.keepCategory === false && firstOoo.action.state === 'done');

  const doneBefore = q.manual('done', t0);
  const again = q.onInbound(doneBefore, verdict('needs-attention'), at(3), 'reviewing').action;
  ok('a new message reopens something you had marked done', again.state === 'needs-you');
}

console.log('\npart 1 — you reply');
{
  const needs = q.onInbound(null, verdict('resume-requested'), t0).action;
  const moved = q.onOutbound(needs, at(1), t0, at(1));
  ok('your reply after theirs moves needs-you → waiting', moved && moved.state === 'waiting' && moved.resolvedBy === 'you-replied');
  ok('  and it comes back after the nudge period', +moved.dueAt === +at(1 + q.NUDGE_DAYS));

  ok('a message older than their reply does not count as an answer', q.onOutbound(needs, at(-1), t0, at(1)) === null);

  const snoozed = q.manual('snooze', t0, at(10));
  ok('an email does not cut short a snooze you chose', q.onOutbound(snoozed, at(2), t0, at(2)) === null);

  const done = q.manual('done', t0);
  ok('an email to someone marked done does not reopen it', q.onOutbound(done, at(2), t0, at(2)) === null);

  const overdue = q.onInbound(null, verdict('reviewing'), t0).action;
  const answered = q.onOutbound(overdue, at(8), t0, at(8));
  ok('following up on an overdue "reviewing" puts it back to waiting', answered && answered.state === 'waiting');

  ok('no queue place, nothing to move', q.onOutbound(null, at(1), t0) === null);
}

console.log('\npart 1 — time and reasons');
{
  const reviewing = q.onInbound(null, verdict('reviewing'), t0).action;
  ok('reviewing is waiting before 7 days', q.bucketOf(reviewing, at(6.9)) === 'waiting');
  ok('reviewing goes to follow-up after 7 days, not needs-you', q.bucketOf(reviewing, at(7.1)) === 'follow-up');
  ok('  with the reason "no-response"', q.effectiveReason(reviewing, at(7.1)) === 'no-response');

  const reconnect = q.onInbound(null, verdict('stay-in-touch'), t0).action;
  ok('stay-in-touch comes back to follow-up after 60 days as "reconnect"', q.bucketOf(reconnect, at(61)) === 'follow-up' && q.effectiveReason(reconnect, at(61)) === 'reconnect');

  const mine = q.manual('snooze', t0, at(3));
  ok('a snooze you set comes back to needs-you, not follow-up', q.bucketOf(mine, at(3.1)) === 'needs-you');

  const answered = q.onOutbound(q.onInbound(null, verdict('resume-requested'), t0).action, at(1), t0, at(1));
  ok('no answer 7 days after your reply → follow-up with reason no-response', q.bucketOf(answered, at(8.5)) === 'follow-up' && q.effectiveReason(answered, at(8.5)) === 'no-response');

  const list = [
    { id: 'reconnect', action: reconnect },
    { id: 'resume-new', action: q.onInbound(null, verdict('resume-requested'), at(60)).action },
    { id: 'resume-old', action: q.onInbound(null, verdict('resume-requested'), at(20)).action },
    { id: 'no-response', action: reviewing },
  ];
  const order = q.sortNeedsYou(list, at(61)).map(c => c.id).join(',');
  ok('needs-you sorts by reason first, then longest waiting', order === 'resume-old,resume-new,no-response,reconnect', order);
}

console.log('\npart 1 — sending is blocked while a reply is unanswered');
{
  ok('replied after our last send → blocked', q.hasUnansweredReply({ repliedAt: at(2), lastSentAt: at(1) }));
  ok('you answered in Gmail → allowed', !q.hasUnansweredReply({ repliedAt: at(2), lastSentAt: at(1), lastOutboundAt: at(3) }));
  ok('never replied → allowed', !q.hasUnansweredReply({ repliedAt: null, lastSentAt: at(1) }));
}

// ─────────────────────────────────────────────── part 2: filter ⇔ bucketOf

console.log('\npart 2 — the Mongo filter and bucketOf agree');
let sift = null;
try { sift = require('sift'); sift = sift.default || sift; } catch (_) {}
if (!sift) {
  console.log('  (skipped — sift not installed)');
} else {
  const states = [
    null,
    q.onInbound(null, verdict('resume-requested'), t0).action,
    q.onInbound(null, verdict('reviewing'), t0).action,
    q.onInbound(null, verdict('stay-in-touch'), t0).action,
    q.onInbound(null, verdict('no'), t0).action,
    q.manual('snooze', t0, at(3)),
    q.manual('reopen', t0),
  ];
  const times = [at(0), at(2.99), at(3), at(5), at(7), at(8), at(59), at(61)];
  let mismatches = 0;
  for (const action of states) {
    for (const now of times) {
      const doc = { action: action || { state: null, dueAt: null } };
      const matched = q.BUCKETS.filter(b => b !== 'all' && sift(q.bucketFilter(b, now))(doc));
      const expected = q.bucketOf(action, now);
      const good = expected === null ? matched.length === 0 : matched.length === 1 && matched[0] === expected;
      if (!good) { mismatches++; console.log(`  FAIL ${action?.state}/${action?.reason} @ ${now.toISOString()}: bucketOf=${expected}, filter=${matched}`); }
    }
  }
  ok(`every state × time lands in exactly the bucket bucketOf says (${states.length * times.length} checks)`, mismatches === 0);
}

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
process.exit(fail ? 1 : 0);
