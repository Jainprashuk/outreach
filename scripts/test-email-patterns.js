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
  eq('one reply → high (even first: a reply proves it)', [d.pattern, d.confidence, d.source], ['first', 'high', 'own']);

  d = ps.decide(ps.contactEvidence([own('Priya Verma', 'priya.verma@acme.in', { status: 'sent', lastSentAt: daysAgo(8) })], now), prior);
  eq('one delivered send → medium', [d.pattern, d.confidence], ['first.last', 'medium']);

  d = ps.decide(ps.contactEvidence([own('Priya Verma', 'priya@acme.in', { status: 'sent', lastSentAt: daysAgo(8) })], now), prior);
  eq('first with no reply → low', [d.pattern, d.confidence, d.nameOnly], ['first', 'low', true]);

  // Codilar: "verified by delivery" as first, then 23 of 31 bounced.
  d = ps.decide(ps.contactEvidence([
    ...['Priya Verma', 'Neha Gupta', 'Ravi Rao', 'Om Das', 'Sara Khan'].map(n => own(n, `${n.split(' ')[0].toLowerCase()}@codilar.com`, { status: 'sent', lastSentAt: daysAgo(10) })),
    own('Anil Mehta', 'anil@codilar.com', { status: 'bounced', bounceReason: '550 5.1.1 user unknown' }),
  ], now), prior);
  eq('first "verified by delivery" is not proof', [d.pattern, d.confidence, !!d.verified], ['first', 'low', false]);

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

  // Verified by delivery: a domain that hard-bounces SOME address isn't catch-all, so
  // many delivered sends in one format prove it.
  {
    const names = ['Priya Verma', 'Anil Mehta', 'Neha Gupta', 'Ravi Rao', 'Kiran Shah', 'Asha Nair', 'Rohit Jain'];
    const delivered = (n) => names.slice(0, n).map(x => own(x, x.toLowerCase().replace(' ', '.') + '@acme.in', { status: 'sent', lastSentAt: daysAgo(10) }));
    const bounce = own('Sunil Das', 'sunil.das@acme.in', { status: 'bounced', bounceReason: '550 5.1.1 user unknown' });
    const otherBounce = own('Sunil Das', 'sdas@acme.in', { status: 'bounced', bounceReason: '550 5.1.1 user unknown' });

    d = ps.decide(ps.contactEvidence([...delivered(6)], now), prior);
    eq('delivered only, nothing ever bounced → still medium (could be catch-all)', [d.pattern, d.confidence, !!d.verified], ['first.last', 'medium', false]);

    d = ps.decide(ps.contactEvidence([...delivered(6), otherBounce], now), prior);
    eq('6 delivered + a bounce on another format → high, verified', [d.pattern, d.confidence, d.verified], ['first.last', 'high', true]);

    d = ps.decide(ps.contactEvidence([...delivered(4), otherBounce], now), prior);
    eq('too few delivered → medium', [d.confidence, d.verified], ['medium', false]);

    d = ps.decide(ps.contactEvidence([...delivered(7), bounce], now), prior);
    eq('one of 8 bounced on the same format (12%) → medium', [d.confidence, d.verified], ['medium', false]);

    const many = Array.from({ length: 20 }, (_, i) => own(`Person${String.fromCharCode(97 + i)} Kumar${String.fromCharCode(97 + i)}`,
      `person${String.fromCharCode(97 + i)}.kumar${String.fromCharCode(97 + i)}@acme.in`, { status: 'follow-up-sent', lastSentAt: daysAgo(10) }));
    d = ps.decide(ps.contactEvidence([...many, bounce, otherBounce], now), prior);
    eq('20 delivered, 1 own-format bounce (5%) → high', [d.pattern, d.confidence, d.verified], ['first.last', 'high', true]);
  }

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
  eq('first never leads the default guess (behind first.last)', order.slice(0, 2), ['first.last', 'first']);
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
  eq('one vote per company, personal mail ignored', votes.slice(0, 3), ['first.last', 'first', 'firstlast']);
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

