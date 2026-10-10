// Proves the free outside-signal checks behind "Worth searching"
// (lib/discovery/enrich/*) against saved responses — no network, no database.
// Run with:  node scripts/test-company-enrich.js
//
// The HTTP layer is stubbed BEFORE the checks are loaded (they take fetchText /
// fetchJson at require time), so every case below — including timeouts and 500s —
// is exactly what a check would see from a real service.

const http = require('../lib/http');

let stub = { text: async () => ({ ok: false }), json: async () => ({ ok: false }) };
const calls = [];
http.fetchText = (url, opts) => { calls.push(url); return stub.text(url, opts); };
http.fetchJson = (url, opts) => { calls.push(url); return stub.json(url, opts); };

const { matchName, mentions } = require('../lib/discovery/enrich/match');
const news = require('../lib/discovery/enrich/news');
const hn = require('../lib/discovery/enrich/hn');
const careers = require('../lib/discovery/enrich/careers');
const github = require('../lib/discovery/enrich/github');
const fit = require('../lib/discovery/enrich/fit');
const { fresh } = require('../lib/discovery/enrich');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-11T10:00:00Z');
const daysAgo = (d) => new Date(now.getTime() - d * DAY);
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map(i =>
  `<item><title>${i.title}</title><link>${i.url || 'https://news.example/' + encodeURIComponent(i.title)}</link><pubDate>${(i.at || daysAgo(5)).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const TIMEOUT = { ok: false, status: null, data: null, error: 'Request timed out after 8000ms' };
const ERR500 = { ok: false, status: 500, data: null, error: 'HTTP 500' };

(async () => {
  // ─────────────────────────────────────────── names
  console.log('\nname matching');
  eq('normal name', matchName('Razorpay Software Pvt Ltd'), 'razorpay');
  eq('too short', matchName('Jar'), null);
  eq('common word', matchName('Slice'), null);
  ok('common word inside a longer name is fine', matchName('Slice Payments') !== null);
  ok('whole word only', !mentions('Razorpayments launches', 'razorpay') && mentions('Razorpay raises $100M', 'razorpay'));

  // ─────────────────────────────────────────── news
  console.log('\nnews');
  stub.text = async () => ({ ok: true, data: rss([{ title: 'Razorpay raises $100M in Series F - Economic Times' }]) });
  let r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('funding headline', [r.status, r.points], ['ok', news.POINTS.funding]);
  ok('publisher suffix stripped, link kept', /Funding news: "Razorpay raises \$100M in Series F"/.test(r.reasons[0].text) && !!r.reasons[0].url);

  console.log('  (funding means an event, not a directory page)');
  ok('raises $', news.isFunding('Razorpay raises $100M in Series F'));
  ok('bags crore', news.isFunding('Acme bags ₹50 crore from Peak XV'));
  ok('secures Series B', news.isFunding('Acme secures Series B funding'));
  ok('directory page is not funding', !news.isFunding('Razorpay - 2026 Funding Rounds & List of Investors'));
  ok('a price rise is not funding', !news.isFunding('Zepto raises minimum order value for free delivery to Rs 199 from Rs 149'));
  ok('money from investors is funding', news.isFunding('Acme bags $12 million from Accel'));
  ok('"funding" alone is not funding', !news.isFunding('How Razorpay thinks about funding'));
  console.log('  (the company must be the subject)');
  ok('investor named after "from" is not the raiser', !news.fundingFor('Agentic AI startup Kily raises Rs 30 crore from Sorin, Razorpay, Wyser Capital', 'razorpay'));
  ok('the raiser is', news.fundingFor('Kily raises Rs 30 crore from Sorin, Razorpay', 'kily'));
  ok('roundup: layoffs at another company', !news.layoffsFor('Zepto’s New Game Plan, Layoffs At Zomato & More', 'zepto'));
  ok('"layoffs at X" is about X', news.layoffsFor('Zepto’s New Game Plan, Layoffs At Zomato & More', 'zomato'));
  ok('"X lays off" is about X', news.layoffsFor('Acme lays off 120 employees amid slowdown', 'acme'));
  ok('possessive subject', news.fundingFor('Acme’s parent raises $5M in a seed round', 'acme'));
  stub.text = async () => ({ ok: true, data: rss([{ title: 'Razorpay - 2026 Funding Rounds & List of Investors - Tracxn' }]) });
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('directory headline adds nothing', r.status, 'none');

  stub.text = async () => ({ ok: true, data: rss([{ title: 'Razorpay raises $100M' }, { title: 'Razorpay lays off 150 employees', at: daysAgo(2) }]) });
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('layoffs outrank funding', [r.status, r.points], ['ok', news.POINTS.layoffs]);

  stub.text = async () => ({ ok: true, data: rss([{ title: 'Razorpay raises $100M', at: daysAgo(120) }]) });
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('older than 90 days ignored', r.status, 'none');

  stub.text = async () => ({ ok: true, data: rss([{ title: 'Orbitron Corp raises $5M' }]) });
  r = await news.checkNews({ company: 'Orbit Labs' }, { now });
  eq('unrelated company with a similar name ignored', r.status, 'none');

  calls.length = 0;
  r = await news.checkNews({ company: 'Swift' }, { now });
  eq('ambiguous name skipped', r.status, 'skipped');
  eq('…without any request', calls.length, 0);

  stub.text = async () => TIMEOUT;
  stub.json = async () => ({ ok: true, data: { articles: [{ title: 'Razorpay secures funding', url: 'https://g/1', seendate: '20261005T101500Z' }] } });
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('Google News timeout → GDELT backup', [r.status, r.points, r.reasons[0].url], ['ok', news.POINTS.funding, 'https://g/1']);

  stub.text = async () => TIMEOUT;
  stub.json = async () => ERR500;
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('both down → error, 0 points', [r.status, r.points], ['error', 0]);

  stub.text = async () => ({ ok: true, data: '<html>captcha</html>' });
  stub.json = async () => ERR500;
  r = await news.checkNews({ company: 'Razorpay' }, { now });
  eq('a non-RSS page is not "no news"', r.status, 'error');

  // ─────────────────────────────────────────── HN
  console.log('\nHN Who is hiring');
  const sec = (d) => Math.floor(daysAgo(d).getTime() / 1000);
  const threads = { ok: true, data: { hits: [{ objectID: '111', title: 'Ask HN: Who is hiring? (October 2026)', created_at_i: sec(10) }, { objectID: '99', title: 'Ask HN: Who is hiring? (June 2026)', created_at_i: sec(130) }] } };
  hn._resetCache();
  stub.json = async (url) => (url.includes('search_by_date') ? threads
    : { ok: true, data: { hits: [{ objectID: '5', comment_text: 'Someone at Razorpay told me…' }, { objectID: '7', comment_text: 'Razorpay | Backend Engineer | Bangalore | Onsite' }] } });
  r = await hn.checkHn({ company: 'Razorpay' }, { now });
  eq('own post found (not a mention)', [r.status, r.reasons[0].url], ['ok', 'https://news.ycombinator.com/item?id=7']);
  ok('month in the reason', /October 2026/.test(r.reasons[0].text));
  ok('old thread not searched', !calls.some(u => u.includes('story_99')));

  hn._resetCache();
  stub.json = async (url) => (url.includes('search_by_date') ? threads : { ok: true, data: { hits: [{ objectID: '5', comment_text: 'Acme | ex-Razorpay folks welcome' }] } });
  r = await hn.checkHn({ company: 'Razorpay' }, { now });
  eq('another company\'s post mentioning the name ignored', r.status, 'none');

  hn._resetCache();
  stub.json = async (url) => (url.includes('search_by_date') ? threads : { ok: true, data: { hits: [{ objectID: '9', comment_text: 'RP (razorpay.com) | SDE-2 | Bangalore' }] } });
  r = await hn.checkHn({ company: 'Razorpay', domain: 'razorpay.com' }, { now });
  eq('post naming the domain counts', r.status, 'ok');

  hn._resetCache();
  stub.json = async () => TIMEOUT;
  r = await hn.checkHn({ company: 'Razorpay' }, { now });
  eq('HN down → error', [r.status, r.points], ['error', 0]);

  // ─────────────────────────────────────────── careers
  console.log('\ncareers page');
  eq('greenhouse link', careers.findBoard(['<a href="https://boards.greenhouse.io/acme/jobs/1">']), { source: 'greenhouse', token: 'acme' });
  eq('lever link', careers.findBoard(['<iframe src="https://jobs.lever.co/acme-in">']), { source: 'lever', token: 'acme-in' });
  eq('workable link', careers.findBoard(['https://apply.workable.com/acme/']), { source: 'workable', token: 'acme' });
  eq('no board', careers.findBoard(['<p>email careers@acme.in</p>']), null);
  eq('match by family', careers.matching(['Senior Backend Engineer', 'Sales Head'], { families: ['engineering'] }), ['Senior Backend Engineer']);
  eq('match by keyword', careers.matching(['Node.js Developer', 'Sales Head'], { terms: ['node.js'] }), ['Node.js Developer']);
  eq('no targets → every role', careers.matching(['A', 'B']).length, 2);

  stub.text = async (url) => (url === 'https://acme.in/' ? { ok: true, data: '<a href="https://apply.workable.com/acme/">Jobs</a>' } : { ok: false, status: 404 });
  stub.json = async () => ({ ok: true, data: { jobs: [{ title: 'Backend Engineer' }, { title: 'Accountant' }] } });
  r = await careers.checkCareers({ company: 'Acme', domain: 'acme.in' }, { families: ['engineering'], terms: [] });
  eq('roles like yours', [r.status, r.points], ['ok', careers.POINTS]);
  ok('reason names one', /Backend Engineer/.test(r.reasons[0].text));

  r = await careers.checkCareers({ company: 'Acme', domain: 'acme.in' }, { families: [], terms: [] });
  eq('no targets set → open roles count for less', [r.status, r.points], ['ok', careers.POINTS_ANY]);

  stub.json = async () => ({ ok: true, data: { jobs: [{ title: 'Accountant' }] } });
  r = await careers.checkCareers({ company: 'Acme', domain: 'acme.in' }, { families: ['engineering'], terms: [] });
  eq('open roles, none like yours', r.status, 'none');

  stub.json = async () => ERR500;
  r = await careers.checkCareers({ company: 'Acme', domain: 'acme.in' }, { families: ['engineering'], terms: [] });
  eq('board down → error', [r.status, r.points], ['error', 0]);

  stub.text = async () => TIMEOUT;
  r = await careers.checkCareers({ company: 'Acme', domain: 'acme.in' }, {});
  eq('website unreachable → error', r.status, 'error');
  r = await careers.checkCareers({ company: 'Acme', domain: null }, {});
  eq('no domain → skipped', r.status, 'skipped');

  // ─────────────────────────────────────────── GitHub
  console.log('\nGitHub');
  eq('last push ignores forks/archived', github.lastPush([{ pushed_at: '2026-10-01T00:00:00Z' }, { pushed_at: '2026-10-09T00:00:00Z', fork: true }]).toISOString(), '2026-10-01T00:00:00.000Z');
  stub.json = async (url) => (url.includes('/orgs/acme/repos') ? { ok: true, data: [{ pushed_at: daysAgo(3).toISOString() }] }
    : url.endsWith('/orgs/acme') ? { ok: true, data: { login: 'acme', blog: 'https://acme.in' } } : { ok: false, status: 404 });
  r = await github.checkGithub({ company: 'Acme', domain: 'acme.in' }, { now });
  eq('active org that points at the domain', [r.status, r.points], ['ok', github.POINTS]);

  stub.json = async (url) => (url.endsWith('/orgs/acme') ? { ok: true, data: { login: 'acme', blog: 'https://someone-else.com' } }
    : url.includes('/repos') ? { ok: true, data: [{ pushed_at: daysAgo(1).toISOString() }] } : { ok: false, status: 404 });
  r = await github.checkGithub({ company: 'Acme', domain: 'acme.in' }, { now });
  eq('a same-named stranger\'s org adds nothing', r.status, 'none');

  stub.json = async (url) => (url.includes('/repos') ? { ok: true, data: [{ pushed_at: daysAgo(90).toISOString() }] } : { ok: false });
  r = await github.checkGithub({ company: 'Acme', domain: 'acme.in' }, { knownOrg: 'acme', now });
  eq('known org, but quiet', r.status, 'none');

  stub.json = async () => ({ ok: false, status: 403, error: 'rate limit' });
  r = await github.checkGithub({ company: 'Acme', domain: 'acme.in' }, { now });
  eq('rate limited → error', [r.status, r.points], ['error', 0]);

  // ─────────────────────────────────────────── fit
  console.log('\nfit');
  eq('meta description', fit.describe('<title>Acme</title><meta name="description" content="Payments infrastructure for Indian businesses">'), 'Payments infrastructure for Indian businesses — Acme');
  eq('parse answer', fit.parseFit('Sure! {"score": 2, "reason": "A fintech that hires backend engineers."}'), { score: 2, reason: 'A fintech that hires backend engineers.' });
  eq('out-of-range score rejected', fit.parseFit('{"score": 7}'), null);
  eq('negative score rejected', fit.parseFit('{"score": -2}'), null);
  eq('garbage rejected', fit.parseFit('no idea'), null);
  r = await fit.checkFit({ company: 'Acme', domain: 'acme.in' }, { targets: [] });
  eq('no targets → skipped', r.status, 'skipped');

  // ─────────────────────────────────────────── cache freshness
  console.log('\ncache');
  ok('fresh news', fresh({ status: 'ok', checkedAt: new Date(Date.now() - 2 * DAY) }, 'news'));
  ok('stale news', !fresh({ status: 'ok', checkedAt: new Date(Date.now() - 8 * DAY) }, 'news'));
  ok('an error is retried the next day', !fresh({ status: 'error', checkedAt: new Date(Date.now() - 2 * DAY) }, 'github'));
  ok('nothing cached', !fresh(null, 'news'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
