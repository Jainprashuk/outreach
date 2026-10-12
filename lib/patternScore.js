// Decides which email format a company uses, and how sure we are. Pure — the
// database reads live in lib/patternFinder.js — so every weight below is proven by
// scripts/test-email-patterns.js.
//
// Evidence is a flat list of { pattern, kind, weight, source }. Your own outreach
// history is the strongest kind: a reply proves the address reached a person. A
// delivered send is half of that, because a catch-all domain accepts everything and
// so never bounces. A hard bounce counts double a reply against the format — one
// wrong format is a burst of bounces on your Gmail, the costliest mistake here.

const { inferPattern, FALLBACK_ORDER, PATTERN_KEYS, domainOfEmail, isFreeMail } = require('./emailPatterns');

const WEIGHTS = { reply: 2, delivered: 1, hardBounce: -4, real: 2, hunter: 2, directory: 2, weak: 1 };
// Email-format directory sites (RocketReach and the like) are one claim each, not proof:
// at most two of them count, so one hard bounce in that format cancels them all.
const DIRECTORY_MAX_SITES = 2;
// A single source can't win on volume alone: ten commits from one prolific engineer
// are not ten independent confirmations.
const REAL_CAP_PER_SOURCE = 6;
const DELIVERED_AFTER_MS = 5 * 24 * 3600 * 1000;
// "Verified by delivery" — see verifiedByDelivery().
const VERIFY = { minDomainBounces: 1, minDelivered: 5, maxBounceShare: 0.1 };

// Bounces that say THE ADDRESS does not exist. Mailbox-full, spam and policy
// rejections (5.7.x) say nothing about the format, so they don't count against it.
const HARD_BOUNCE = /5\.1\.1|5\.1\.0|5\.1\.10|user unknown|unknown user|no such user|does not exist|doesn't exist|address not found|recipient rejected|recipient address rejected|mailbox unavailable|invalid recipient|no mailbox|unknown recipient|account (?:has been )?disabled/i;

const REPLIED_STATUSES = new Set(['replied', 'follow-up-replied']);

/** What one of your contacts says about its own address, or null for nothing. */
function contactSignal(c, now = new Date()) {
  const replied = !!c.repliedAt
    || REPLIED_STATUSES.has(c.status)
    || (c.thread || []).some(t => t && t.direction === 'inbound');
  if (replied) return { kind: 'reply', weight: WEIGHTS.reply };
  if (c.status === 'bounced') {
    return HARD_BOUNCE.test(c.bounceReason || '') ? { kind: 'hardBounce', weight: WEIGHTS.hardBounce } : null;
  }
  if (c.status === 'failed' || c.status === 'blocked') return null;
  if (c.lastSentAt && now - new Date(c.lastSentAt) >= DELIVERED_AFTER_MS) {
    return { kind: 'delivered', weight: WEIGHTS.delivered };
  }
  return null;
}

/** Evidence from your own contacts. Contacts whose format can't be read are skipped. */
function contactEvidence(contacts, now = new Date()) {
  const out = [];
  for (const c of contacts) {
    const signal = contactSignal(c, now);
    if (!signal) continue;
    const pattern = inferPattern(c.name, c.email);
    if (!pattern) continue;
    out.push({ pattern, ...signal, source: 'own', domain: domainOfEmail(c.email) });
  }
  return out;
}

// Formats that hold no surname. When the address was only GUESSED to be this person's
// (Gravatar, a name near it on the web), rahul@ existing proves just that some Rahul
// has it — usually a founder or an early hire, while later staff get a full-name
// format (seen at postman.com: amit@ and ankit@ exist). Such a hit is a weak sign.
const NAME_ONLY = new Set(['first']);

/**
 * Evidence from real addresses seen elsewhere: [{ name, email }] → +2 each.
 * With `guessedOwner`, a name-only address is a weak sign (+1, never proof).
 */
function realEvidence(pairs, source, { guessedOwner = false } = {}) {
  const out = [];
  for (const p of pairs) {
    const pattern = inferPattern(p.name, p.email);
    if (!pattern) continue;
    if (guessedOwner && NAME_ONLY.has(pattern)) out.push({ pattern, kind: 'weak', weight: WEIGHTS.weak, source });
    else out.push({ pattern, kind: 'real', weight: WEIGHTS.real, source });
  }
  return out;
}

function hunterEvidence(pattern) {
  return pattern ? [{ pattern, kind: 'hunter', weight: WEIGHTS.hunter, source: 'hunter' }] : [];
}

