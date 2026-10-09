// "Find people" for one company, as a background Inngest function with one step per
// source. Each step is its own short function run, so a slow website or GitHub can't
// push anything past Vercel's 60s, and a source that fails marks its own step and
// lets the rest carry on.
//
// The owner is read from the ProspectSearch document, never from the event — same
// rule as the send functions.

const mongoose = require('mongoose');
const { inngest } = require('../inngest');
const db = require('../db');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const CompanyPattern = require('../models/CompanyPattern');
const Contact = require('../models/Contact');
const { deadline } = require('./http');
const { notify } = require('./notify');
const { checkMx } = require('./mx');
const ep = require('./emailPatterns');
const finder = require('./patternFinder');
const usage = require('./discovery/usage');
const { searchPeople } = require('./discovery/search');
const { githubPeople } = require('./discovery/github');
const { scanWebsite, companyNameFromSite } = require('./discovery/website');
const { extractPeople } = require('./discovery/llmExtract');

const STEP_BUDGET_MS = 40_000;
const RECHECK_MS = 30 * 24 * 3600 * 1000; // outside sources are re-read at most monthly
const MAX_LLM_CALLS = 3;
const MAX_SAMPLES_PER_SOURCE = 50;
// A run still "running" this long after its last write has died (a crashed function
// can't record its own failure); it is shown as failed and a new run is allowed.
const STALE_MS = 10 * 60 * 1000;

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};

const fresh = (at) => at && Date.now() - new Date(at).getTime() < RECHECK_MS;

async function setStep(searchId, key, patch) {
  const set = { 'steps.$.at': new Date() };
  for (const [k, v] of Object.entries(patch)) set[`steps.$.${k}`] = v;
  await ProspectSearch.updateOne({ _id: searchId, 'steps.key': key }, { $set: set });
}

/** Run one step: load the search, record running/done/error, never throw. */
async function runStep(searchId, key, fn) {
  await ensureDb();
  const search = await ProspectSearch.findById(searchId).lean();
  if (!search || search.status === 'done' || search.status === 'error') return { skipped: true };
  if (search.status === 'queued') {
    await ProspectSearch.updateOne({ _id: searchId }, { $set: { status: 'running', startedAt: new Date() } });
  }
  await setStep(searchId, key, { status: 'running' });
  try {
    const r = (await fn(search)) || {};
    await setStep(searchId, key, { status: r.status || 'done', found: r.found || 0, detail: (r.detail || '').slice(0, 300), info: r.info || {} });
    return { stop: !!r.stop, found: r.found || 0 };
  } catch (err) {
    await setStep(searchId, key, { status: 'error', detail: String(err.message || err).slice(0, 300), info: { reason: 'crash' } });
    return { error: String(err.message || err) };
  }
}

/**
 * Add people to a company's prospects, merging with anyone already there by nameKey.
 * Never touches a moved or discarded prospect's status, and never overwrites an
 * address you edited by hand.
 *
 * @param {object[]} people  [{ name, title?, linkedin?, roleMatch?, knownEmail?, via }]
 * @returns {Promise<{total: number, added: number}>}  people kept, and how many were new
 */
