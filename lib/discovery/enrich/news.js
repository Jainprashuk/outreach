// Funding and layoff news from the last 90 days — the strongest outside hint that a
// company is (or isn't) about to hire. Google News RSS first, GDELT if that fails;
// both are free and need no key.
//
// Only a headline that names the company counts, and every reason links to its
// article so you can check it yourself. Layoffs outrank funding: a company that
// raised money and then cut staff is not one to chase this month.

const { fetchText, fetchJson } = require('../../http');
const { matchName, mentions, plain } = require('./match');

const WINDOW_MS = 90 * 24 * 3600 * 1000;
const POINTS = { funding: 3, layoffs: -4 };

// A funding EVENT: a verb plus money or a round ("raises $10M", "secures Series B",
// "bags ₹50 crore"). The word "funding" alone also matches directory pages like
// "Acme - Funding Rounds & List of Investors", which say nothing about this month.
const FUNDING_VERB = /\b(raises?|raised|raising|secures?|secured|bags?|bagged|closes?|closed|lands?|landed|gets?|announces?|nets?|picks up|scoops?)\b/i;
// Money alone isn't funding ("raises minimum order value to Rs 199"): it needs a
// funding word, or money that came FROM someone ("bags ₹50 crore from Peak XV").
const FUNDING_WORD = /\b(series [a-f]|seed|pre-seed|pre-series|funding|fundraise|investment|round|investors?|backed)\b/i;
const MONEY_FROM = /(\$|₹|\brs\.?\s?\d|\b(inr|usd)\b|\b\d+(\.\d+)?\s?(m|mn|million|bn|billion|cr|crore|lakh)\b)[^,;]*\b(from|led by|in a round)\b/i;
const NOT_FUNDING = /\b(prices?|fees?|minimum order|order value|interest rates?|tariffs?|salar(y|ies)|bar|concerns?|questions?|awareness|stake in)\b/i;
const DIRECTORY = /\b(funding rounds?\s*(&|and)\s*|list of investors|investors list|company profile|competitors|valuation history|cap table)\b/i;
const isFunding = (t) => FUNDING_VERB.test(t) && (FUNDING_WORD.test(t) || MONEY_FROM.test(t)) && !DIRECTORY.test(t) && !NOT_FUNDING.test(t);

// Headlines name other companies too — "Kily raises Rs 30 crore from Sorin, Razorpay"
// is not Razorpay raising, and "Zepto's plan, layoffs at Zomato" is not Zepto cutting
// staff. So the company must be the SUBJECT: in the same clause as the news, before
// its verb ("Acme raises…", "Acme lays off…"), or right after "at/in" for layoffs
// ("Layoffs at Acme").
const clauses = (title) => String(title || '').split(/\s*(?:[,;:|–—]|\s-\s|\s&\s|\sand\s)\s*/i).filter(Boolean);
const normText = (t) => ` ${String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

function aboutCompany(title, name, verbRe, { after = false } = {}) {
  for (const cl of clauses(title)) {
    if (!mentions(cl, name)) continue;
    const text = normText(cl);
    const at = text.indexOf(` ${name} `);
    const m = text.match(new RegExp(verbRe.source, 'i'));
    if (!m) continue;
    if (at < m.index) return true;
    if (after && new RegExp(`\\b(at|in) ${name} `).test(text)) return true;
  }
  return false;
}
const fundingFor = (t, name) => isFunding(t) && aboutCompany(t, name, FUNDING_VERB);
const layoffsFor = (t, name) => LAYOFFS.test(t) && aboutCompany(t, name, LAYOFFS, { after: true });
const LAYOFFS = /\b(lay ?offs?|lays off|laid off|job cuts|cuts? \d+ (jobs|employees|staff)|hiring freeze|retrench\w*|downsiz\w*|fires? \d+)\b/i;

/** Google News titles end in " - Publisher". */
const headline = (t) => plain(t).replace(/\s+-\s+[^-]{2,60}$/, '');

/** Pure: the RSS feed's items. */
function parseRss(xml) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    items.push({ title: headline(get('title')), url: plain(get('link')), at: new Date(plain(get('pubDate'))) });
  }
  return items;
}

/** Pure: GDELT's article list. seendate looks like 20261003T101500Z. */
function parseGdelt(data) {
  const rows = (data && Array.isArray(data.articles)) ? data.articles : [];
  return rows.map(a => {
    const s = String(a.seendate || '');
    const iso = s.length >= 15 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : '';
    return { title: plain(a.title), url: String(a.url || ''), at: new Date(iso) };
  });
}

/** Pure: from articles to a signal. */
function judge(articles, name, now = new Date()) {
  const recent = articles.filter(a => a.title && mentions(a.title, name) && a.at instanceof Date && !Number.isNaN(a.at.getTime()) && now - a.at <= WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  const layoff = recent.find(a => layoffsFor(a.title, name));
  if (layoff) return { status: 'ok', points: POINTS.layoffs, reasons: [{ text: `Layoffs reported: "${layoff.title}"`, url: layoff.url }] };
  const funding = recent.find(a => fundingFor(a.title, name));
  if (funding) return { status: 'ok', points: POINTS.funding, reasons: [{ text: `Funding news: "${funding.title}"`, url: funding.url }] };
  return { status: 'none', points: 0, reasons: [], note: 'No funding or layoff news in 90 days' };
}

const QUERY = (name) => `"${name}" (funding OR raises OR "series a" OR "series b" OR layoffs OR "lays off")`;

/**
 * @param {{company: string}} c
 * @returns {Promise<{status: string, points: number, reasons: object[], note?: string}>}
 */
async function checkNews(c, { signal, now = new Date() } = {}) {
  const name = matchName(c.company);
  if (!name) return { status: 'skipped', points: 0, reasons: [], note: 'News check skipped: name too common to search' };

  const rss = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(QUERY(name) + ' when:90d')}&hl=en-IN&gl=IN&ceid=IN:en`,
    { timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024, signal });
  if (rss.ok && /<rss|<channel/i.test(rss.data || '')) return judge(parseRss(rss.data), name, now);

  const g = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(QUERY(name))}&mode=artlist&format=json&maxrecords=50&timespan=90d`,
    { timeoutMs: 10_000, retries: 0, maxBytes: 2 * 1024 * 1024, signal });
  if (g.ok) return judge(parseGdelt(g.data), name, now);
  return { status: 'error', points: 0, reasons: [], note: 'News check unavailable' };
}

module.exports = { checkNews, parseRss, parseGdelt, judge, isFunding, fundingFor, layoffsFor, POINTS };