/**
 * What directory sites say: [{ site, pattern }] → one item per format, worth two points
 * per agreeing site up to DIRECTORY_MAX_SITES. Never 'real', so on its own it reaches
 * medium at most.
 */
function directoryEvidence(list) {
  const sites = new Map();
  for (const d of list || []) {
    if (!d || !d.pattern || !d.site) continue;
    if (!sites.has(d.pattern)) sites.set(d.pattern, new Set());
    sites.get(d.pattern).add(d.site);
  }
  return [...sites.entries()].map(([pattern, set]) => ({
    pattern, kind: 'directory', source: 'directory', sites: set.size,
    weight: WEIGHTS.directory * Math.min(set.size, DIRECTORY_MAX_SITES),
  }));
}

/** Per-pattern totals, with real-address evidence capped per source. */
function summarize(evidence) {
  const by = new Map();
  const realBySource = new Map();
  for (const e of evidence) {
    if (!PATTERN_KEYS.includes(e.pattern)) continue;
    let s = by.get(e.pattern);
    if (!s) {
      s = { pattern: e.pattern, score: 0, replies: 0, delivered: 0, hardBounces: 0, real: 0, weak: 0, hunter: false, directory: 0, sources: {} };
      by.set(e.pattern, s);
    }
    let weight = e.weight;
    if (e.kind === 'real') {
      const k = `${e.pattern}|${e.source}`;
      const used = realBySource.get(k) || 0;
      weight = Math.max(0, Math.min(weight, REAL_CAP_PER_SOURCE - used));
      realBySource.set(k, used + weight);
      s.real++;
    }
    if (e.kind === 'reply') s.replies++;
    if (e.kind === 'delivered') s.delivered++;
    if (e.kind === 'hardBounce') s.hardBounces++;
    if (e.kind === 'hunter') s.hunter = true;
    if (e.kind === 'directory') s.directory += e.sites || 1;
    if (e.kind === 'weak') s.weak++;
    s.score += weight;
    s.sources[e.source] = (s.sources[e.source] || 0) + weight;
  }
  return [...by.values()];
}

/**
 * The formats ranked by how many of YOUR companies use them — the default guess for a
 * company with no evidence of its own. One vote per company (its own best format), so
 * a big bulk send to one company can't outvote a hundred companies, and a pile of
 * bounces on one format can't push personal-mail addresses to the top. Personal-mail
 * domains (gmail.com …) say nothing about how companies name addresses, and are
 * skipped. Always lists every format.
 */
function priorOrder(evidence) {
  const byDomain = new Map();
  for (const e of evidence) {
    if (!e.domain || isFreeMail(e.domain)) continue;
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain).push(e);
  }
  const votes = new Map();
  for (const list of byDomain.values()) {
    const best = summarize(list).filter(s => s.score > 0).sort((a, b) => b.score - a.score)[0];
    if (best) votes.set(best.pattern, (votes.get(best.pattern) || 0) + 1);
  }
  const fallback = (p) => { const i = FALLBACK_ORDER.indexOf(p); return i === -1 ? 99 : i; };
  const order = [...votes.entries()]
    .sort((a, b) => (b[1] - a[1]) || (fallback(a[0]) - fallback(b[0])))
    .map(([p]) => p);
  for (const p of [...FALLBACK_ORDER, ...PATTERN_KEYS]) if (!order.includes(p)) order.push(p);
  // Never default to a name-only format: on prod every default "first" guess (42 of 42)
  // hard-bounced. It goes behind first.last however many companies voted for it.
  for (const p of NAME_ONLY) {
    if (order.indexOf(p) < order.indexOf('first.last')) {
      order.splice(order.indexOf(p), 1);
      order.splice(order.indexOf('first.last') + 1, 0, p);
    }
  }
  return order;
}

/**
 * @param {object[]} evidence  for one company
 * @param {string[]} prior     priorOrder() across all your contacts
 * @returns {{ pattern: string, confidence: 'high'|'medium'|'low', source: string,
 *             score: number, runnerUp: string|null, patterns: object[] }}
 */
