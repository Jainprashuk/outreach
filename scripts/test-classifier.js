// Proves the reply classifier. Run with:  node scripts/test-classifier.js
//                                         node scripts/test-classifier.js --live
//
// There is no test framework in this repo, so this is a plain script. It touches no
// database and, without --live, no network: part 1 exercises the rules directly and part 2
// drives the orchestrator with STUB providers, because the one thing a live provider can
// never demonstrate is what happens when it rate-limits you.
//
// The assertions that matter most are the MUST-ABSTAIN ones in part 1. A rule that fires
// when it shouldn't is invisible in production — a false `no` closes a live lead and nobody
// ever revisits it — so the abstentions, not the hits, are what keep the rules honest.
//
// --live sends exactly ONE request per configured provider, enough to prove each key,
// endpoint and JSON mode without meaningfully touching a free-tier quota.

require('dotenv').config();

const rules = require('../lib/classify/rules');
const breaker = require('../lib/classify/breaker');
const { classifyReply } = require('../lib/replyClassifier');
const { configuredChain } = require('../lib/classify/providers');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

// ─────────────────────────────────────────────── part 1: the rules

// Replies the rules MUST settle without spending a request.
const DECIDES = [
  ['other', 'Out of Office', 'I am currently out of the office and will return on Monday, 5 October.'],
  ['other', 'Automatic reply: Quick question', "I'm on annual leave until the 12th with limited access to email."],
  ['other', 'Re: Quick question', 'Thank you, your message has been received. This is an automated response.'],
  ['other', 'Away', 'She is on maternity leave. Please contact HR for urgent matters.'],
  ['other', 'Re: Quick question', 'I will be back in the office on 3 November and will respond then.'],
  ['other', 'Re: Quick question', 'This is an automatic reply. I no longer work at Acme.'],
  ['other', 'Re: Quick question', 'Please unsubscribe me.'],
  ['other', 'Re: Quick question', 'Remove me from your mailing list.'],
  ['other', 'Re: Quick question', 'Do not email me again. Thanks.'],
  ['no',    'Re: Quick question', 'We are not hiring at this time. Best of luck with your search.'],
  ['no',    'Re: Quick question', 'Thanks for reaching out. Not interested.'],
  ['no',    'Re: Quick question', 'We have decided to move forward with other candidates.'],
  ['no',    'Re: Quick question', 'We will not be proceeding with your application.'],
];

// Replies the rules MUST hand to a model. These are the real test.
const ABSTAINS = [
  ['a door left open is stay-in-touch, not no',
    'Re: Quick question', "No openings right now, but I'll keep your resume on file and reach back out."],
  ['a rejection that turns into a question',
    'Re: Quick question', "We're not hiring for that role, however what is your notice period?"],
  ['a hedge means the sentence turns somewhere we cannot see',
    'Re: Quick question', 'We are not currently hiring, but that could change next quarter.'],
  ['an unsubscribe link in a signature footer is furniture, not intent',
    'Re: Quick question', "Great to hear from you — let's set up a call this week.\n\n--\nAcme Corp\nTo stop receiving these, unsubscribe here: https://acme.test/unsubscribe"],
  ['an out-of-office that still asks for something is a live lead',
    'Out of office', "I'm out of the office until Monday, but please send your resume to jobs@acme.test."],
  ['our own quoted outreach must not be scanned',
    'Re: Quick question', "Yes! Very interested — when can we talk?\n\nOn Mon, 1 Sep 2026 at 09:00, Prashuk <me@test> wrote:\n> I know you're not hiring right now, but I wanted to reach out"],
  ['a long nuanced reply goes to a model',
    'Re: Quick question', 'We are not hiring. ' + 'Here is a great deal of additional context about our roadmap and headcount planning. '.repeat(25)],
  ['a plain positive reply is not a rule case',
    'Re: Quick question', 'Thanks for reaching out! Your background looks relevant.'],
  ['a resume request is intent, not vocabulary — always a model',
    'Re: Quick question', 'Could you send over your resume?'],
  ['an empty reply is not a verdict', '', ''],
];

console.log('\n── part 1: rules ───────────────────────────────────────────');
console.log('  must decide (no request spent):');
for (const [want, subject, body] of DECIDES) {
  const got = rules.decide(subject, body);
  ok(`${want.padEnd(5)} ${JSON.stringify(body.slice(0, 52))}`,
    got && got.category === want, 'got ' + JSON.stringify(got));
}

console.log('  must abstain (defer to a model):');
for (const [label, subject, body] of ABSTAINS) {
  const got = rules.decide(subject, body);
  ok(label, got === null, 'decided ' + JSON.stringify(got));
}

// HTML-only bodies really do arrive — the call sites pass `parsed.text || parsed.html`.
const htmlOoo = rules.decide('Re: Quick question', '<html><body><p>I am currently <b>out of the office</b> until Friday.</p></body></html>');
ok('an HTML-only out-of-office is still decided', htmlOoo && htmlOoo.category === 'other', 'got ' + JSON.stringify(htmlOoo));

