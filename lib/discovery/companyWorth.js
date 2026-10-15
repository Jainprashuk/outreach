// Discover → "Worth searching": the few companies, out of everything Leads and Naukri
// bring in, that are worth spending a people search on.
//
// Every company in Hiring now (same LinkedIn + Naukri merge, see mergeHiring) gets a
// score from what the rest of the app already knows about it — how people there
// replied, how your Naukri applications are going, interviews, how busy their hiring
// is, how well the posts fit you — and every point comes with a sentence saying why.
// Free outside signals (lib/discovery/enrich) add to it from their cache.
//
// Read-only and rebuilt on every request; nothing here is stored. The scoring itself
// is pure (scoreCompanies) so scripts/test-company-worth.js proves every rule without
// a database.

const mongoose = require('mongoose');
const Lead = require('../../models/Lead');
const NaukriJob = require('../../models/NaukriJob');
const Contact = require('../../models/Contact');
const Interview = require('../../models/Interview');
const ProspectSearch = require('../../models/ProspectSearch');
const CompanyPattern = require('../../models/CompanyPattern');
const SuggestionDismissal = require('../../models/SuggestionDismissal');
const CompanySignal = require('../../models/CompanySignal');
const { loadBlocklistSets } = require('../blocklist');
const { domainOfEmail, isFreeMail } = require('../emailPatterns');
const { mergeHiring, nameFromDomain, keyOf } = require('./hiringCompanies');
const { statsFromContacts, domainForName: domainForNameOf, domainStats, prepare: prepareContacts } = require('./contactDomains');
const { rolesForJob } = require('./jobRoles');

const DAY = 24 * 3600 * 1000;

// All the points in one place, so tuning the list is one edit (and the test file
// reads them from here rather than repeating numbers).
const WEIGHTS = {
  replyPositive: 5,        // each reply classed reviewing / resume-requested…
  replyPositiveCap: 10,    // …up to this much in total
  replyStayInTouch: 3,
  naukriInReview: 5,       // an application there is in review / interviewing
  interview: 4,            // an interview with them is in progress
  applied: 3,              // you applied there on Naukri
  approved: 2,             // you approved one of its Naukri jobs (passed your own filter)
  momentum2: 2,            // ≥2 different jobs/posts in the last two weeks
  momentum4: 3,            // ≥4
  topFit: 2,               // a LinkedIn post in the top quarter of YOUR fit scores
  knownFormat: 1,          // the email format there is already known
  alreadyTried: -2,        // ≥3 emailed, nobody replied, 3+ weeks on
  jobsRejectedByYou: -2,   // you rejected its Naukri jobs and approved none
  applicationRejected: -3, // Naukri says the application was rejected
  bouncy: -3,              // most emails there hard-bounced and the format is unknown
};

const RULES = {
  windowDays: 30,          // hiring activity this recent (same as Hiring now's default)
  momentumDays: 14,
  noReplyDays: 90,         // a "no" this recent removes the company
  searchedDays: 30,        // searched this recently → under Done, not suggested again
  triedAfterDays: 21,
  triedMin: 3,
  bounceMin: 3,
  bounceShare: 0.5,
  minScore: 5,             // shown only at or above this…
  maxShown: 10,            // …and at most this many
  candidateMin: 3,         // outside signals are fetched only for companies at or above this…
  candidates: 25,          // …the strongest this many
};

const IN_REVIEW = new Set(['in-review', 'interviewing']);
const TERMINAL_INTERVIEW = new Set(['selected', 'rejected']);

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/** The key a company's outside signals are cached under: its domain, or its name key. */
const signalKey = (row) => row.domain || row.key;

/** 75th percentile of your own fit scores, or null when there are too few to rank. */
function topFitThreshold(leads) {
  const scores = leads.map(l => l.fitScore).filter(n => Number.isFinite(n) && n > -999).sort((a, b) => a - b);
  if (scores.length < 4) return null;
  const t = scores[Math.floor(scores.length * 0.75)];
  return t > 0 ? t : null;
}

/**
 * Score every company. Pure.
 *
 * @param {object} data
 * @param {object[]} data.leads        Lead docs: { _id, email, company, createdAt, postUrl, fitScore }
 * @param {object[]} data.naukri       NaukriJob docs: { _id, company, title, createdAt, postedAt, approval, applyStatus }
 * @param {object[]} data.contacts     Contact docs: { email, company, status, replyCategory, repliedAt, lastSentAt, bounceReason }
 * @param {object[]} [data.interviews] Interview docs: { company, email, status }
 * @param {object[]} [data.searches]   ProspectSearch docs: { domain, createdAt }
 * @param {object[]} [data.dismissals] { key, until }
 * @param {Set<string>} [data.blockedDomains]
 * @param {object[]} [data.patterns]   { domain, samples (count), hunterPattern }
 * @param {object[]} [data.signals]    CompanySignal docs: { key, source, status, points, reasons, note }
 * @param {object} [opts]
 * @returns {object[]} one row per company, strongest first; excluded rows carry `excluded`
 */
