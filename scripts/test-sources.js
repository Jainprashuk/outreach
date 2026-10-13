#!/usr/bin/env node
// Tests for the Leads sources (lib/sources/): email reading, paste chunking, the fit
// score, the AI-answer guard, HN parsing, hiring-post queries, and the lead shape
// that goes into importLeads. Pure — no network, no database.
//
//   node scripts/test-sources.js

const { extractEmails, extractLinks, isCompanyEmail } = require('../lib/sources/emails');
const { splitChunks, emailChunks } = require('../lib/sources/paste');
const { scoreItem, placeOf, roleHit, REJECT } = require('../lib/sources/sourceFit');
const { toReadings } = require('../lib/sources/readPosts');
const { toSourceLead, companyFromEmails } = require('../lib/sources/toSourceLeads');
const { parseHeader, hnText, postsToLeads } = require('../lib/sources/hn');
const { buildPostQueries } = require('../lib/sources/webPosts');
const { explodeLead, dedupeKeyFor } = require('../lib/leadImport');

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n      got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

const TARGET = { roles: ['react developer', 'frontend'], locations: ['india', 'remote'], maxYears: 4 };
const NOW = new Date('2026-10-13T10:00:00Z');

// ── emails
eq(extractEmails('Share CV at HR@Acme.in.'), ['hr@acme.in'], 'plain email, lowercased, trailing dot');
eq(extractEmails('mail jobs [at] acme [dot] co [dot] in'), ['jobs@acme.co.in'], 'disguised [at] [dot], two-part tld');
eq(extractEmails('reach me: priya (at) startup (dot) io'), ['priya@startup.io'], 'disguised (at) (dot)');
eq(extractEmails('I work at Acme. In case you want'), [], 'prose "at Acme." is not an email');
eq(extractEmails('logo@2x.png and a@b.com a@b.com'), ['a@b.com'], 'image name dropped, duplicates dropped');
eq(extractEmails('noreply@acme.com, hr@example.com, real@acme.com'), ['real@acme.com'], 'noreply / example dropped');
ok(isCompanyEmail('hr@acme.in') && !isCompanyEmail('x@gmail.com'), 'company vs free mail');
eq(extractEmails('Mail your resumescareers@sweken.com now'), ['careers@sweken.com'], 'glued "resume"+mailbox split back');
eq(extractEmails('write to resume.team@acme.com'), ['resume.team@acme.com'], 'a real address starting with resume is kept');
eq(extractLinks('apply https://acme.in/jobs/1). or linkedin.com/feed x https://www.linkedin.com/in/someone'), ['https://acme.in/jobs/1'], 'links: trailing paren trimmed, LinkedIn chrome dropped');

// ── paste chunking
const wa = [
  '[12/10/26, 9:41 PM] Ravi: Hiring React developer at Acme, Bangalore.',
  'Share CV at hr@acme.in',
  '[12/10/26, 9:45 PM] Neha: thanks!',
  '[12/10/26, 9:50 PM] Ravi: Another one: frontend role, mail jobs@beta.io',
  '[12/10/26, 9:52 PM] Amit: ok',
].join('\n');
const waChunks = splitChunks(wa);
eq(waChunks.length, 4, 'WhatsApp: one chunk per message');
ok(waChunks[0].startsWith('Ravi: Hiring') && waChunks[0].includes('hr@acme.in'), 'WhatsApp: continuation line stays with its message, timestamp stripped');
eq(emailChunks(wa).map(c => c.emails), [['hr@acme.in'], ['jobs@beta.io']], 'only chunks with an email are kept');
eq(splitChunks('Post one hr@a.com\n\nPost two\nstill two\n\n\nthree').length, 3, 'plain text splits on blank lines');
const long = `${'x '.repeat(2000)} mail hr@far.com ${'y '.repeat(2000)}`;
const lc = emailChunks(long)[0];
ok(lc.text.length <= 1500 && lc.text.includes('hr@far.com'), 'a long chunk is cut around its email');

// ── location + fit
eq(placeOf('Office in Bengaluru', { locations: ['india'] }), 'wanted', 'India city counts for "india"');
eq(placeOf('REMOTE | US only', { locations: ['india', 'remote'] }), 'abroad', 'remote but US only is abroad');
eq(placeOf('Remote (EU)', { locations: ['remote'] }), 'abroad', 'remote limited to EU is abroad');
eq(placeOf('Fully remote, worldwide', { locations: ['remote'] }), 'global', 'remote anywhere');
eq(placeOf('Remote', { locations: ['remote'] }), 'remote', 'bare remote');
eq(placeOf('Berlin, Germany / REMOTE (CET ±3 preferred)', { locations: ['india', 'remote'] }), 'abroad', 'remote tied to a European timezone is abroad');
eq(placeOf('London, UK · ONSITE+PART REMOTE', { locations: ['india', 'remote'] }), 'abroad', 'London part-remote is abroad');
eq(placeOf('We are hiring!', { locations: ['india'] }), 'unknown', 'silence is not abroad');
eq(placeOf('West Lafayette, IN · ONSITE, Indiana', { locations: ['india'] }), 'unknown', '"Indiana" is not India');
eq(placeOf('Office in Pune', { locations: ['pune'] }), 'wanted', 'a typed city matches as a word');