// ─────────────────────────────────────────────── part 2: failover

const stub = (name, result) => {
  const p = {
    name, calls: 0,
    model: () => name + '-model',
    configured: () => true,
    classify: async () => { p.calls++; return typeof result === 'function' ? result() : result; },
  };
  return p;
};

const okResult = { kind: 'ok', verdict: { category: 'reviewing', reasoning: 'looks like a review' }, status: 200 };
const REPLY = { subject: 'Re: Quick question', body: 'Thanks, we are taking a look at your profile.' };

(async () => {
  console.log('\n── part 2: failover (stub providers) ───────────────────────');
  breaker.reset();

  {
    const a = stub('gemini', { kind: 'rate-limited', status: 429, error: 'HTTP 429' });
    const b = stub('groq', okResult);
    const r = await classifyReply(REPLY, { providers: [a, b], log: false });
    ok('a 429 falls through to the next provider', r.success === true && r.provider === 'groq', JSON.stringify(r));
    ok('  and the rate-limited provider was still tried once', a.calls === 1, 'calls=' + a.calls);
    ok('  and the trail records both attempts', r.attempts.length === 2 && r.attempts[0].outcome === 'rate-limited', JSON.stringify(r.attempts));
  }

  {
    breaker.reset();
    const a = stub('groq', { kind: 'auth', status: 401, error: 'HTTP 401' });
    const b = stub('cerebras', okResult);
    const r = await classifyReply(REPLY, { providers: [a, b], log: false });
    ok('a bad key does NOT block the rest of the chain', r.success === true && r.provider === 'cerebras', JSON.stringify(r));
    ok('  and that key is cooled down for an hour', breaker.blocked('groq'), JSON.stringify(breaker.snapshot()));
  }

  {
    breaker.reset();
    const a = stub('gemini', { kind: 'bad-output', status: 200, error: 'unparseable' });
    const b = stub('groq', { kind: 'transient', status: 503, error: 'HTTP 503' });
    const c = stub('cerebras', { kind: 'rate-limited', status: 429, error: 'HTTP 429' });
    const r = await classifyReply(REPLY, { providers: [a, b, c], log: false });
    ok('every provider failing yields the fallback', r.success === false && r.category === 'needs-attention', JSON.stringify(r));
    ok('  with the exact reasoning the server migration keys on', r.reasoning === 'classification failed', r.reasoning);
    ok('  and no provider is credited', r.provider === null, String(r.provider));
  }

  {
    breaker.reset();
    const a = stub('gemini', { kind: 'rate-limited', status: 429, error: 'HTTP 429' });
    const b = stub('groq', okResult);
    await classifyReply(REPLY, { providers: [a, b], log: false });
    await classifyReply(REPLY, { providers: [a, b], log: false });
    ok('a cooled-down provider is not re-asked in the same process', a.calls === 1, 'calls=' + a.calls);
    ok('  and the second call still succeeds via the next one', b.calls === 2, 'calls=' + b.calls);
  }

  {
    breaker.reset();
    const a = stub('gemini', okResult);
    const r = await classifyReply(REPLY, { providers: [a], log: false, signal: AbortSignal.abort() });
    ok('an already-aborted caller spends nothing', a.calls === 0 && r.success === false, JSON.stringify(r));
  }

  {
    breaker.reset();
    const a = stub('gemini', okResult);
    const r = await classifyReply(
      { subject: 'Out of office', body: 'I am currently out of the office until Monday.' },
      { providers: [a], log: false },
    );
    ok('a rules hit never reaches a provider', a.calls === 0 && r.provider === 'rules', JSON.stringify(r));
    ok('  and counts as a real verdict, so backfill will not re-try it', r.success === true, JSON.stringify(r));
  }

  {
    breaker.reset();
    const r = await classifyReply(REPLY, { providers: [], log: false });
    ok('no configured provider and no rule hit leaves it unclassified', r.success === false && r.provider === null, JSON.stringify(r));
  }

  // ─────────────────────────────────────────── part 3: live smoke
  if (process.argv.includes('--live')) {
    console.log('\n── part 3: live (one request per configured provider) ──────');
    breaker.reset();
    const chain = configuredChain();
    if (!chain.length) console.log('  (no provider keys set — nothing to check)');
    for (const p of chain) {
      const started = Date.now();
      const r = await p.classify(REPLY, { timeoutMs: 15_000 });
      const line = `${p.name} · ${p.model()} · ${Date.now() - started}ms · ${r.kind}`;
      ok(line + (r.verdict ? ` · ${r.verdict.category}` : ''), r.kind === 'ok', r.error || '');
    }
    const names = chain.map(p => p.name).join(' → ');
    console.log('  chain: ' + (names || '(empty)'));
  } else {
    console.log('\n  (part 3 skipped — pass --live to send one real request per provider)');
  }

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exit(1);
});