function scoreCompanies(data, { now = new Date() } = {}) {
  const t = now.getTime();
  const ago = (d) => t - d * DAY;

  // 1. The same rows Hiring now shows, plus what each row was built from.
  const items = new Map(); // row key → { linkedin: [], naukri: [] }
  const rows = mergeHiring(data.leads || [], data.naukri || [], (r, kind, doc) => {
    let it = items.get(r.key);
    if (!it) items.set(r.key, (it = { linkedin: [], naukri: [] }));
    it[kind].push(doc);
  });

  // 2. Your contacts, by domain — and company name → domain, so a Naukri company you
  //    have emailed before is tied to what happened when you did. Summarised per domain
  //    (contactDomains.js): by the database for loadWorthData, from `contacts` otherwise.
  const cs = data.contactStats || statsFromContacts(data.contacts || [], { now, rules: RULES, keyOf });
  const domainForName = (name) => domainForNameOf(cs.votes, keyOf, name);

  // 3. Interviews in progress, matched by company name or a work address.
  const interviewNames = new Set();
  const interviewDomains = new Set();
  for (const iv of data.interviews || []) {
    if (TERMINAL_INTERVIEW.has(iv.status)) continue;
    const nk = keyOf(iv.company || '');
    if (nk) interviewNames.add(nk);
    const d = domainOfEmail(iv.email || '');
    if (d && !isFreeMail(d)) interviewDomains.add(d);
  }

  const searchedAt = new Map();
  for (const s of data.searches || []) {
    const at = new Date(s.createdAt).getTime();
    if (at >= ago(RULES.searchedDays) && (!searchedAt.has(s.domain) || at > searchedAt.get(s.domain))) searchedAt.set(s.domain, at);
  }
  const dismissed = new Set((data.dismissals || []).filter(d => new Date(d.until).getTime() > t).map(d => d.key));
  const blocked = data.blockedDomains || new Set();
  const formatKnown = new Set((data.patterns || []).filter(p => p.samples > 0 || p.hunterPattern).map(p => p.domain));
  const signalsByKey = new Map();
  for (const s of data.signals || []) {
    if (!signalsByKey.has(s.key)) signalsByKey.set(s.key, []);
    signalsByKey.get(s.key).push(s);
  }
  const fitBar = topFitThreshold(data.leads || []);

  const out = [];
  for (const r of rows.values()) {
    const it = items.get(r.key) || { linkedin: [], naukri: [] };
    const domain = r.domain || domainForName(r.company);
    const company = r.company || nameFromDomain(domain);
    const reasons = [];
    const add = (points, text, kind = 'app') => { if (points) reasons.push({ points, text, kind }); };
    let excluded = null;

    // ── your own outreach there
    const st = (domain && cs.byDomain.get(domain)) || null;
    const positive = st ? st.positive : 0;
    const stay = !!(st && st.stay);
    const saidNo = !!(st && st.saidNo);
    const anyReply = !!(st && st.anyReply);
    if (positive) add(Math.min(positive * WEIGHTS.replyPositive, WEIGHTS.replyPositiveCap), `${plural(positive, 'reply', 'replies')} said they're reviewing or asked for your resume`);
    if (stay) add(WEIGHTS.replyStayInTouch, 'Someone there asked to stay in touch');
    const tried = st ? st.tried : 0;
    if (tried >= RULES.triedMin && !anyReply) add(WEIGHTS.alreadyTried, `Already emailed ${tried} people, no reply in 3+ weeks`);
    const sent = st ? st.sent : 0;
    const hard = st ? st.hard : 0;
    const known = !!domain && (formatKnown.has(domain) || anyReply);
    if (hard >= RULES.bounceMin && sent && hard / sent >= RULES.bounceShare && !known) {
      add(WEIGHTS.bouncy, `Most emails there bounced (${hard} of ${sent}) and the format isn't known`);
    }
    if (known) add(WEIGHTS.knownFormat, 'Email format there is already known');

    // ── Naukri
    const jobs = it.naukri;
    const inReview = jobs.find(j => IN_REVIEW.has(j.applyStatus));
    const applied = jobs.find(j => j.applyStatus === 'applied');
    const approved = jobs.filter(j => j.approval === 'approved');
    const offer = jobs.some(j => j.applyStatus === 'offer');
    if (inReview) add(WEIGHTS.naukriInReview, `Naukri: your application for "${inReview.title}" is ${inReview.applyStatus === 'interviewing' ? 'at interview stage' : 'in review'}`);
    else if (applied) add(WEIGHTS.applied, `You applied on Naukri: "${applied.title}"`);
    if (approved.length && !inReview && !applied) add(WEIGHTS.approved, `You approved ${plural(approved.length, 'Naukri job')} here`);
    if (jobs.some(j => j.applyStatus === 'rejected')) add(WEIGHTS.applicationRejected, 'A Naukri application here was rejected');
    else if (jobs.length && !approved.length && jobs.every(j => j.approval === 'rejected')) add(WEIGHTS.jobsRejectedByYou, 'You rejected its Naukri jobs');

    // ── interviews
    if (interviewNames.has(keyOf(company)) || (domain && interviewDomains.has(domain))) add(WEIGHTS.interview, 'An interview with them is in progress');

    // ── hiring momentum: distinct posts and jobs in the last two weeks
    const recent = new Set();
    for (const l of it.linkedin) if (new Date(l.createdAt).getTime() >= ago(RULES.momentumDays)) recent.add('p:' + (l.postUrl || l._id));
    for (const j of jobs) if (new Date(j.postedAt || j.createdAt).getTime() >= ago(RULES.momentumDays)) recent.add('j:' + String(j.title || j._id).toLowerCase());
    if (recent.size >= 4) add(WEIGHTS.momentum4, `${recent.size} jobs/posts in the last two weeks`);
    else if (recent.size >= 2) add(WEIGHTS.momentum2, `${recent.size} jobs/posts in the last two weeks`);

    // ── fit
    if (fitBar != null) {
      const best = Math.max(-Infinity, ...it.linkedin.map(l => l.fitScore).filter(Number.isFinite));
      if (best >= fitBar) add(WEIGHTS.topFit, `A top-fit LinkedIn post (fit ${best})`);
    }

    const base = reasons.reduce((s, x) => s + x.points, 0);

    // ── outside signals, from the cache. Only `ok` rows count, so a source that
    //    failed or was skipped adds 0 and is mentioned as a note instead.
    const notes = [];
    for (const s of signalsByKey.get(signalKey({ ...r, domain })) || []) {
      if (s.status === 'ok' && s.points) {
        const first = (s.reasons || [])[0] || {};
        reasons.push({ points: s.points, text: first.text || s.source, url: first.url || null, kind: s.source });
      } else if (s.status === 'error' || s.status === 'skipped') {
        notes.push(s.note || `${s.source} check ${s.status === 'error' ? 'unavailable' : 'skipped'}`);
      }
    }
    const score = reasons.reduce((s, x) => s + x.points, 0);

    // ── leave-outs, most important first
    if (domain && blocked.has(domain)) excluded = 'blocked';
    else if (saidNo) excluded = 'said-no';
    else if (offer) excluded = 'offer';
    else if (domain && searchedAt.has(domain)) excluded = 'searched';
    else if (dismissed.has(r.key)) excluded = 'dismissed';

    const job = inReview || applied || approved[0] || null;
    out.push({
      key: r.key,
      company,
      domain: domain || null,
      needsDomain: !domain,
      base,
      score,
      reasons: reasons.sort((a, b) => b.points - a.points),
      notes,
      roles: job ? rolesForJob(job.title) : null,
      naukriJobId: job ? String(job._id) : null,
      jobTitle: job ? job.title : null,
      linkedin: r.linkedin,
      naukri: r.naukri,
      lastSeenAt: r.lastSeenAt,
      searchedAt: domain && searchedAt.has(domain) ? new Date(searchedAt.get(domain)) : null,
      excluded,
    });
  }

  out.sort((a, b) => (b.score - a.score) || (new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0)));
  return out;
}