const good = scoreItem({ text: 'We are hiring a React developer in Pune. Share your resume at hr@acme.in', emails: ['hr@acme.in'] }, TARGET, NOW);
ok(good.score >= 6 && good.hiring, `good post scores high (${good.score})`);
ok(scoreItem({ text: 'Hiring React.js Developers, mail a@acme.in', emails: ['a@acme.in'] }, TARGET, NOW).reasons.some(r => r.includes('react developer')), '"React.js Developers" matches "react developer"');
eq(scoreItem({ text: "I'm actively looking for a new job as React developer, my mail a@gmail.com", emails: ['a@gmail.com'] }, TARGET, NOW).score, REJECT, 'seeker rejected');
eq(scoreItem({ text: 'Happy Diwali everyone a@acme.in', emails: ['a@acme.in'] }, TARGET, NOW).score, REJECT, 'not hiring rejected');
eq(scoreItem({ text: 'Hiring React dev, onsite in San Francisco, mail a@acme.com', emails: ['a@acme.com'] }, TARGET, NOW).score, REJECT, 'abroad rejected');
eq(scoreItem({ text: 'Hiring frontend, share CV', minYears: 8, emails: [] }, TARGET, NOW).score, REJECT, 'too many years rejected');
eq(scoreItem({ text: 'Hiring! share CV a@x.in', role: 'Front-End Sales – Data Center', emails: ['a@x.in'] }, TARGET, NOW).score, REJECT, 'excluded kind of role (sales) rejected');
eq(scoreItem({ text: 'Hiring! a@x.in', role: 'Business Development Manager (Freelance)', emails: ['a@x.in'] }, TARGET, NOW).score, REJECT, 'business development rejected');
eq(scoreItem({ text: 'Hiring frontend, a@x.in', role: 'Senior Frontend Engineer', emails: ['a@x.in'] }, TARGET, NOW).score, REJECT, 'senior title rejected at 4 years');
ok(scoreItem({ text: 'Hiring frontend, a@x.in', role: 'Senior Frontend Engineer', emails: ['a@x.in'] }, { ...TARGET, maxYears: 8 }, NOW).score > 0, 'senior title fine at 8 years');
ok(scoreItem({ text: 'Hiring frontend, a@x.in', role: 'Frontend Engineer', emails: ['a@x.in'] }, TARGET, NOW).score > 0, 'plain title fine at 4 years');
ok(scoreItem({ text: 'Hiring frontend engineer to work with our sales team, mail a@x.in', role: 'Frontend Engineer', emails: ['a@x.in'] }, TARGET, NOW).score > 0, 'sales mentioned in the text only is fine');
eq(scoreItem({ text: 'blah', hiring: true, isSeeker: false, emails: [] }, TARGET, NOW).hiring, true, 'AI reading overrides the text rules');

eq(roleHit('Senior Full-Stack Engineer (Node.JS)', ['full stack']), 'full stack', 'role: hyphen variant');
eq(roleHit('Fullstack dev', ['full stack']), 'full stack', 'role: joined variant');
eq(roleHit('Front-end engineer', ['frontend']), 'frontend', 'role: front-end ~ frontend');
eq(roleHit('Backend engineer', ['frontend']), null, 'role: no false match');

// ── AI answer guard
const texts = ['Acme Labs is hiring, mail hr@acme.in', 'Hiring now, a@b.com'];
const readings = toReadings({ posts: [
  { n: 1, hiring: true, company: 'Acme Labs', role: 'SDE', minYears: 2 },
  { n: 2, hiring: true, company: 'Google', role: 'SWE', minYears: 99 },
  { n: 7, company: 'Ghost' },
] }, texts);
eq(readings[0].company, 'Acme Labs', 'company in the text is kept');
eq(readings[1].company, '', 'company NOT in the text is blanked');
eq(readings[1].minYears, null, 'absurd years ignored');
eq(toReadings(null, texts), [null, null], 'unreadable answer → no readings');
eq(toReadings({ posts: [{ n: 1, company: 'acme labs' }] }, texts)[0].company, 'Acme Labs', 'lowercase company gets capitals');
eq(toReadings({ posts: [{ n: 1, location: 'undefined', role: 'N/A' }] }, texts)[0].location, '', 'placeholder location dropped');