console.log('\nweb format (templates, directories, web addresses)');
{
  const wf = require('../lib/discovery/webFormat');
  eq('[first].[last]', wf.parseTemplate('[first].[last]'), 'first.last');
  eq('{first}.{last}', wf.parseTemplate('{first}.{last}'), 'first.last');
  eq('{f}{last}', wf.parseTemplate('{f}{last}'), 'flast');
  eq('[first_initial][last]', wf.parseTemplate('[first_initial][last]'), 'flast');
  eq('[first initial].[last]', wf.parseTemplate('[first initial].[last]'), 'f.last');
  eq('bare first_last', wf.parseTemplate('first_last'), 'first_last');
  eq('bare firstlast', wf.parseTemplate('firstlast'), 'firstlast');
  eq('bare first', wf.parseTemplate('first'), 'first');
  eq('{first}{l}', wf.parseTemplate('{first}{l}'), 'firstl');
  eq('{last}.{first}', wf.parseTemplate('{last}.{first}'), 'last.first');
  eq('trailing dot ignored', wf.parseTemplate('first.last.'), 'first.last');
  eq('hyphen format not built', wf.parseTemplate('[first]-[last]'), null);
  eq('a word is not a template', wf.parseTemplate('format'), null);
  eq('bare single letter is not a slot', wf.parseTemplate('f.last'), null);
  eq('example jane.doe', wf.fromExample('jane.doe@acme.com'), 'first.last');
  eq('example jsmith', wf.fromExample('jsmith@acme.com'), 'flast');
  eq('real person is not an example', wf.fromExample('rahul.sharma@acme.com'), null);

  const R = (url, title, snippet) => ({ url, title, snippet });
  const dir = wf.directoryFormats([
    R('https://rocketreach.co/acme-email-format_1', 'Acme Email Format | acme.com Emails', 'The most common Acme email format is [first].[last] (ex. jane.doe@acme.com) being used 76.2% of the time. Other: [first] (12%).'),
    R('https://www.leadiq.com/c/acme/emails', 'Acme Email Formats', 'Acme uses {first}.{last}@acme.com for most employees.'),
    R('https://www.signalhire.com/companies/acme/email', 'Acme Corp email format', 'Email format for acme.com: {f}{last}@acme.com 20%, {first}.{last}@acme.com 70%'),
    R('https://rocketreach.co/zeta-email-format_2', 'Zeta Email Format | zeta.tech', 'The most common Zeta email format is [first] (ex. jane@zeta.tech).'),
    R('https://acme.com/contact', 'Contact Acme', 'Write to first.last@acme.com'),
  ], 'acme.com', 'Acme');
  eq('one vote per site, other companies and own site ignored', dir.map(d => [d.site, d.pattern]).sort(),
    [['leadiq.com', 'first.last'], ['rocketreach.co', 'first.last'], ['signalhire.com', 'first.last']]);
  eq('share read', dir.find(d => d.site === 'rocketreach.co').share, 76.2);

  const pairs = wf.webAddresses([
    R('https://x.com/a', 'Speakers', 'Priya Kapoor, Head of Growth at Acme (priya.kapoor@acme.com) will speak.'),
    R('https://x.com/b', 'Press', 'Media: press@acme.com. Contact Rahul Sharma or anil.mehta@acme.com'),
    R('https://x.com/c', 'Team', 'Write to sneha@acme.com'),
  ], 'acme.com', ['Sneha Iyer']);
  eq('web addresses tied to a name', pairs.map(p => [p.name, p.email]),
    [['Priya Kapoor', 'priya.kapoor@acme.com'], ['Sneha Iyer', 'sneha@acme.com']]);

  const e = ps.directoryEvidence([
    { site: 'a.com', pattern: 'first.last' }, { site: 'b.com', pattern: 'first.last' }, { site: 'c.com', pattern: 'first.last' },
    { site: 'a.com', pattern: 'first.last' },
  ]);
  eq('directory capped at two sites', e.map(x => [x.pattern, x.weight, x.sites]), [['first.last', 4, 3]]);
  const d = ps.decide(e, ep.FALLBACK_ORDER);
  eq('directory alone → medium', [d.pattern, d.confidence, d.source], ['first.last', 'medium', 'directory']);
  const withBounce = ps.decide([...e, { pattern: 'first.last', kind: 'hardBounce', weight: -4, source: 'own' }], ep.FALLBACK_ORDER);
  eq('one hard bounce cancels the directories', withBounce.source, 'default');
  const g = ps.decide(ps.realEvidence([{ name: 'Priya Kapoor', email: 'priya.kapoor@acme.com' }, { name: 'Anil Mehta', email: 'anil.mehta@acme.com' }], 'gravatar'));
  eq('two Gravatar hits → high', [g.pattern, g.confidence, g.source], ['first.last', 'high', 'gravatar']);
  const pairsFirst = [{ name: 'Amit Kumar', email: 'amit@postman.com' }, { name: 'Ankit Sobti', email: 'ankit@postman.com' }];
  const gf = ps.decide(ps.realEvidence(pairsFirst, 'gravatar', { guessedOwner: true }));
  eq('first-name-only Gravatar hits alone don\'t pick the format', [gf.source, gf.confidence], ['default', 'low']);
  const gfd = ps.decide([...ps.realEvidence(pairsFirst, 'gravatar', { guessedOwner: true }), ...ps.directoryEvidence([{ site: 'a.com', pattern: 'first' }])]);
  eq('…they add to one format site, still low', [gfd.pattern, gfd.confidence, gfd.score], ['first', 'low', 4]);
  const gfd2 = ps.decide(ps.directoryEvidence([{ site: 'a.com', pattern: 'first' }, { site: 'b.com', pattern: 'first' }]));
  eq('two format sites agreeing on first → medium', [gfd2.pattern, gfd2.confidence], ['first', 'medium']);
  const mixed = ps.decide([...ps.realEvidence(pairsFirst, 'gravatar', { guessedOwner: true }),
    ...ps.realEvidence([{ name: 'Priya Kapoor', email: 'priya.kapoor@postman.com' }, { name: 'Anil Mehta', email: 'anil.mehta@postman.com' }], 'gravatar', { guessedOwner: true })]);
  eq('full-name hits beat first-name-only hits', [mixed.pattern, mixed.confidence], ['first.last', 'high']);
  const gh = ps.decide(ps.realEvidence(pairsFirst, 'github'));
  eq('two known owners (GitHub commits) of first-name addresses → medium, no reply yet', [gh.pattern, gh.confidence], ['first', 'medium']);
}

