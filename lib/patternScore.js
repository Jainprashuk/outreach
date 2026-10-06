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

const WEIGHTS = { reply: 2, delivered: 1, hardBounce: -4, real: 2, hunter: 2 };
// A single source can't win on volume alone: ten commits from one prolific engineer
// are not ten independent confirmations.
const REAL_CAP_PER_SOURCE = 6;
const DELIVERED_AFTER_MS = 5 * 24 * 3600 * 1000;

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

/** Evidence from real addresses seen elsewhere: [{ name, email }] → +2 each. */
function realEvidence(pairs, source) {
  const out = [];
  for (const p of pairs) {
    const pattern = inferPattern(p.name, p.email);
    if (pattern) out.push({ pattern, kind: 'real', weight: WEIGHTS.real, source });
  }
  return out;
}

function hunterEvidence(pattern) {
  return pattern ? [{ pattern, kind: 'hunter', weight: WEIGHTS.hunter, source: 'hunter' }] : [];
}

/** Per-pattern totals, with real-address evidence capped per source. */
function summarize(evidence) {
  const by = new Map();
  const realBySource = new Map();
  for (const e of evidence) {
    if (!PATTERN_KEYS.includes(e.pattern)) continue;
    let s = by.get(e.pattern);
    if (!s) {
      s = { pattern: e.pattern, score: 0, replies: 0, delivered: 0, hardBounces: 0, real: 0, hunter: false, sources: {} };
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
  const positive = patterns.filter(s => s.score > 0);

  if (!positive.length) {
    return { pattern: prior[0] || FALLBACK_ORDER[0], confidence: 'low', source: 'default', score: 0, runnerUp: null, patterns };
  }

  const best = positive[0];
  const second = positive[1];
  const runnerUp = second && second.score >= best.score / 2 ? second.pattern : null;
  const confidence = best.replies >= 1 || best.real >= 2 ? 'high' : 'medium';

  let source = 'own';
  if (!best.replies && !best.delivered) {
    // The outside source that contributed most.
    source = Object.entries(best.sources)
      .filter(([k, w]) => k !== 'own' && w > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'own';
  }
  return { pattern: best.pattern, confidence, source, score: best.score, runnerUp, patterns };
}

module.exports = {
  WEIGHTS, HARD_BOUNCE, DELIVERED_AFTER_MS, REAL_CAP_PER_SOURCE,
  contactSignal, contactEvidence, realEvidence, hunterEvidence, summarize, priorOrder, decide,
};
