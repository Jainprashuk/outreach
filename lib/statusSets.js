/**
 * The contact status groups and the "where did this contact come from" rule that
 * analytics, reports and the Contacts filter share. They used to keep their own
 * copies, and the copies drifted: when campaigns added `in-campaign`, Analytics
 * silently dropped every contact in that state. scripts/test-status-sets.js fails
 * when models/Contact.js gains a status that isn't placed here.
 *
 * The browser keeps its own copy in client/src/lib/analytics.ts (STATUS_META,
 * ACTIVITY_META, EMAILED) — the test checks that one too.
 */

// Ever reached the recipient's inbox (or tried to and bounced).
const EMAILED = ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'closed', 'no-openings', 'in-review'];
const REPLIED = ['replied', 'follow-up-replied'];
// Every Contact.status, in client/src/lib/analytics.ts STATUS_META key order.
const STATUS_KEYS = ['queued', 'in-campaign', 'sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced', 'failed',
  'closed', 'no-openings', 'in-review', 'blocked'];
// ACTIVITY_META types a contact can produce (the interview ones come from the browser).
const CONTACT_ACTIVITY_TYPES = ['added', 'sent', 'delivered', 'follow-up-sent', 'replied', 'follow-up-replied',
  'bounced', 'failed', 'in-review', 'closed', 'no-openings', 'queued', 'in-campaign', 'blocked'];

// Where a contact came from, most specific first:
//   naukri   — found from a Naukri job you applied to (carries naukriJobId)
//   discover — moved in from the Discover tab (carries prospectId; stored with source 'outreach')
//   library  — added from the Shared Library (fromLibrary)
//   lead     — moved from the LinkedIn Leads board (source 'lead')
//   outreach — added directly (CSV / manual)
const SOURCE_ORDER = ['outreach', 'lead', 'discover', 'library', 'naukri'];
const SOURCE_LABELS = {
  outreach: 'Direct (CSV / manual)', lead: 'LinkedIn Leads', discover: 'Discover',
  library: 'Shared Library', naukri: 'Naukri → Find people',
};

const sourceOf = (c) => (c.naukriJobId ? 'naukri'
  : c.prospectId ? 'discover'
  : c.fromLibrary === true ? 'library'
  : (c.source || 'outreach'));

// The same rule as a MongoDB expression. "Truthy" matches the JS above.
const set = (f) => ({ $not: [{ $in: [{ $ifNull: [f, null] }, [null, false, 0, '']] }] });
const sourceExpr = { $switch: {
  branches: [
    { case: set('$naukriJobId'), then: 'naukri' },
    { case: set('$prospectId'), then: 'discover' },
    { case: { $eq: ['$fromLibrary', true] }, then: 'library' },
    { case: set('$source'), then: '$source' },
  ],
  default: 'outreach',
} };

module.exports = { EMAILED, REPLIED, STATUS_KEYS, CONTACT_ACTIVITY_TYPES, SOURCE_ORDER, SOURCE_LABELS, sourceOf, sourceExpr };