/** The list Discover shows: not left out, at or above the bar, the strongest few. */
function pickSuggestions(scored, { limit = RULES.maxShown } = {}) {
  return scored.filter(r => !r.excluded && r.score >= RULES.minScore).slice(0, limit);
}

/** Companies worth an outside look: the strongest on the app's own signals alone. */
function pickCandidates(scored) {
  return scored.filter(r => !r.excluded && r.base >= RULES.candidateMin)
    .sort((a, b) => b.base - a.base)
    .slice(0, RULES.candidates);
}

const asId = (userId) => new mongoose.Types.ObjectId(String(userId));

/** Everything scoreCompanies needs, for one user. Reads only. */
async function loadWorthData(userId, { now = new Date() } = {}) {
  const uid = asId(userId);
  const since = new Date(now.getTime() - RULES.windowDays * DAY);
  const [leads, naukri, interviews, searches, dismissals, block, patterns, contactPrep] = await Promise.all([
    // Only what the scorer reads: the email's domain part (all mergeHiring uses), and
    // postUrl only where hiring momentum looks at it.
    Lead.aggregate([
      { $match: { userId: uid, deleted: { $ne: true }, email: { $ne: null }, createdAt: { $gte: since } } },
      { $project: {
        // domainOfEmail only reads what follows the last '@' (none, or a leading one: '').
        email: { $let: { vars: { e: { $toString: '$email' } }, in: { $let: {
          vars: { last: { $arrayElemAt: [{ $split: ['$$e', '@'] }, -1] } },
          in: { $cond: [{ $gt: [{ $subtract: [{ $strLenCP: '$$e' }, { $add: [{ $strLenCP: '$$last' }, 1] }] }, 0] },
            { $concat: ['x@', '$$last'] }, ''] },
        } } } },
        company: 1, createdAt: 1, fitScore: 1,
        postUrl: { $cond: [{ $gte: ['$createdAt', new Date(now.getTime() - RULES.momentumDays * DAY)] }, '$postUrl', '$$REMOVE'] },
      } },
    ]),
    // Recent jobs, plus older ones you applied to recently — an application in review
    // matters more than when the job was first seen.
    NaukriJob.find({ userId: uid, deleted: { $ne: true }, company: { $nin: ['', null] },
      $or: [{ createdAt: { $gte: since } }, { appliedAt: { $gte: since } }] },
    { company: 1, title: 1, createdAt: 1, postedAt: 1, approval: 1, applyStatus: 1 }).lean(),
    Interview.find({ userId: uid, deleted: { $ne: true } }, { company: 1, email: 1, status: 1 }).lean(),
    ProspectSearch.find({ userId: uid, createdAt: { $gte: new Date(now.getTime() - RULES.searchedDays * DAY) } }, { domain: 1, createdAt: 1 }).lean(),
    SuggestionDismissal.find({ userId: uid, until: { $gt: now } }, { key: 1, until: 1 }).lean(),
    loadBlocklistSets(uid),
    CompanyPattern.aggregate([
      { $match: { userId: uid } },
      { $project: { domain: 1, hunterPattern: 1, samples: { $size: { $ifNull: ['$samples', []] } } } },
    ]),
    prepareContacts(Contact, uid),
  ]);
  // Contacts only for the companies being scored: their domains, and the domains the
  // name-only (Naukri) companies may resolve to — summarised by the database.
  const rows = [...mergeHiring(leads, naukri).values()];
  const contactStats = await domainStats(Contact, uid, {
    now, rules: RULES, keyOf, prep: contactPrep,
    domains: rows.filter(r => r.domain).map(r => r.domain),
    nks: rows.filter(r => !r.domain).map(r => keyOf(r.company || '')),
  });
  return { leads, naukri, contactStats, contactPrep, interviews, searches, dismissals, blockedDomains: block.domains, patterns };
}

