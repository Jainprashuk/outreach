// Numbers for Analytics → Discover. One read of the user's searches, prospects and
// the contacts made from them, aggregated here so the page gets a small summary
// instead of every row.
//
// The question this answers first is "do the guessed addresses actually work?":
// reply and bounce rates per confidence label, measured on the contacts that were
// moved into outreach. Outcomes use the same signals as the pattern engine
// (lib/patternScore.js), so "replied" and "hard bounce" mean the same thing here
// as they do when the labels are decided.

const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const Contact = require('../models/Contact');
const DiscoveryConfig = require('../models/DiscoveryConfig');
const { contactSignal, HARD_BOUNCE } = require('./patternScore');
const usage = require('./discovery/usage');

const LABELS = ['high', 'medium', 'low', 'generic', 'manual'];
const DAY = 24 * 3600 * 1000;
const IST = 5.5 * 3600 * 1000;
const dayKey = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);

/** The label a prospect carried when it was moved — "manual" for an address you typed. */
const labelOf = (p) => (p.emailSource === 'manual' ? 'manual' : p.emailConfidence || null);

function outcomeOf(c) {
  if (!c) return null;
  const sig = contactSignal(c);
  const emailed = !!c.lastSentAt || ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'closed', 'no-openings', 'in-review'].includes(c.status);
  return {
    emailed,
    replied: !!sig && sig.kind === 'reply',
    bounced: c.status === 'bounced',
    hardBounced: c.status === 'bounced' && HARD_BOUNCE.test(c.bounceReason || ''),
    pending: c.approvalStatus === 'pending' && !emailed,
  };
}

async function discoverAnalytics(userId, { days = 30, now = new Date() } = {}) {
  const [searches, prospects, contacts, cfg] = await Promise.all([
    ProspectSearch.find({ userId }, { domain: 1, companyName: 1, status: 1, error: 1, roles: 1, createdAt: 1 }).lean(),
    Prospect.find({ userId, deleted: { $ne: true } },
      { domain: 1, company: 1, status: 1, emailConfidence: 1, emailSource: 1, email: 1, foundVia: 1, contactId: 1, movedAt: 1 }).lean(),
    Contact.find({ userId, deleted: { $ne: true }, prospectId: { $exists: true } },
      { prospectId: 1, status: 1, approvalStatus: 1, lastSentAt: 1, repliedAt: 1, bounceReason: 1, 'thread.direction': 1 }).lean(),
    DiscoveryConfig.findOne({ userId }).lean(),
  ]);

  const contactByProspect = new Map(contacts.map(c => [String(c.prospectId), c]));

  // ── per label: found → moved → emailed → replied / bounced ───────────────
  const byLabel = Object.fromEntries(LABELS.map(l => [l, { label: l, found: 0, moved: 0, emailed: 0, replied: 0, bounced: 0, hardBounced: 0, waiting: 0 }]));
  const totals = { found: 0, withEmail: 0, moved: 0, emailed: 0, replied: 0, bounced: 0, hardBounced: 0, waiting: 0 };
  const status = { open: 0, moved: 0, discarded: 0 };
  const via = { search: 0, github: 0, website: 0 };
  const companies = new Map();

  for (const p of prospects) {
    totals.found++;
    if (p.email) totals.withEmail++;
    if (p.status === 'moved') status.moved++;
    else if (p.status === 'discarded') status.discarded++;
    else status.open++;
    for (const v of p.foundVia || []) if (v in via) via[v]++;

    const co = companies.get(p.domain) || { domain: p.domain, company: p.company || '', people: 0, high: 0, medium: 0, low: 0, moved: 0, emailed: 0, replied: 0, bounced: 0 };
    co.people++;
    if (!co.company && p.company) co.company = p.company;

    const label = labelOf(p);
    if (label && p.email && byLabel[label]) {
      byLabel[label].found++;
      if (label === 'high' || label === 'medium' || label === 'low') co[label]++;
    }

    if (p.status === 'moved') {
      totals.moved++;
      co.moved++;
      const out = outcomeOf(contactByProspect.get(String(p._id)));
      const row = label && byLabel[label];
      if (row) row.moved++;
      if (out) {
        for (const k of ['emailed', 'replied', 'bounced', 'hardBounced']) {
          if (out[k]) { totals[k]++; if (row) row[k]++; }
        }
        if (out.pending) { totals.waiting++; if (row) row.waiting++; }
        if (out.emailed) co.emailed++;
        if (out.replied) co.replied++;
        if (out.bounced) co.bounced++;
      }
    }
    companies.set(p.domain, co);
  }

  // ── searches ─────────────────────────────────────────────────────────────
  const since = now.getTime() - days * DAY;
  const perDay = new Map();
  for (let t = since; t <= now.getTime(); t += DAY) perDay.set(dayKey(t), 0);
  const runs = { done: 0, failed: 0, cancelled: 0, running: 0 };
  const roles = new Map();
  for (const s of searches) {
    if (s.status === 'done') runs.done++;
    else if (s.status === 'error') { if (s.error === 'Cancelled') runs.cancelled++; else runs.failed++; }
    else runs.running++;
    const k = dayKey(s.createdAt);
    if (perDay.has(k)) perDay.set(k, perDay.get(k) + 1);
    for (const r of s.roles || []) {
      const key = r.trim().toLowerCase();
      if (key) roles.set(key, (roles.get(key) || 0) + 1);
    }
    if (!companies.has(s.domain)) {
      companies.set(s.domain, { domain: s.domain, company: s.companyName || '', people: 0, high: 0, medium: 0, low: 0, moved: 0, emailed: 0, replied: 0, bounced: 0 });
    } else if (!companies.get(s.domain).company && s.companyName) {
      companies.get(s.domain).company = s.companyName;
    }
  }
  const searchesLastDays = [...perDay.values()].reduce((a, b) => a + b, 0);

  // ── free allowances ──────────────────────────────────────────────────────
  const used = await usage.getUsage(userId);
  const allowance = ['tavily', 'serpapi', 'hunter'].map(p => ({
    provider: p,
    hasKey: !!(cfg && cfg[`${p}Enc`]),
    used: used[p] || 0,
    cap: DiscoveryConfig.MONTHLY_CAPS[p],
  }));

  return {
    days,
    totals: {
      ...totals,
      searches: searches.length,
      searchesLastDays,
      companies: companies.size,
    },
    byLabel: LABELS.map(l => byLabel[l]),
    status,
    via,
    runs,
    searchesPerDay: [...perDay.entries()].map(([day, n]) => ({ day, n })),
    topRoles: [...roles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([role, n]) => ({ role, n })),
    companies: [...companies.values()].sort((a, b) => b.people - a.people || b.moved - a.moved).slice(0, 15),
    allowance,
    month: used.month,
  };
}

module.exports = { discoverAnalytics, outcomeOf, labelOf };