async function mergePeople(search, people) {
  const { userId, domain } = search;
  const batch = new Map();
  for (const p of people) {
    const key = ep.nameKey(p.name);
    if (!key || !ep.isPlausibleName(p.name)) continue;
    const prev = batch.get(key);
    if (!prev) { batch.set(key, { ...p, nameKey: key, via: [p.via] }); continue; }
    prev.via = [...new Set([...prev.via, p.via])];
    if ((p.title || '').length > (prev.title || '').length) prev.title = p.title;
    prev.linkedin = prev.linkedin || p.linkedin || null;
    prev.knownEmail = prev.knownEmail || p.knownEmail || null;
    prev.knownEmailVia = prev.knownEmailVia || p.knownEmailVia || null;
    prev.roleMatch = prev.roleMatch || !!p.roleMatch;
  }
  if (!batch.size) return { total: 0, added: 0 };

  const existing = await Prospect.find(
    { userId, domain, nameKey: { $in: [...batch.keys()] }, deleted: { $ne: true } },
    { nameKey: 1, title: 1, linkedin: 1, knownEmail: 1 },
  ).lean();
  const byKey = new Map(existing.map(e => [e.nameKey, e]));

  const ops = [];
  for (const p of batch.values()) {
    const ex = byKey.get(p.nameKey);
    if (ex) {
      const set = { searchId: search._id, company: search.companyName };
      if (p.title && p.title.length > (ex.title || '').length) set.title = p.title;
      if (p.linkedin && !ex.linkedin) set.linkedin = p.linkedin;
      if (p.knownEmail && !ex.knownEmail) { set.knownEmail = p.knownEmail; set.knownEmailVia = p.knownEmailVia; }
      if (p.roleMatch) set.roleMatch = true;
      ops.push({ updateOne: { filter: { _id: ex._id, userId }, update: { $set: set, $addToSet: { foundVia: { $each: p.via } } } } });
    } else {
      ops.push({ insertOne: { document: {
        userId, domain, searchId: search._id, company: search.companyName,
        name: p.name.replace(/\s+/g, ' ').trim().slice(0, 120),
        title: p.title || '', linkedin: p.linkedin || null, nameKey: p.nameKey,
        foundVia: p.via, roleMatch: !!p.roleMatch,
        knownEmail: p.knownEmail || null, knownEmailVia: p.knownEmailVia || null,
      } } });
    }
  }
  await Prospect.bulkWrite(ops, { ordered: false });
  return { total: batch.size, added: ops.filter(o => o.insertOne).length };
}

/** Replace one source's samples on the company, keeping the other source's. */
async function setSamples(userId, domain, source, pairs) {
  const cp = await CompanyPattern.findOne({ userId, domain }, { samples: 1 }).lean();
  const others = ((cp && cp.samples) || []).filter(s => s.source !== source);
  const mine = pairs.slice(0, MAX_SAMPLES_PER_SOURCE).map(p => ({ source, name: p.name || '', email: p.email }));
  await CompanyPattern.updateOne({ userId, domain }, { $set: { samples: [...others, ...mine] } });
}

// ─────────────────────────────────────────────── steps

async function stepCompany(search) {
  const { userId, domain } = search;
  const budget = deadline(STEP_BUDGET_MS);
  await CompanyPattern.updateOne({ userId, domain }, { $setOnInsert: { userId, domain } }, { upsert: true });
  let cp = await CompanyPattern.findOne({ userId, domain }).lean();

  if (!cp.mxCheckedAt || !fresh(cp.mxCheckedAt) || cp.hasMx === null) {
    const hasMx = await checkMx(domain);
    await CompanyPattern.updateOne({ userId, domain }, { $set: { hasMx, mxCheckedAt: new Date() } });
    cp = { ...cp, hasMx };
  }

  // The name searches use: what you typed, else what your own contacts call it, else
  // the website's own name, else the domain.
  let companyName = (search.companyName || '').trim();
  let nameFrom = 'typed';
  if (!companyName) { companyName = finder.companyNameFrom(await finder.contactsAt(userId, domain)); nameFrom = 'contacts'; }
  if (!companyName) { companyName = cp.companyName || ''; nameFrom = 'earlier'; }
  if (!companyName) { companyName = await companyNameFromSite(domain, budget.signal); nameFrom = 'website'; }
  if (!companyName) { companyName = domain.split('.')[0].replace(/^./, c => c.toUpperCase()); nameFrom = 'domain'; }

  await ProspectSearch.updateOne({ _id: search._id }, { $set: { companyName } });
  await CompanyPattern.updateOne({ userId, domain }, { $set: { companyName } });

  if (cp.hasMx === false) {
    await finish(search._id, { error: `${domain} can't receive email (no mail server), so no one there can be emailed.` });
    return { status: 'error', detail: 'No mail server for this domain', stop: true, info: { companyName, domain, hasMx: false, nameFrom } };
  }
  return { detail: companyName, info: { companyName, domain, hasMx: cp.hasMx, nameFrom } };
}

