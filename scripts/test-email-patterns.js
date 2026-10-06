// Proves the email-guessing rules (lib/emailPatterns.js, lib/patternScore.js and
// lib/discovery/linkedinResult.js). Run with:  node scripts/test-email-patterns.js
//
// No database and no network.

const ep = require('../lib/emailPatterns');
const ps = require('../lib/patternScore');
const { parseLinkedInResult, matchesRoles, normCompany } = require('../lib/discovery/linkedinResult');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-07T10:00:00Z');
const daysAgo = (d) => new Date(now.getTime() - d * DAY);

// ─────────────────────────────────────────────── splitName
console.log('\nsplitName');
{
  const s = (n) => { const p = ep.splitName(n); return p && [p.first, p.last]; };
  eq('plain', s('Rahul Sharma'), ['rahul', 'sharma']);
  eq('three-part name keeps first and last', s('Rahul Kumar Sharma'), ['rahul', 'sharma']);
  eq('middle kept separately', ep.splitName('Rahul Kumar Sharma').middle, ['kumar']);
  eq('accents', s('José Núñez'), ['jose', 'nunez']);
  eq('pronouns in brackets', s('Priya Verma (She/Her)'), ['priya', 'verma']);
  eq('credentials after comma', s('Priya Verma, PMP'), ['priya', 'verma']);
  eq('title after dash', s('Priya Verma - Engineering Manager'), ['priya', 'verma']);
  eq('honorific', s('Dr. Anil Mehta'), ['anil', 'mehta']);
  eq('trailing credential token', s('Anil Mehta MBA'), ['anil', 'mehta']);
  eq('emoji', s('Neha 🚀 Gupta'), ['neha', 'gupta']);
  eq('apostrophe and hyphen', s("Sean O'Brien-Smith"), ['sean', 'obriensmith']);
  eq('single name', s('Rahul'), ['rahul', null]);
  ok('initial-only first name', ep.splitName('R. Sharma').initialOnly === true);
  ok('initial-only last name', ep.splitName('Venkatesh R').lastInitialOnly === true);
  ok('empty → null', ep.splitName('  ') === null);
}

console.log('\nisPlausibleName');
{
  ok('real name', ep.isPlausibleName('Rahul Sharma'));
  ok('single word rejected', !ep.isPlausibleName('Rahul'));
  ok('company word rejected', !ep.isPlausibleName('Acme Hiring'));
  ok('placeholder rejected', !ep.isPlausibleName('LinkedIn Member'));
  ok('too many words rejected', !ep.isPlausibleName('The Best Place To Work Ever'));
  ok('initials only rejected', !ep.isPlausibleName('R K'));
  ok('username with digits rejected', !ep.isPlausibleName('abdul00a'));
  ok('all-lowercase handle rejected', !ep.isPlausibleName('ravi-kumar'));
  ok('bot account rejected', !ep.isPlausibleName('Slash AI'));
  ok('dependabot rejected', !ep.isPlausibleName('dependabot[bot]'));
  ok('initial surname still allowed', ep.isPlausibleName('Premika M'));
}

// ─────────────────────────────────────────────── patterns
console.log('\ngenerateEmail');
{
  const g = (p) => ep.generateEmail('Rahul Kumar Sharma', p, 'acme.in');
  eq('first.last', g('first.last'), 'rahul.sharma@acme.in');
  eq('first', g('first'), 'rahul@acme.in');
  eq('firstlast', g('firstlast'), 'rahulsharma@acme.in');
  eq('flast', g('flast'), 'rsharma@acme.in');
  eq('firstl', g('firstl'), 'rahuls@acme.in');
  eq('first_last', g('first_last'), 'rahul_sharma@acme.in');
  eq('f.last', g('f.last'), 'r.sharma@acme.in');
  eq('last.first', g('last.first'), 'sharma.rahul@acme.in');
  eq('single name cannot fill first.last', ep.generateEmail('Rahul', 'first.last', 'acme.in'), null);
  eq('single name can fill first', ep.generateEmail('Rahul', 'first', 'acme.in'), 'rahul@acme.in');
  eq('initial-only refuses full-first formats', ep.generateEmail('R. Sharma', 'first.last', 'acme.in'), null);
  eq('initial-only allows flast', ep.generateEmail('R. Sharma', 'flast', 'acme.in'), 'rsharma@acme.in');
  eq('unknown pattern', ep.generateEmail('Rahul Sharma', 'nope', 'acme.in'), null);
}

