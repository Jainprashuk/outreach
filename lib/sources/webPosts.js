// Hiring-post finder: searches public posts (LinkedIn posts, X, Reddit) for "send
// your resume to x@y.com" and turns the ones with an email into Leads.
//
// LinkedIn is never opened — only what the search engine shows, the same rule as
// Discover. A result whose snippet holds no email is skipped rather than fetched, so
// a run costs exactly its searches and nothing more.

const Lead = require('../../models/Lead');
const { extractEmails } = require('./emails');
const { readPosts } = require('./readPosts');
const { toSourceLead } = require('./toSourceLeads');
const { dropDeadEmails } = require('./paste');
const { REJECT } = require('./sourceFit');

const TEMPLATES = [
  (role, place) => `"${role}" hiring "share your resume" email ${place}`,
  (role, place) => `"${role}" hiring "send your CV" mail ${place}`,
  (role, place) => `we are hiring "${role}" "interested candidates" email ${place}`,
  (role, place) => `"${role}" opening "drop your resume" ${place}`,
  (role, place) => `"${role}" urgent hiring "mail your resume" ${place}`,
];

const clean = (s) => String(s || '').replace(/["]/g, '').trim();

/**
 * Pure: today's searches. Every (role × template) pair, rotated by day so a week of
 * runs covers different searches instead of repeating the first `perDay`.
 */
function buildPostQueries(target, perDay, day = Math.floor(Date.now() / 86_400_000)) {
  const roles = (target.roles || []).map(clean).filter(Boolean).slice(0, 8);
  if (!roles.length) return [];
  const place = (target.locations || []).map(clean).find(l => l && l.toLowerCase() !== 'remote') || '';
  const all = [];
  for (let t = 0; t < TEMPLATES.length; t++) for (const role of roles) all.push(TEMPLATES[t](role, place).trim());
  const n = Math.min(perDay, all.length);
  const start = (day * n) % all.length;
  return Array.from({ length: n }, (_, i) => all[(start + i) % all.length]);
}

/**
 * Search results → leads worth importing. Skips posts already on your board and
 * snippets without an email; the AI reads the rest; rejects are counted, not stored.
 *
 * @returns {Promise<{ leads: object[], read: number, withEmail: number, rejected: number, aiError: string|null }>}
 */
async function resultsToLeads(results, { userId, target, query, now = new Date() }) {
  const urls = results.map(r => r.url).filter(Boolean);
  const seen = new Set((await Lead.find({ userId, postUrl: { $in: urls }, deleted: { $ne: true } }, { postUrl: 1 }).lean()).map(d => d.postUrl));
  const fresh = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    const text = `${r.title}\n${r.snippet}`.trim();
    const emails = extractEmails(text);
    if (emails.length) fresh.push({ r, text, emails });
  }
  const { readings, error } = await readPosts(fresh.map(f => f.text), { userId });
  let rejected = 0;
  const leads = [];
  fresh.forEach((f, i) => {
    const lead = toSourceLead({
      source: 'web-post', text: f.text, url: f.r.url, emails: f.emails, query,
      postedAt: f.r.publishedAt, reading: readings[i],
    }, target, now);
    if (lead.fit_score === REJECT) rejected++;
    else leads.push(lead);
  });
  const checked = await dropDeadEmails(leads);
  return { leads: checked.leads, read: results.length, withEmail: fresh.length, rejected, aiError: error };
}

module.exports = { buildPostQueries, resultsToLeads, TEMPLATES };