async function stepPeopleSearch(search) {
  const keys = await usage.loadKeys(search.userId);
  if (!keys.tavily && !keys.serpapi) return { status: 'skipped', detail: 'No search key — add a free Tavily key in Settings', info: { reason: 'no-key' } };
  const budget = deadline(STEP_BUDGET_MS);
  const r = await searchPeople({
    userId: search.userId, keys, companyName: search.companyName, domain: search.domain,
    roles: search.roles, signal: budget.signal,
  });
  const m = await mergePeople(search, r.people);
  const left = await usage.getUsage(search.userId);
  const info = {
    provider: r.provider, queries: r.queries, found: m.total, added: m.added,
    roleMatches: r.people.filter(p => p.roleMatch).length,
    leftThisMonth: r.provider ? Math.max(0, usage.MONTHLY_CAPS[r.provider] - left[r.provider]) : null,
  };
  if (r.error && !m.total) {
    const reason = /allowance|used up/i.test(r.error) ? 'allowance' : /rejected the key/i.test(r.error) ? 'bad-key' : 'error';
    return { status: 'error', detail: r.error, info: { ...info, reason } };
  }
  return { found: m.total, detail: `${r.queries} search${r.queries === 1 ? '' : 'es'} via ${r.provider || 'search'}`, info };
}

async function stepGithub(search) {
  const { userId, domain } = search;
  const cp = await CompanyPattern.findOne({ userId, domain }).lean();
  if (fresh(cp.githubCheckedAt) && !search.force) {
    return { status: 'skipped', detail: cp.githubOrg ? `github.com/${cp.githubOrg} checked recently` : 'Checked recently — no GitHub organisation',
      info: { reason: 'recent', org: cp.githubOrg || null, checkedAt: cp.githubCheckedAt, addresses: ((cp.samples || []).filter(x => x.source === 'github')).length } };
  }
  const keys = await usage.loadKeys(userId);
  const budget = deadline(STEP_BUDGET_MS);
  const r = await githubPeople({
    token: keys.github, domain, companyName: search.companyName,
    orgOverride: cp.githubOrgManual ? cp.githubOrg : null, signal: budget.signal,
  });
  if (r.error) {
    return { status: 'error', detail: r.error, info: { reason: /rate limit/i.test(r.error) ? 'rate-limit' : 'error', hasToken: !!keys.github } };
  }

  const set = { githubCheckedAt: new Date() };
  if (!cp.githubOrgManual) set.githubOrg = r.org;
  await CompanyPattern.updateOne({ userId, domain }, { $set: set });
  await setSamples(userId, domain, 'github', r.identities);

  const m = await mergePeople(search, r.identities.map(i => ({
    name: i.name, title: '', knownEmail: i.email, knownEmailVia: 'github', via: 'github',
  })));
  if (!r.org) return { status: 'skipped', detail: 'No GitHub organisation found for this domain', info: { reason: 'no-org' } };
  return {
    found: m.total,
    detail: `github.com/${r.org}: ${r.identities.length} work address${r.identities.length === 1 ? '' : 'es'}`,
    info: { org: r.org, addresses: r.identities.length, found: m.total, added: m.added },
  };
}

async function stepWebsite(search) {
  const { userId, domain } = search;
  const cp = await CompanyPattern.findOne({ userId, domain }).lean();
  if (fresh(cp.websiteCheckedAt) && !search.force) {
    return { status: 'skipped', detail: 'Checked recently', info: { reason: 'recent', checkedAt: cp.websiteCheckedAt, generic: (cp.genericEmails || []).length } };
  }

  const budget = deadline(STEP_BUDGET_MS);
  const site = await scanWebsite(domain, budget.signal);
  await CompanyPattern.updateOne({ userId, domain }, { $set: { websiteCheckedAt: new Date() } });
  if (!site.ok) return { status: 'skipped', detail: 'Website did not answer', info: { reason: 'unreachable', why: site.why || null } };

  // People named on team pages, read by the free AI (a few calls at most).
  const teamPeople = [];
  let llmNote = '';
  for (const page of site.teamPages.slice(0, MAX_LLM_CALLS)) {
    if (budget.remaining() < 22_000) break;
    const r = await extractPeople(page.text, { companyName: search.companyName, userId: search.userId });
    if (r.error) { llmNote = r.error; break; }
    teamPeople.push(...r.people.map(p => ({ ...p, via: 'website' })));
  }
  const team = await mergePeople(search, teamPeople);

  // Personal addresses on the site are evidence only when they can be tied to a
  // named person — an address with no name says nothing about the format.
  const prospects = await Prospect.find({ userId, domain, deleted: { $ne: true } }, { name: 1 }).lean();
  const pairs = [];
  const attach = [];
  for (const email of site.personal) {
    const owners = prospects.filter(p => ep.inferPattern(p.name, email));
    if (owners.length === 1) {
      pairs.push({ name: owners[0].name, email });
      attach.push({ name: owners[0].name, knownEmail: email, knownEmailVia: 'website', via: 'website' });
    }
  }
  await mergePeople(search, attach);
  await setSamples(userId, domain, 'website', pairs);
  await CompanyPattern.updateOne({ userId, domain }, { $set: { genericEmails: site.generic.slice(0, 20) } });

  const bits = [`${site.personal.length + site.generic.length} address${site.personal.length + site.generic.length === 1 ? '' : 'es'} on the site`];
  if (teamPeople.length) bits.push(`${teamPeople.length} people on team pages`);
  if (llmNote && !teamPeople.length) bits.push(`team pages not read (${llmNote})`);
  return {
    found: team.total,
    detail: bits.join(' · '),
    info: {
      pages: site.pages || 0, teamPages: site.teamPages.length, teamPeople: team.total, added: team.added,
      personal: site.personal.length, matched: pairs.length, generic: site.generic.length,
      aiBusy: !!(llmNote && !teamPeople.length && site.teamPages.length),
    },
  };
}