console.log('\ninferPattern');
{
  const i = ep.inferPattern;
  eq('first.last', i('Rahul Sharma', 'rahul.sharma@acme.in'), 'first.last');
  eq('case-insensitive', i('Rahul Sharma', 'Rahul.Sharma@Acme.in'), 'first.last');
  eq('flast', i('Rahul Sharma', 'rsharma@acme.in'), 'flast');
  eq('first', i('Rahul Sharma', 'rahul@acme.in'), 'first');
  eq('f.last', i('Rahul Sharma', 'r.sharma@acme.in'), 'f.last');
  eq('last.first', i('Rahul Sharma', 'sharma.rahul@acme.in'), 'last.first');
  eq('trailing digits ignored', i('Rahul Sharma', 'rahul.sharma2@acme.in'), 'first.last');
  eq('plus tag ignored', i('Rahul Sharma', 'rahul.sharma+news@acme.in'), 'first.last');
  eq('middle name used as surname', i('Rahul Kumar Sharma', 'rahul.kumar@acme.in'), 'first.last');
  eq('nickname → null', i('Robert Smith', 'bob.smith@acme.in'), null);
  eq('role address → null', i('Rahul Sharma', 'careers@acme.in'), null);
  // "venkateshr" is both firstl and firstlast for a one-letter surname.
  eq('ambiguous → null', i('Venkatesh R', 'venkateshr@acme.in'), null);
  eq('initial first name, flast', i('R. Sharma', 'rsharma@acme.in'), 'flast');
  eq('no email', i('Rahul Sharma', ''), null);
}

console.log('\nhelpers');
{
  ok('role address', ep.isRoleAddress('careers@acme.in'));
  ok('role address with suffix', ep.isRoleAddress('hr.india@acme.in'));
  ok('person is not role', !ep.isRoleAddress('rahul.sharma@acme.in'));
  eq('domain from url', ep.normalizeDomain('https://www.Acme.in/about?x=1'), 'acme.in');
  eq('domain from email', ep.normalizeDomain('someone@acme.co.in'), 'acme.co.in');
  eq('junk domain', ep.normalizeDomain('not a domain'), null);
  ok('free mail', ep.isFreeMail('gmail.com'));
  eq('nameKey', ep.nameKey('Dr. Rahul Kumar Sharma'), 'rahul|sharma');
  eq('hunter {first}.{last}', ep.fromHunterPattern('{first}.{last}'), 'first.last');
  eq('hunter {f}{last}', ep.fromHunterPattern('{f}{last}'), 'flast');
  eq('hunter unknown', ep.fromHunterPattern('{last}{f}'), null);
}

// ─────────────────────────────────────────────── scoring
console.log('\ncontactSignal');
{
  const sig = (c) => { const s = ps.contactSignal(c, now); return s && s.kind; };
  eq('reply by status', sig({ status: 'replied' }), 'reply');
  eq('reply by repliedAt beats later bounce', sig({ status: 'bounced', repliedAt: daysAgo(9) }), 'reply');
  eq('reply by inbound thread', sig({ status: 'closed', thread: [{ direction: 'inbound' }] }), 'reply');
  eq('hard bounce', sig({ status: 'bounced', bounceReason: '550 5.1.1 The email account that you tried to reach does not exist' }), 'hardBounce');
  eq('soft bounce ignored', sig({ status: 'bounced', bounceReason: '552 5.2.2 Mailbox full' }), null);
  eq('policy bounce ignored', sig({ status: 'bounced', bounceReason: '550 5.7.1 Message rejected as spam' }), null);
  eq('delivered after 5 days', sig({ status: 'sent', lastSentAt: daysAgo(6) }), 'delivered');
  eq('too recent to count', sig({ status: 'sent', lastSentAt: daysAgo(2) }), null);
  eq('failed send ignored', sig({ status: 'failed', lastSentAt: daysAgo(9) }), null);
  eq('never sent', sig({ status: 'queued' }), null);
}