function decide(evidence, prior = FALLBACK_ORDER) {
  const rank = (p) => { const i = prior.indexOf(p); return i === -1 ? 999 : i; };
  const patterns = summarize(evidence).sort((a, b) => (b.score - a.score) || (rank(a.pattern) - rank(b.pattern)));
  // Weak signs alone (first-name-only addresses of unknown owners) don't pick a format:
  // they only help once something else points somewhere.
  const positive = patterns.filter(s => s.score > 0 && s.score > s.weak * WEIGHTS.weak);

  if (!positive.length) {
    return { pattern: prior[0] || FALLBACK_ORDER[0], confidence: 'low', source: 'default', score: 0, runnerUp: null, patterns };
  }

  const best = positive[0];
  const second = positive[1];
  const runnerUp = second && second.score >= best.score / 2 ? second.pattern : null;
  let verified = verifiedByDelivery(best, patterns, runnerUp);
  let confidence = best.replies >= 1 || best.real >= 2 || verified ? 'high' : 'medium';
  // A name-only format (rahul@) is proven only by a REPLY from one at this company.
  // Measured on prod 2026-10-12: Discover "first" guesses hard-bounced 76% of the time
  // (first.last 14%); Codilar was "verified by delivery" as first and bounced 23 of 31,
  // while Whatfix — backed by a reply — bounced 0 of 12. A few first-name addresses
  // existing (founders, early hires) says nothing about everyone else's. Two format
  // sites agreeing, or two real addresses of known owners, still earn medium.
  let nameOnly = false;
  if (NAME_ONLY.has(best.pattern) && !best.replies) {
    nameOnly = true;
    verified = false;
    confidence = best.directory >= 2 || best.real >= 2 ? 'medium' : 'low';
  }

  let source = 'own';
  if (!best.replies && !best.delivered) {
    // The outside source that contributed most.
    source = Object.entries(best.sources)
      .filter(([k, w]) => k !== 'own' && w > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'own';
  }
  return { pattern: best.pattern, confidence, source, score: best.score, runnerUp, patterns, verified, nameOnly };
}

/**
 * Delivered sends prove a format only when the company's mail server REJECTS addresses
 * that don't exist — a catch-all server accepts everything, so on its own "nothing
 * bounced" proves nothing. One hard bounce at the domain (any format) shows it isn't
 * catch-all; after that, several delivered sends in one format, with almost none of
 * that format bouncing and no close second format, verify it as surely as a reply.
 */
function verifiedByDelivery(best, patterns, runnerUp) {
  if (runnerUp) return false;
  const domainBounces = patterns.reduce((n, s) => n + s.hardBounces, 0);
  if (domainBounces < VERIFY.minDomainBounces || best.delivered < VERIFY.minDelivered) return false;
  return best.hardBounces / (best.delivered + best.hardBounces) <= VERIFY.maxBounceShare;
}

/**
 * A format you set yourself for one company. It wins over the automatic decision, which
 * is kept beside it so the page can warn when your own sends disagree:
 *   'bounces' — two or more of your emails in your format bounced as unknown addresses
 *   'replies' — someone replied from another format and nobody from yours
 *
 * @param {{ pattern: string, from: 'list'|'example'|'test' }} manual
 * @param {object} auto  decide()'s answer for the same company
 */
function manualDecision(manual, auto) {
  const mine = (auto.patterns || []).find(p => p.pattern === manual.pattern) || { replies: 0, hardBounces: 0 };
  const repliedElsewhere = (auto.patterns || []).find(p => p.pattern !== manual.pattern && p.replies > 0);
  let conflict = null;
  if (mine.hardBounces >= 2) conflict = 'bounces';
  else if (repliedElsewhere && !mine.replies) conflict = 'replies';
  // A test email that didn't bounce proves the format only where the company's server
  // rejects addresses that don't exist (any hard bounce there shows it does) — a
  // catch-all server accepts everything. A reply proves it anywhere.
  const domainBounces = (auto.patterns || []).reduce((n, p) => n + (p.hardBounces || 0), 0);
  const testProven = manual.from === 'test' && (mine.replies > 0 || domainBounces > 0);
  return {
    pattern: manual.pattern,
    confidence: manual.from === 'example' || testProven ? 'high' : 'medium',
    catchAllRisk: manual.from === 'test' && !testProven,
    source: 'set',
    score: mine.score || 0,
    runnerUp: null,
    patterns: auto.patterns || [],
    verified: false,
    auto: { pattern: auto.pattern, confidence: auto.confidence, source: auto.source },
    conflict,
    conflictWith: conflict === 'replies' ? repliedElsewhere.pattern : (conflict ? auto.pattern : null),
  };
}

module.exports = {
  WEIGHTS, HARD_BOUNCE, NAME_ONLY, DELIVERED_AFTER_MS, REAL_CAP_PER_SOURCE, VERIFY, DIRECTORY_MAX_SITES,
  contactSignal, contactEvidence, realEvidence, hunterEvidence, directoryEvidence, summarize, priorOrder, decide,
  manualDecision,
};
