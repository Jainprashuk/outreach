#!/usr/bin/env node
/**
 * Tests lib/fanout.js against stubs — no database, no network.
 *
 * This logic only ever runs unattended, on a schedule, where nobody sees it
 * misbehave: a swallowed failure, a starved account or an overrun budget all
 * look like "the cron ran fine" from the outside.
 *
 *   node scripts/test-fanout.js
 */
const { runForUsers } = require('../lib/fanout');

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log(`  ok   ${msg}`)) : (fail++, console.log(`  FAIL ${msg}`)); };

const never = { expired: () => false };
const always = { expired: () => true };
const afterCalls = (n) => { let i = 0; return { expired: () => i++ >= n }; };

async function main() {
  console.log('\nAll users processed:');
  {
    const seen = [];
    const r = await runForUsers(['a', 'b', 'c'], async (u) => { seen.push(u); return { ok: true }; }, { budget: never });
    check(seen.join(',') === 'a,b,c', 'visits every user in order');
    check(r.processed === 3 && r.failed === 0 && r.remaining === 0, 'reports 3 processed, 0 failed, 0 remaining');
  }

  console.log('\nOne failure must not stop the sweep:');
  {
    const seen = [];
    const r = await runForUsers(['a', 'b', 'c'], async (u) => {
      seen.push(u);
      if (u === 'b') throw new Error('expired app password');
      return { ok: true };
    }, { budget: never });
    check(seen.join(',') === 'a,b,c', 'continues past the failing user');
    check(r.failed === 1 && r.processed === 2, 'counts 1 failed and 2 processed');
    check(r.results.find(x => x.userId === 'b').error === 'expired app password', 'records the failure reason');
  }

  console.log('\nSkips are distinct from failures:');
  {
    const r = await runForUsers(['a', 'b'], async (u) =>
      (u === 'a' ? { ok: false, skipped: 'no_credentials' } : { ok: true }), { budget: never });
    check(r.skipped === 1 && r.processed === 1 && r.failed === 0,
      'an unconfigured account is skipped, not counted as an error');
  }

  console.log('\nBudget:');
  {
    const seen = [];
    const r = await runForUsers(['a', 'b', 'c', 'd'], async (u) => { seen.push(u); return { ok: true }; },
      { budget: afterCalls(2) });
    check(seen.length === 2, 'stops once the budget expires');
    check(r.remaining === 2, 'reports how many were left for the next tick');
  }
  {
    const seen = [];
    await runForUsers(['a'], async (u) => { seen.push(u); return { ok: true }; }, { budget: always });
    check(seen.length === 0, 'an already-expired budget does no work at all');
  }

  console.log('\nEdge cases:');
  {
    const r = await runForUsers([], async () => ({ ok: true }), { budget: never });
    check(r.total === 0 && r.processed === 0, 'no accounts is not an error');
    const r2 = await runForUsers(['a'], async () => ({ ok: true }));
    check(r2.processed === 1, 'works with no budget supplied');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