/** Cached outside signals for these companies: shared facts plus this user's fit. */
async function loadSignals(userId, keys) {
  if (!keys.length) return [];
  return CompanySignal.find({ key: { $in: keys }, $or: [{ userId: null }, { userId: asId(userId) }] }).lean();
}

/**
 * Score every company for one user, outside signals included.
 * @returns {Promise<object[]>} see scoreCompanies
 */
async function scoredCompanies(userId, opts = {}) {
  return (await scoredWithData(userId, opts)).scored;
}

/** Same, plus the data it was scored from — so a caller needing the contacts too doesn't load them twice. */
async function scoredWithData(userId, { now = new Date() } = {}) {
  const data = await loadWorthData(userId, { now });
  return { scored: await scoreWithSignals(userId, data, { now }), data };
}

/** scoreCompanies over loaded data, outside signals included. */
async function scoreWithSignals(userId, data, { now = new Date() } = {}) {
  const first = scoreCompanies(data, { now });
  data.signals = await loadSignals(userId, [...new Set(first.map(signalKey))]);
  return data.signals.length ? scoreCompanies(data, { now }) : first;
}

/** The domains scoreCompanies gives its rows — known before scoring, from the same rules. */
function scoredDomains(data) {
  const cs = data.contactStats;
  const out = new Set();
  for (const r of mergeHiring(data.leads || [], data.naukri || []).values()) {
    const d = r.domain || domainForNameOf(cs.votes, keyOf, r.company);
    if (d) out.add(d);
  }
  return out;
}

module.exports = {
  WEIGHTS, RULES,
  scoreCompanies, pickSuggestions, pickCandidates, signalKey, topFitThreshold,
  loadWorthData, loadSignals, scoredCompanies, scoredWithData, scoreWithSignals, scoredDomains,
};
