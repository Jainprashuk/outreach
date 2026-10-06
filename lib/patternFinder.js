// Works out one company's email format for one user, from everything the app knows:
// your own outreach history (read fresh from Contacts every time, never stored), real
// addresses on your Leads board, what GitHub and the company website showed
// (CompanyPattern.samples), and — only when all of that is silent — Hunter.
// The rules themselves are in lib/patternScore.js.

const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const CompanyPattern = require('../models/CompanyPattern');
const { fetchJson } = require('./http');
const { fromHunterPattern } = require('./emailPatterns');
const score = require('./patternScore');
const usage = require('./discovery/usage');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const onDomain = (domain) => ({ $regex: `@${escapeRe(domain)}$`, $options: 'i' });

const SIGNAL_FIELDS = { name: 1, email: 1, company: 1, status: 1, repliedAt: 1, lastSentAt: 1, bounceReason: 1, 'thread.direction': 1 };

/** All your contacts at this domain, with the fields the rules read. */
function contactsAt(userId, domain) {
  return Contact.find({ userId, deleted: { $ne: true }, email: onDomain(domain) }, SIGNAL_FIELDS).lean();
}

/** Your formats ranked across every company you've emailed — the default guess. */
async function priorFor(userId, now = new Date()) {
  const rows = await Contact.find({
    userId,
    deleted: { $ne: true },
    $or: [
      { lastSentAt: { $ne: null } },
      { repliedAt: { $ne: null } },
      { status: { $in: ['replied', 'follow-up-replied', 'bounced'] } },
    ],
  }, SIGNAL_FIELDS).lean();
  return score.priorOrder(score.contactEvidence(rows, now));
}

/** Real addresses at this domain on your Leads board, as (name, email) pairs. */
async function leadPairs(userId, domain) {
  const rows = await Lead.find({ userId, deleted: { $ne: true }, email: onDomain(domain) }, { authorName: 1, email: 1 }).lean();
  return rows.map(r => ({ name: r.authorName, email: r.email }));
}

/** The most common `company` among your contacts at this domain, or ''. */
function companyNameFrom(contacts) {
  const counts = new Map();
  for (const c of contacts) {
    const name = String(c.company || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/** Every piece of evidence for one company. */
async function evidenceFor(userId, domain, cp, { contacts, now = new Date() } = {}) {
  const [own, leads] = await Promise.all([
    contacts ? Promise.resolve(contacts) : contactsAt(userId, domain),
    leadPairs(userId, domain),
  ]);
  const samples = (cp && cp.samples) || [];
  return [
    ...score.contactEvidence(own, now),
    ...score.realEvidence(leads, 'leads'),
    ...score.realEvidence(samples.filter(s => s.source === 'github'), 'github'),
    ...score.realEvidence(samples.filter(s => s.source === 'website'), 'website'),
    ...score.hunterEvidence(cp && cp.hunterPattern),
  ];
}

/**
 * Ask Hunter for the company's format. At most once per domain, ever, and only within
 * the user's free monthly allowance. Returns the mapped pattern or null.
 */
async function askHunter(userId, domain, key) {
  if (!key) return null;
  if (!(await usage.take(userId, 'hunter'))) return null;
  const res = await fetchJson(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=1&api_key=${encodeURIComponent(key)}`,
    { timeoutMs: 12_000, retries: 0 },
  );
  // A rejected key is not "Hunter has no answer" — don't burn the once-per-domain ask on it.
  if (res.status === 401 || res.status === 403) return null;
  const pattern = res.ok ? fromHunterPattern(res.data && res.data.data && res.data.data.pattern) : null;
  if (res.ok) {
    await CompanyPattern.updateOne({ userId, domain }, { $set: { hunterAskedAt: new Date(), hunterPattern: pattern } });
  }
  return pattern;
}

/**
 * The decision for one company.
 *
 * @param {object} [opts]
 * @param {string} [opts.hunterKey]  when set, Hunter is asked if nothing else knows
 */
async function resolveDomain(userId, domain, { hunterKey, now = new Date() } = {}) {
  let cp = await CompanyPattern.findOne({ userId, domain }).lean();
  const contacts = await contactsAt(userId, domain);
  const prior = await priorFor(userId, now);

  let evidence = await evidenceFor(userId, domain, cp, { contacts, now });
  let decision = score.decide(evidence, prior);

  if (decision.source === 'default' && hunterKey && cp && !cp.hunterAskedAt) {
    const hp = await askHunter(userId, domain, hunterKey);
    if (hp) {
      cp = await CompanyPattern.findOne({ userId, domain }).lean();
      evidence = await evidenceFor(userId, domain, cp, { contacts, now });
      decision = score.decide(evidence, prior);
    }
  }
  return { decision, prior, contacts, cp };
}

module.exports = { resolveDomain, contactsAt, priorFor, leadPairs, companyNameFrom, evidenceFor, askHunter, onDomain };