console.log('\ndecide');
{
  const own = (name, email, extra) => ({ name, email, ...extra });
  const prior = ['first.last', 'first', 'firstlast', 'flast'];

  let d = ps.decide([], prior);
  eq('no evidence → prior, low', [d.pattern, d.confidence, d.source], ['first.last', 'low', 'default']);

  d = ps.decide(ps.contactEvidence([own('Priya Verma', 'priya@acme.in', { status: 'replied' })], now), prior);
  eq('one reply → high', [d.pattern, d.confidence, d.source], ['first', 'high', 'own']);

  d = ps.decide(ps.contactEvidence([own('Priya Verma', 'priya@acme.in', { status: 'sent', lastSentAt: daysAgo(8) })], now), prior);
  eq('one delivered send → medium', [d.pattern, d.confidence], ['first', 'medium']);

  d = ps.decide(ps.realEvidence([{ name: 'Priya Verma', email: 'pverma@acme.in' }], 'github'), prior);
  eq('one real address → medium, github', [d.pattern, d.confidence, d.source], ['flast', 'medium', 'github']);

  d = ps.decide(ps.realEvidence([
    { name: 'Priya Verma', email: 'pverma@acme.in' },
    { name: 'Anil Mehta', email: 'amehta@acme.in' },
  ], 'website'), prior);
  eq('two real addresses → high', [d.pattern, d.confidence], ['flast', 'high']);

  d = ps.decide(ps.hunterEvidence('first_last'), prior);
  eq('hunter only → medium', [d.pattern, d.confidence, d.source], ['first_last', 'medium', 'hunter']);

  // A reply on first.last, then a hard bounce on first.last: −4 + 2 < 0, so the
  // format is not trusted and the guess falls back to the prior.
  d = ps.decide(ps.contactEvidence([
    own('Priya Verma', 'priya.verma@acme.in', { status: 'replied' }),
    own('Anil Mehta', 'anil.mehta@acme.in', { status: 'bounced', bounceReason: '550 5.1.1 user unknown' }),
  ], now), ['first', 'first.last']);
  eq('more bounces than confirmations → not used', [d.pattern, d.confidence], ['first', 'low']);

  // One bounce doesn't flip a well-confirmed format.
  d = ps.decide(ps.contactEvidence([
    own('Priya Verma', 'priya.verma@acme.in', { status: 'replied' }),
    own('Neha Gupta', 'neha.gupta@acme.in', { status: 'replied' }),
    own('Ravi Rao', 'ravi.rao@acme.in', { status: 'replied' }),
    own('Anil Mehta', 'anil.mehta@acme.in', { status: 'bounced', bounceReason: '550 5.1.1 user unknown' }),
  ], now), prior);
  eq('one bounce does not flip a confirmed format', [d.pattern, d.confidence], ['first.last', 'high']);

  // Ten commits from one source cap at +6; two replies elsewhere (+4) don't lose to
  // them on volume alone, but here they are different formats, so the cap decides.
  const many = Array.from({ length: 10 }, () => ({ name: 'Priya Verma', email: 'pverma@acme.in' }));
  const s = ps.summarize(ps.realEvidence(many, 'github'));
  eq('real evidence capped per source', s[0].score, 6);

  d = ps.decide([
    ...ps.contactEvidence([own('Priya Verma', 'priya.verma@acme.in', { status: 'replied' })], now),
    ...ps.realEvidence([{ name: 'Neha Gupta', email: 'neha@acme.in' }], 'website'),
  ], prior);
  eq('close second format reported as runner-up', [d.pattern, d.runnerUp], ['first.last', 'first']);

  eq('tie broken by prior', ps.decide([
    ...ps.realEvidence([{ name: 'A Bc', email: 'abc@x.in' }], 'github'),
    ...ps.realEvidence([{ name: 'Neha Gupta', email: 'neha@x.in' }], 'github'),
  ], ['first', 'flast']).pattern, 'first');
}

