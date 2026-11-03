#!/usr/bin/env node
// A rate-limited AI key costs ONE failed call across a run of questions, not
// one per question — and that cooldown never reaches reply sorting.
//
// No network, no database: the provider chain is replaced before
// lib/naukriDraft.js (which destructures chainFor) is loaded.
//
//   node scripts/test-ai-cooldown.js

const providers = require('../lib/classify/providers');
const breaker = require('../lib/classify/breaker');
const { KIND } = require('../lib/classify/providers/kinds');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `  << ${detail}` : ''}`); }
};

const calls = { limited: 0, good: 0 };
const fake = (name, reply) => ({
  name, breakerKey: `${name}:u1`, keySource: 'user',
  complete: async () => { calls[name]++; return reply(); },
});
const limited = fake('limited', () => ({ kind: KIND.RATE_LIMITED, error: '429' }));
const good = fake('good', () => ({ kind: KIND.OK, text: '{"answer":null}' }));
providers.chainFor = async () => [limited, good];

const naukriDraft = require('../lib/naukriDraft');

(async () => {
  console.log('scoped cooldown');
  breaker.reset();
  for (let i = 0; i < 4; i++) {
    await naukriDraft.draftAnswer(`Question ${i}?`, { resumeText: 'Skills: Node.js', userId: 'u1' });
  }
  ok('4 questions, rate-limited key called once', calls.limited === 1, `called ${calls.limited}x`);
  ok('…the next key answered all 4', calls.good === 4, `called ${calls.good}x`);
  ok('…reply sorting does not see the cooldown', breaker.blocked('limited:u1') === false);
  ok('…the jobs features do', breaker.blockedIn('jobs', limited) === true);

  breaker.reset();
  breaker.coolIn('jobs', good, { kind: KIND.BAD_OUTPUT });
  ok('a bad answer (not the key\'s fault) cools nothing', breaker.blockedIn('jobs', good) === false);
  breaker.trip('good:u1', 60_000, 'rate-limited');
  ok('a global cooldown (from reply sorting) is honoured by jobs too', breaker.blockedIn('jobs', good) === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