console.log('\nformat set by you');
{
  const auto = ps.decide([
    { pattern: 'flast', kind: 'reply', weight: 2, source: 'own' },
  ]);
  const m = ps.manualDecision({ pattern: 'first.last', from: 'list' }, auto);
  eq('picked from list → medium, source set', [m.pattern, m.confidence, m.source], ['first.last', 'medium', 'set']);
  eq('a reply in another format warns', [m.conflict, m.conflictWith], ['replies', 'flast']);
  eq('from a real address → high', ps.manualDecision({ pattern: 'first.last', from: 'example' }, ps.decide([])).confidence, 'high');
  const bounced = ps.decide([
    { pattern: 'first.last', kind: 'hardBounce', weight: -4, source: 'own' },
    { pattern: 'first.last', kind: 'hardBounce', weight: -4, source: 'own' },
  ]);
  eq('two bounces in your format warn', ps.manualDecision({ pattern: 'first.last', from: 'list' }, bounced).conflict, 'bounces');
  eq('no evidence, no warning', ps.manualDecision({ pattern: 'first', from: 'list' }, ps.decide([])).conflict, null);
}

console.log('\ntest format (one email)');
{
  const { testStatus, WAIT_MS } = require('../lib/formatTest');
  const t = { email: 'priya.kapoor@acme.com' };
  const sentAt = new Date(now.getTime() - 60 * 60 * 1000);
  const after = new Date(sentAt.getTime() + WAIT_MS + 1000);
  const before = new Date(sentAt.getTime() + 60 * 1000);
  const st = (c, job, check) => testStatus(t, c, job || null, check || null, now).status;
  eq('queued → sending', st({ status: 'queued' }, { status: 'processing', items: [{ status: 'pending' }] }), 'sending');
  eq('held by Gmail limit', st({ status: 'queued' }, { status: 'paused', items: [{ status: 'pending' }] }), 'held');
  eq('skipped by a guard → failed', st({ status: 'queued' }, { status: 'done', items: [{ status: 'skipped', error: 'blocked' }] }), 'failed');
  eq('send failed', st({ status: 'failed', failReason: 'auth' }), 'failed');
  eq('sent, no check yet → waiting', st({ status: 'sent', lastSentAt: sentAt }), 'waiting');
  eq('sent, check too soon → waiting', st({ status: 'sent', lastSentAt: sentAt }, null, before), 'waiting');
  eq('sent, checked 15+ min later → no bounce', st({ status: 'sent', lastSentAt: sentAt }, null, after), 'no-bounce');
  eq('hard bounce', st({ status: 'bounced', lastSentAt: sentAt, bounceReason: '550 5.1.1 user unknown' }), 'bounced');
  eq('mailbox full is not a format answer', st({ status: 'bounced', lastSentAt: sentAt, bounceReason: '552 mailbox full' }), 'bounce-other');
  eq('reply', st({ status: 'replied', lastSentAt: sentAt, repliedAt: now }), 'replied');
  eq('deleted contact', st(null), 'gone');

  const noEvidence = ps.decide([]);
  const m = ps.manualDecision({ pattern: 'first.last', from: 'test' }, noEvidence);
  eq('test with no bounce anywhere → medium, catch-all risk', [m.confidence, m.catchAllRisk], ['medium', true]);
  const rejects = ps.decide(ps.contactEvidence([
    { name: 'Rahul Sharma', email: 'rahul@acme.com', status: 'bounced', bounceReason: '550 5.1.1 user unknown' },
  ], now));
  const m2 = ps.manualDecision({ pattern: 'first.last', from: 'test' }, rejects);
  eq('test after a bounce at the company → high', [m2.confidence, m2.catchAllRisk], ['high', false]);
  const replied = ps.decide(ps.contactEvidence([{ name: 'Priya Kapoor', email: 'priya.kapoor@acme.com', status: 'replied' }], now));
  eq('test that got a reply → high', ps.manualDecision({ pattern: 'first.last', from: 'test' }, replied).confidence, 'high');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