console.log('\npriorOrder');
{
  const ev = ps.contactEvidence([
    { name: 'Priya Verma', email: 'priya@a.in', status: 'replied' },
    { name: 'Neha Gupta', email: 'neha@b.in', status: 'replied' },
    { name: 'Anil Mehta', email: 'anil.mehta@c.in', status: 'sent', lastSentAt: daysAgo(10) },
  ], now);
  const order = ps.priorOrder(ev);
  eq('your most successful format first', order.slice(0, 2), ['first', 'first.last']);
  ok('every format listed', ep.PATTERN_KEYS.every(k => order.includes(k)));
  eq('empty history → fallback order', ps.priorOrder([]).slice(0, 4), ep.FALLBACK_ORDER);

  // One vote per company: twenty delivered sends to one company don't outvote two
  // other companies, and gmail.com addresses don't vote at all.
  const bulk = Array.from({ length: 20 }, (_, n) => ({ name: 'Neha Gupta', email: `neha.gupta${n}@big.in`, status: 'sent', lastSentAt: daysAgo(10) }));
  const votes = ps.priorOrder(ps.contactEvidence([
    ...bulk,
    { name: 'Priya Verma', email: 'priya@a.in', status: 'replied' },
    { name: 'Ravi Rao', email: 'ravi@b.in', status: 'replied' },
    { name: 'Anil Mehta', email: 'anilmehta@gmail.com', status: 'replied' },
    { name: 'Sara Khan', email: 'sarakhan@gmail.com', status: 'replied' },
    { name: 'Om Das', email: 'omdas@gmail.com', status: 'replied' },
  ], now));
  eq('one vote per company, personal mail ignored', votes.slice(0, 2), ['first', 'first.last']);
  // A company whose only evidence is bounces casts no vote.
  eq('bounce-only company casts no vote', ps.priorOrder(ps.contactEvidence([
    { name: 'Anil Mehta', email: 'amehta@z.in', status: 'bounced', bounceReason: '550 5.1.1 user unknown' },
  ], now)).slice(0, 4), ep.FALLBACK_ORDER);
}

// ─────────────────────────────────────────────── search results
console.log('\nparseLinkedInResult');
{
  const co = { companyName: 'Acme Technologies Pvt Ltd', domain: 'acme.in' };
  const r = (title, snippet = '', url = 'https://in.linkedin.com/in/rahul-sharma-123') => parseLinkedInResult({ title, url, snippet }, co);

  eq('name - title - company', r('Rahul Sharma - Engineering Manager - Acme | LinkedIn'),
    { name: 'Rahul Sharma', title: 'Engineering Manager', linkedin: 'https://www.linkedin.com/in/rahul-sharma-123' });
  eq('title at company', r('Rahul Sharma – Engineering Manager at Acme Technologies – LinkedIn')?.title, 'Engineering Manager');
  eq('name - company only', r('Rahul Sharma - Acme | LinkedIn')?.title, '');
  eq('company only in snippet', r('Rahul Sharma - Engineering Manager | LinkedIn', 'Experience: Acme · Bengaluru')?.name, 'Rahul Sharma');
  eq('ex-employee dropped', r('Rahul Sharma - Ex-Acme | Engineering Manager at Zeta | LinkedIn'), null);
  eq('former employee dropped', r('Rahul Sharma - Engineering Manager', 'Formerly at Acme. Now at Zeta.'), null);
  eq('other company dropped', r('Rahul Sharma - Engineering Manager - Zeta | LinkedIn'), null);
  eq('not a profile url', r('Rahul Sharma - Acme | LinkedIn', '', 'https://www.linkedin.com/company/acme'), null);
  eq('company page as name dropped', r('Acme Hiring - Acme | LinkedIn'), null);
  eq('credentials removed from name', r('Priya Verma, PMP - Program Manager - Acme | LinkedIn')?.name, 'Priya Verma');
  eq('normCompany', normCompany('Acme Technologies Pvt. Ltd.'), 'acme');
  ok('role match', matchesRoles('Senior Engineering Manager', ['engineering manager']));
  ok('role mismatch', !matchesRoles('Software Engineer', ['engineering manager']));
}

console.log('\ncompany lookup');
{
  const { resembles, acronym, typedDomain } = require('../lib/discovery/companyLookup');
  ok('name in domain', resembles('zerodha.com', 'Zerodha'));
  ok('product domain kept', resembles('zerodhamoney.com', 'Zerodha'));
  ok('unrelated domain dropped', !resembles('12400wilshire.com', 'Zerodha'));
  ok('another company dropped', !resembles('opentrade.in', 'Zerodha'));
  ok('initials match', resembles('tcs.com', 'Tata Consultancy Services'));
  ok('suffixes ignored', resembles('freshworks.com', 'Freshworks Technologies Pvt Ltd'));
  eq('acronym', acronym('Tata Consultancy Services'), 'tcs');
  eq('typed website', typedDomain('https://www.acme.in/careers'), 'acme.in');
  eq('a name is not a domain', typedDomain('Acme Corp'), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
