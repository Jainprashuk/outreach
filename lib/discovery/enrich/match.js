// Shared by the outside-signal checks: does a piece of text name THIS company?
//
// The risk with free news and forum search is a different company with the same
// name — "Swift" the payments startup vs. Taylor Swift. So a match needs the whole
// name as whole words, and names too short or too ordinary to be told apart are
// skipped outright (the card says so) rather than guessed at.

const { normCompany } = require('../linkedinResult');
const { stripAccents } = require('../../emailPatterns');

// Ordinary words that are also company names; a headline containing one says
// nothing about which company it means.
const COMMON = new Set(`
  orange swift slice jar fresh simple smart open bright blue green red
  alpha beta delta gamma zeta omega nova apex prime core edge spark pulse wave flow loop
  next one first true pure plus max pro go hub lab labs works world global digital cloud
  data tech soft systems solutions services media money pay cash bank capital ventures
  health care life home house space air sky sun star moon light fire stone rock wood
  urban city metro bridge path route square circle box block cube dot line point link
  zest mint mango honey salt pepper ginger juice coffee tea milk
`.split(/\s+/).filter(Boolean));

const norm = (s) => ` ${stripAccents(String(s || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The name to look for, or null when it can't be told apart from other things. */
function matchName(company) {
  const n = normCompany(company || '').trim();
  if (n.replace(/ /g, '').length < 4) return null;
  if (!n.includes(' ') && COMMON.has(n)) return null;
  return n;
}

/** Does `text` contain `name` (from matchName) as whole words? */
const mentions = (text, name) => !!name && norm(text).includes(` ${name} `);

/** Plain text from a bit of HTML or an RSS field. */
function plain(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { matchName, mentions, plain, sleep, COMMON };