async function stepPattern(search) {
  const keys = await usage.loadKeys(search.userId);
  const { decision, contacts } = await finder.resolveDomain(search.userId, search.domain, { hunterKey: keys.hunter });
  const best = decision.patterns.find(p => p.pattern === decision.pattern) || {};
  return {
    detail: `${decision.pattern} (${decision.confidence}, ${decision.source})`,
    info: {
      pattern: decision.pattern, confidence: decision.confidence, source: decision.source, runnerUp: decision.runnerUp,
      replies: best.replies || 0, delivered: best.delivered || 0, real: best.real || 0, hunter: !!best.hunter,
      hardBounces: best.hardBounces || 0, contactsAtDomain: contacts.length, hasHunterKey: !!keys.hunter,
    },
  };
}

/**
 * Give every open prospect at this company an address and a label. Also used by the
 * "Re-check" button, which is why it reads everything itself instead of taking the
 * pattern step's result.
 */
async function applyEmails(userId, domain) {
  const { decision, contacts, cp } = await finder.resolveDomain(userId, domain);
  const prospects = await Prospect.find(
    { userId, domain, deleted: { $ne: true }, status: { $in: ['new', 'ready', 'error'] } },
  ).lean();

  // Already in outreach: by address (exact) or by person (same name, other address).
  const all = await Contact.find({ userId, deleted: { $ne: true }, email: finder.onDomain(domain) }, { name: 1, email: 1 }).lean();
  const byEmail = new Map(all.map(c => [c.email.toLowerCase(), c]));
  const byName = new Map();
  for (const c of all) { const k = ep.nameKey(c.name); if (k && !byName.has(k)) byName.set(k, c); }

  const ops = [];
  let withEmail = 0;
  const byLabel = {};
  for (const p of prospects) {
    const set = { note: '', existingContactId: null, contactedAs: null };

    if (cp && cp.hasMx === false) {
      Object.assign(set, { status: 'error', email: null, emailConfidence: null, emailSource: null, emailPattern: null, note: `${domain} can't receive email` });
    } else if (p.emailSource === 'manual' && p.email) {
      set.status = 'ready';
      // A typed address can be on another domain, which the lookup below doesn't
      // cover — keep what the edit route found for it.
      if (ep.domainOfEmail(p.email) !== domain) set.existingContactId = p.existingContactId || null;
    } else if (p.knownEmail) {
      const generic = ep.isRoleAddress(p.knownEmail);
      Object.assign(set, {
        status: 'ready', email: p.knownEmail, emailSource: p.knownEmailVia || 'website',
        emailConfidence: generic ? 'generic' : 'high',
        emailPattern: generic ? null : ep.inferPattern(p.name, p.knownEmail),
      });
    } else {
      const email = ep.generateEmail(p.name, decision.pattern, domain);
      if (!email) {
        Object.assign(set, { status: 'ready', email: null, emailConfidence: null, emailSource: null, emailPattern: null, note: "Can't guess — need their full name" });
      } else {
        const parsed = ep.splitName(p.name);
        const weakName = parsed && parsed.lastInitialOnly;
        Object.assign(set, {
          status: 'ready', email, emailPattern: decision.pattern,
          emailConfidence: weakName ? 'low' : decision.confidence,
          emailSource: decision.source,
          note: weakName ? 'Surname is only an initial' : '',
        });
      }
    }

    const email = (set.email !== undefined ? set.email : p.email) || null;
    const source = set.emailSource !== undefined ? set.emailSource : p.emailSource;
    const label = !email ? 'none' : source === 'manual' ? 'manual'
      : ((set.emailConfidence !== undefined ? set.emailConfidence : p.emailConfidence) || 'none');
    byLabel[label] = (byLabel[label] || 0) + 1;
    if (email) {
      withEmail++;
      const hit = byEmail.get(email.toLowerCase());
      if (hit) set.existingContactId = String(hit._id);
      else {
        const same = byName.get(p.nameKey);
        if (same) set.contactedAs = same.email;
      }
    }
    ops.push({ updateOne: { filter: { _id: p._id, userId }, update: { $set: set } } });
  }
  if (ops.length) await Prospect.bulkWrite(ops, { ordered: false });
  return { decision, people: prospects.length, withEmail, byLabel };
}

