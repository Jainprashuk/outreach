// One found post → one lead in the harvester's JSON shape, so it goes through
// lib/leadImport.js importLeads() exactly like a LinkedIn harvest: same dedupe, same
// Leads board, same Move to outreach.
//
// author_url is ALWAYS set (the post / HN comment / paste chunk). importLeads keys an
// email-less lead by author_url, then author_name — without a url, every email-less
// lead from these sources would collapse into one "(unknown)" row.

const crypto = require('crypto');
const { extractEmails, extractLinks, domainOf, FREE_MAIL } = require('./emails');
const { scoreItem } = require('./sourceFit');

const SOURCES = ['paste', 'hn', 'web-post'];

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** A company name from an email domain, when nothing better is known: hr@acme-labs.in → "Acme Labs". */
function companyFromEmails(emails) {
  const d = (emails || []).map(domainOf).find(x => x && !FREE_MAIL.has(x));
  if (!d) return '';
  const core = d.replace(/^(?:www|mail|careers|jobs|hr)\./, '').split('.')[0];
  return core.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * @param post {
 *   source: 'paste'|'hn'|'web-post', text, url?, author?, query?, postedAt?,
 *   emails?, links?,               // extracted from `text` when not given
 *   company?, role?, location?,    // from the post header / AI reading
 *   reading?                       // lib/sources/readPosts.js result, or null
 * }
 * @param target { roles, locations, maxYears }
 */
function toSourceLead(post, target = {}, now = new Date()) {
  if (!SOURCES.includes(post.source)) throw new Error(`unknown source ${post.source}`);
  const text = String(post.text || '');
  const r = post.reading || {};
  const emails = post.emails || extractEmails(text);
  const links = post.links || extractLinks(text);
  const company = post.company || r.company || companyFromEmails(emails);
  const role = post.role || r.role || '';
  const location = post.location || r.location || '';
  const fit = scoreItem({
    text, emails, role, location,
    remote: r.remote === true ? true : null,
    hiring: post.hiring != null ? post.hiring : r.hiring,
    isSeeker: r.isSeeker,
    minYears: r.minYears,
    postedAt: post.postedAt,
  }, target, now);

  return {
    author_name: post.author || company || (emails[0] || '').split('@')[0] || '(unknown)',
    author_url: post.url || `${post.source}:${sha1(text)}`,
    emails,
    company,
    role,
    location,
    links,
    post_url: post.url || null,
    posted_at: post.postedAt || null,
    snippet: text.slice(0, 1500),
    source: post.source,
    query: post.query || '',
    fit_score: fit.score,
    fit_reasons: fit.reasons,
    hiring: fit.hiring,
  };
}

module.exports = { toSourceLead, companyFromEmails, SOURCES, sha1 };