// ── lead shape
const a = toSourceLead({ source: 'paste', text: 'Hiring React developer, mail hr@acme.in' }, TARGET, NOW);
const b = toSourceLead({ source: 'paste', text: 'Hiring React developer, apply https://acme.in/jobs' }, TARGET, NOW);
const c = toSourceLead({ source: 'paste', text: 'Hiring frontend, apply https://beta.io/jobs' }, TARGET, NOW);
eq(a.emails, ['hr@acme.in'], 'lead: emails from the text');
eq(a.company, 'Acme', 'lead: company from the email domain when nothing else');
ok(b.author_url && c.author_url && b.author_url !== c.author_url, 'lead: every lead has its own author_url');
const keys = [b, c].flatMap(explodeLead).map(dedupeKeyFor);
ok(new Set(keys).size === 2 && keys.every(k => k.startsWith('a:')), 'email-less leads do NOT collapse into one row');
eq(companyFromEmails(['x@gmail.com', 'y@careers.beta-labs.io']), 'Beta Labs', 'company skips free mail, tidies the domain');

// ── explodeLead: new fields only for the new sources
const rich = explodeLead({ ...a, posted_at: '2026-10-12T00:00:00Z' })[0];
ok(rich.snippet && rich.role === '' && rich.postedAt instanceof Date, 'paste row keeps snippet + postedAt');
const harvested = explodeLead({ author_name: 'Ravi', emails: ['r@x.in'], snippet: 'text', location: 'Pune', role: 'SDE', source: 'scroll' })[0];
ok(!('snippet' in harvested) && !('location' in harvested) && harvested.role === '', 'harvester row unchanged (no snippet/location/role)');

// ── HN
const head = parseHeader('Acme (YC W24) | Senior Frontend Engineer | Bangalore, India | ONSITE | $40k\n\nMore text');
eq(head, { company: 'Acme', role: 'Senior Frontend Engineer', location: 'Bangalore, India · ONSITE' }, 'HN header parsed');
eq(parseHeader('We are a team of 10 building things').company, '', 'no header → no company');
eq(parseHeader('Senior Python Backend Engineer | REMOTE (EMEA/APAC) | Full-time'), { company: '', role: 'Senior Python Backend Engineer', location: 'REMOTE (EMEA/APAC)' }, 'title-first header: role, not company');
const ht = hnText('Acme | Frontend | REMOTE<p>Email jobs&#x40;acme.io or <a href="https:&#x2F;&#x2F;acme.io&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;acme.io&#x2F;jobs</a>');
ok(ht.text.startsWith('Acme | Frontend | REMOTE\n\nEmail jobs@acme.io') && ht.hrefs[0] === 'https://acme.io/jobs', 'HN html → text with paragraphs, hrefs decoded');
const posts = [
  { id: '1', author: 'x', createdAt: '2026-10-01T00:00:00Z', html: 'Acme | Frontend Engineer | Remote (worldwide)<p>React. Email hiring@acme.io' },
  { id: '2', author: 'y', createdAt: '2026-10-01T00:00:00Z', html: 'Beta | Frontend Engineer | San Francisco | ONSITE<p>jobs@beta.com' },
  { id: '3', author: 'z', createdAt: '2026-10-01T00:00:00Z', html: 'Gamma | Backend Engineer | Remote<p>Go, Postgres. gamma.io/jobs' },
  { id: '5', author: 'v', createdAt: '2026-10-01T00:00:00Z', html: 'Eps | Frontend Engineer | NYC or Remote<p>jobs@eps.com' },
  { id: '4', author: 'w', createdAt: '2026-10-01T00:00:00Z', html: 'Delta | Frontend | Bengaluru, India<p>Apply at https://delta.in/careers' },
];
const hnOut = postsToLeads(posts, TARGET, NOW);
eq(hnOut.leads.map(l => l.company), ['Acme', 'Delta'], 'HN: keeps remote-anywhere + India, drops SF onsite and wrong role');
eq(hnOut.rejected, 3, 'HN: rejects counted (bare "Remote" on HN is not enough)');
eq(hnOut.leads[0].author_url, 'https://news.ycombinator.com/item?id=1', 'HN: author_url is the comment');
eq(hnOut.leads[1].emails, [], 'HN: apply-link-only post kept with no email');

// ── hiring-post queries
const q1 = buildPostQueries(TARGET, 4, 0);
const q2 = buildPostQueries(TARGET, 4, 1);
eq(q1.length, 4, 'queries: perDay respected');
ok(q1.every(q => q.includes('india')) && !q1.some(q => q.includes('remote')), 'queries: first real place used, not "remote"');
ok(q1.join() !== q2.join(), 'queries rotate by day');
eq(buildPostQueries({ roles: [] }, 6), [], 'no roles → no queries');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