async function stepEmails(search) {
  const r = await applyEmails(search.userId, search.domain);
  const added = await Prospect.countDocuments({ userId: search.userId, domain: search.domain, searchId: search._id, createdAt: { $gte: search.createdAt } });
  const counts = { people: r.people, withEmail: r.withEmail, added, ...r.byLabel };
  await finish(search._id, { counts });
  const company = search.companyName || search.domain;
  await notify(search.userId, {
    type: 'discover.finished',
    title: r.people ? `Found ${r.people} ${r.people === 1 ? 'person' : 'people'} at ${company}` : `No people found at ${company}`,
    body: r.people ? `${r.withEmail} of ${r.people} have an email address.` : '',
    severity: r.people ? undefined : 'info',
    link: '/discover',
    dedupeKey: `discover.finished:${search._id}`,
  });
  return { found: r.withEmail, detail: `${r.withEmail} of ${r.people} have an address`, info: counts };
}

async function finish(searchId, { error = null, counts } = {}) {
  const set = { status: error ? 'error' : 'done', finishedAt: new Date(), error };
  if (counts) set.counts = counts;
  // Steps that never ran are skipped, not left looking like they're about to.
  await ProspectSearch.updateOne({ _id: searchId }, { $set: set });
  await ProspectSearch.updateOne(
    { _id: searchId },
    { $set: { 'steps.$[s].status': 'skipped' } },
    { arrayFilters: [{ 's.status': { $in: ['pending', 'running'] } }] },
  );
}

const STEPS = [
  ['company', stepCompany],
  ['people-search', stepPeopleSearch],
  ['github', stepGithub],
  ['website', stepWebsite],
  ['pattern', stepPattern],
  ['emails', stepEmails],
];

const prospectsSearch = inngest.createFunction(
  {
    id: 'prospects-search',
    retries: 1,
    // One search at a time per user: two would race on the same free allowances.
    concurrency: { limit: 1, key: 'event.data.userId' },
    triggers: [{ event: 'prospects/search.start' }],
  },
  async ({ event, step }) => {
    const { searchId } = event.data;
    for (const [key, fn] of STEPS) {
      const r = await step.run(key, () => runStep(searchId, key, fn));
      if (r.skipped || r.stop) return { searchId, stoppedAt: key };
    }
    return { searchId };
  },
);

/** How a run looks to the UI, with a dead one reported as failed. */
function present(search) {
  const s = { ...search };
  const last = new Date(s.updatedAt || s.createdAt).getTime();
  if ((s.status === 'running' || s.status === 'queued') && Date.now() - last > STALE_MS) {
    s.status = 'error';
    s.error = s.error || 'The search stopped responding. Try again.';
  }
  return s;
}

const isActive = (search) => search && (search.status === 'running' || search.status === 'queued')
  && Date.now() - new Date(search.updatedAt || search.createdAt).getTime() <= STALE_MS;

module.exports = { prospectsSearch, applyEmails, mergePeople, present, isActive, STALE_MS };
