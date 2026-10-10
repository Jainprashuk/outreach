// The Company page: everything the app knows about one company, from every module —
// your contacts there (by where they came from), LinkedIn leads, Naukri jobs,
// interviews, Discover's people and searches, the email format, and the
// "Worth searching" score with its reasons.
//
// Read-only and rebuilt on every request; nothing here is stored. A company is
// matched by its email domain, and by name for the modules that only know a name
// (Naukri, interviews, a contact with a personal address).

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const NaukriJob = require('../models/NaukriJob');
const Interview = require('../models/Interview');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const { domainOfEmail, isFreeMail } = require('./emailPatterns');
const { sourceOf } = require('./contactList');
const finder = require('./patternFinder');
const worth = require('./discovery/companyWorth');
const { nameFromDomain } = require('./discovery/hiringCompanies');
const { keyFor, parseKey, keyOf } = require('./companyKey');

const asId = (id) => new mongoose.Types.ObjectId(String(id));
const REPLIED = new Set(['replied', 'follow-up-replied']);
const replied = (c) => !!c.repliedAt || REPLIED.has(c.status);
const contactSource = (c) => (c.naukriJobId ? 'naukri' : sourceOf(c));
// Whole contact minus message bodies — the page only needs to know a conversation exists.
const PERSON_FIELDS = { 'thread.text': 0, 'thread.html': 0, 'thread.subject': 0 };
// Mailbox lists a contact when they wrote back or sit in a to-do bucket.
const hasConversation = (c) => !!(c.action && c.action.state) || (c.thread || []).some(t => t.direction === 'inbound');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sent / replied / bounced counts for a set of contacts. */
function tally(contacts) {
  const t = { contacts: contacts.length, sent: 0, replied: 0, bounced: 0 };
  for (const c of contacts) {
    if (c.lastSentAt || ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced'].includes(c.status)) t.sent++;
    if (replied(c)) t.replied++;
    if (c.status === 'bounced') t.bounced++;
  }
  return t;
}

/**
 * Every company you have anything on: the Hiring now companies (with their worth
 * score) plus every work domain in your contacts.
 *
 * @param {{q?: string, sort?: 'score'|'recent'|'contacts', limit?: number}} opts
 */
async function companyList(userId, { q = '', sort = 'score', limit = 100 } = {}) {
  const uid = asId(userId);
  // The scorer already loads every contact; reuse them rather than reading twice.
  const { scored, data } = await worth.scoredWithData(uid);
  const contacts = data.contacts;

  const rows = new Map();
  for (const s of scored) {
    const key = s.domain ? `d:${s.domain}` : s.key;
    rows.set(key, {
      key, company: s.company, domain: s.domain, score: s.score, base: s.base, reasons: s.reasons, notes: s.notes, excluded: s.excluded,
      leads: s.linkedin, naukri: s.naukri, contacts: 0, sent: 0, replied: 0, bounced: 0,
      lastAt: s.lastSeenAt || null,
    });
  }
  const byDomain = new Map();
  for (const c of contacts) {
    const d = domainOfEmail(c.email);
    if (!d || isFreeMail(d)) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }
  for (const [d, list] of byDomain) {
    const key = `d:${d}`;
    const r = rows.get(key) || { key, company: '', domain: d, score: null, base: null, reasons: [], notes: [], excluded: null, leads: 0, naukri: 0, lastAt: null };
    Object.assign(r, tally(list));
    if (!r.company) {
      const names = list.map(c => String(c.company || '').trim()).filter(Boolean);
      r.company = names[0] || nameFromDomain(d);
    }
    const last = Math.max(...list.map(c => new Date(c.repliedAt || c.lastSentAt || 0).getTime()));
    if (!r.lastAt || last > new Date(r.lastAt).getTime()) r.lastAt = new Date(last);
    rows.set(key, r);
  }

  const needle = String(q || '').trim().toLowerCase();
  let list = [...rows.values()].filter(r => !needle || r.company.toLowerCase().includes(needle) || (r.domain || '').includes(needle));
  const SORTS = {
    score: (a, b) => ((b.score ?? -99) - (a.score ?? -99)) || (b.contacts - a.contacts),
    recent: (a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0),
    contacts: (a, b) => (b.contacts - a.contacts) || (b.replied - a.replied),
  };
  list.sort(SORTS[sort] || SORTS.score);
  const total = list.length;
  list = list.slice(0, Math.min(Math.max(limit, 1), 300));
  return { companies: list, total };
}

/** The decided format plus the evidence behind it, for the page to explain itself. */
function formatView(dec) {
  const best = (dec.patterns || []).find(p => p.pattern === dec.pattern) || {};
  const domainBounces = (dec.patterns || []).reduce((n, p) => n + (p.hardBounces || 0), 0);
  return {
    pattern: dec.pattern, confidence: dec.confidence, source: dec.source, verified: !!dec.verified,
    replies: best.replies || 0, delivered: best.delivered || 0, hardBounces: best.hardBounces || 0,
    real: best.real || 0, domainBounces, runnerUp: dec.runnerUp || null,
  };
}

/** Everything about one company. Null when the key isn't one. */
async function companyDetail(userId, rawKey) {
  const parsed = parseKey(rawKey);
  if (!parsed) return null;
  const uid = asId(userId);

  // Score first: for a name-only key it may know the domain (from your contacts).
  const scored = await worth.scoredCompanies(uid);
  let domain = parsed.domain || null;
  const row = scored.find(s => (domain && s.domain === domain) || (!domain && s.key === `n:${parsed.nameKey}`)) || null;
  if (!domain && row && row.domain) domain = row.domain;

  // The name the name-only modules are matched on.
  let nameKey = parsed.nameKey || (row ? keyOf(row.company) : null);
  const domainContacts = domain
    ? await Contact.find({ userId: uid, deleted: { $ne: true }, email: finder.onDomain(domain) }, PERSON_FIELDS).lean()
    : [];
  if (!nameKey) {
    const named = domainContacts.map(c => keyOf(c.company || '')).filter(Boolean);
    nameKey = named[0] || keyOf(nameFromDomain(domain));
  }
  const first = (nameKey || '').slice(0, 4);
  const nameRe = first ? { $regex: escapeRe(first), $options: 'i' } : null;
  const sameName = (s) => !!nameKey && keyOf(s || '') === nameKey;

  const [namedContacts, leads, jobs, interviews, prospects, searches, pattern] = await Promise.all([
    nameRe ? Contact.find({ userId: uid, deleted: { $ne: true }, company: nameRe }, PERSON_FIELDS).lean() : [],
    Lead.find({ userId: uid, deleted: { $ne: true }, $or: [
      ...(domain ? [{ email: finder.onDomain(domain) }] : []),
      ...(nameRe ? [{ company: nameRe }] : []),
    ] }, { authorName: 1, authorUrl: 1, email: 1, company: 1, postUrl: 1, fitScore: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(200).lean(),
    nameRe ? NaukriJob.find({ userId: uid, deleted: { $ne: true }, company: nameRe },
      { title: 1, company: 1, location: 1, url: 1, approval: 1, applyStatus: 1, appliedAt: 1, postedAt: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(200).lean() : [],
    Interview.find({ userId: uid, deleted: { $ne: true }, $or: [
      ...(domain ? [{ email: finder.onDomain(domain) }] : []),
      ...(nameRe ? [{ company: nameRe }] : []),
    ] }, { name: 1, company: 1, role: 1, status: 1, interviewAt: 1, email: 1 }).lean(),
    domain ? Prospect.find({ userId: uid, domain, deleted: { $ne: true } }, { name: 1, title: 1, email: 1, emailConfidence: 1, status: 1, linkedin: 1 }).limit(300).lean() : [],
    domain ? ProspectSearch.find({ userId: uid, domain }, { createdAt: 1, status: 1, roles: 1, counts: 1, jobTitle: 1 }).sort({ createdAt: -1 }).limit(20).lean() : [],
    domain ? finder.resolveDomain(uid, domain).catch(() => null) : null,
  ]);

  // Contacts: everyone on the domain, plus anyone whose company is this name.
  const seen = new Set();
  const contacts = [...domainContacts, ...namedContacts.filter(c => sameName(c.company))].filter(c => {
    const k = String(c._id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const bySource = {};
  for (const c of contacts) {
    const src = contactSource(c);
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(c);
  }

  // Timeline: what happened, newest first.
  const events = [];
  for (const c of contacts) for (const h of c.statusHistory || []) events.push({ at: h.changedAt, what: `${c.name}: ${h.status}`, kind: 'contact' });
  for (const j of jobs.filter(j => sameName(j.company))) if (j.appliedAt) events.push({ at: j.appliedAt, what: `Applied on Naukri: ${j.title}`, kind: 'naukri' });
  for (const s of searches) events.push({ at: s.createdAt, what: `Discover search${s.jobTitle ? ` for "${s.jobTitle}"` : ''}: ${(s.counts && s.counts.people) || 0} people`, kind: 'search' });
  for (const l of leads) events.push({ at: l.createdAt, what: `LinkedIn post by ${l.authorName || 'someone'}`, kind: 'lead' });
  events.sort((a, b) => new Date(b.at) - new Date(a.at));

  const company = (row && row.company) || (contacts.find(c => c.company) || {}).company || nameFromDomain(domain) || parsed.nameKey;
  const dec = pattern && pattern.decision;
  return {
    key: keyFor({ domain, company }),
    company,
    domain,
    worth: row ? { score: row.score, base: row.base, reasons: row.reasons, notes: row.notes, excluded: row.excluded, roles: row.roles, naukriJobId: row.naukriJobId, jobTitle: row.jobTitle } : null,
    totals: tally(contacts),
    contacts: Object.fromEntries(Object.entries(bySource).map(([src, list]) => [src, {
      ...tally(list),
      people: list.slice(0, 100).map(c => ({
        id: String(c._id), name: c.name, email: c.email, role: c.role, status: c.status,
        replyCategory: c.replyCategory || null, repliedAt: c.repliedAt || null, lastSentAt: c.lastSentAt || null,
        jobTitle: c.jobTitle || null, linkedin: c.linkedin || null, hasConversation: hasConversation(c),
      })),
    }])),
    leads: leads.map(l => ({ id: String(l._id), authorName: l.authorName, authorUrl: l.authorUrl, email: l.email, postUrl: l.postUrl, fitScore: l.fitScore, status: l.status, createdAt: l.createdAt })),
    naukriJobs: jobs.filter(j => sameName(j.company)).map(j => ({ id: String(j._id), title: j.title, location: j.location, url: j.url, approval: j.approval, applyStatus: j.applyStatus, appliedAt: j.appliedAt, postedAt: j.postedAt || j.createdAt })),
    interviews: interviews.filter(i => sameName(i.company) || (domain && domainOfEmail(i.email || '') === domain))
      .map(i => ({ id: String(i._id), name: i.name, role: i.role, status: i.status, interviewAt: i.interviewAt })),
    prospects: {
      total: prospects.length,
      byStatus: prospects.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] || 0) + 1 }), {}),
    },
    searches: searches.map(s => ({ id: String(s._id), at: s.createdAt, status: s.status, roles: s.roles, people: (s.counts && s.counts.people) || 0, jobTitle: s.jobTitle || null })),
    format: dec ? formatView(dec) : null,
    timeline: events.slice(0, 60),
  };
}

module.exports = { companyList, companyDetail, tally };
