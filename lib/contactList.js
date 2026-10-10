/**
 * Server-side filtering, sorting, counting and paging for the Dashboard and
 * Contacts tables.
 *
 * Every function here is a line-for-line port of the browser code it replaces
 * (AppContext.filterContacts/getStats, lib/format isFollowUpDue, and the
 * filter/sort blocks in pages/Dashboard.tsx and pages/Contacts.tsx), running on
 * the same inputs, so the rows and numbers come out identical — including its
 * quirks (search runs over name+email+company concatenated; the Blocked tab
 * falls through to all contacts). scripts/parity/contacts-list.js holds the
 * old browser code and proves the match on real data. Change behaviour there
 * and here together, deliberately — not as a side effect of a refactor.
 */

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Every field the functions below read. The list query loads only these, so an
// 11k-contact account filters in memory without pulling a single mail thread.
const FILTER_FIELDS = {
  name: 1, email: 1, company: 1, status: 1, approvalStatus: 1, template: 1,
  replyCategory: 1, source: 1, prospectId: 1, createdAt: 1, lastSentAt: 1, repliedAt: 1,
  followUpSentAt: 1, replyRead: 1,
};

// lib/format.ts isFollowUpDue
const isFollowUpDue = (c) =>
  c.status === 'sent' && !c.followUpSentAt &&
  !!c.lastSentAt && (Date.now() - new Date(c.lastSentAt).getTime() >= THREE_DAYS_MS);

// AppContext.filterContacts
function filterByTab(cs, tab) {
  if (tab === 'all') return cs;
  if (tab === 'pending') return cs.filter(c => c.approvalStatus === 'pending');
  if (tab === 'sent') return cs.filter(c => c.status === 'sent');
  if (tab === 'in-campaign') return cs.filter(c => c.status === 'in-campaign');
  if (tab === 'remaining') return cs.filter(c => c.status === 'queued');
  if (tab === 'bounced') return cs.filter(c => c.status === 'bounced');
  if (tab === 'replied') return cs.filter(c => c.status === 'replied');
  if (tab === 'followup-due') return cs.filter(isFollowUpDue);
  if (tab === 'follow-up-sent') return cs.filter(c => c.status === 'follow-up-sent');
  if (tab === 'follow-up-replied') return cs.filter(c => c.status === 'follow-up-replied');
  if (tab === 'closed') return cs.filter(c => c.status === 'closed');
  if (tab === 'no-openings') return cs.filter(c => c.status === 'no-openings');
  if (tab === 'in-review') return cs.filter(c => c.status === 'in-review');
  return cs;
}

// AppContext.getStats, plus the three counts Dashboard derives beside it.
function getStats(cs) {
  return {
    total: cs.length,
    sent: cs.filter(c => c.status === 'sent').length,
    bounced: cs.filter(c => c.status === 'bounced').length,
    replied: cs.filter(c => c.status === 'replied').length,
    followUpReplied: cs.filter(c => c.status === 'follow-up-replied').length,
    pending: cs.filter(c => c.approvalStatus === 'pending').length,
    remaining: cs.filter(c => c.status === 'queued').length,
    followUpDue: cs.filter(isFollowUpDue).length,
    followUpSent: cs.filter(c => c.status === 'follow-up-sent').length,
    closed: cs.filter(c => c.status === 'closed').length,
    noOpenings: cs.filter(c => c.status === 'no-openings').length,
    inReview: cs.filter(c => c.status === 'in-review').length,
    resumable: cs.filter(c => c.status === 'queued' && c.approvalStatus === 'approved').length,
    failed: cs.filter(c => c.status === 'failed').length,
    unread: cs.filter(c => c.status === 'replied' && !c.replyRead).length,
  };
}

// pages/Contacts.tsx inDateRange. `from`/`to` arrive as the exact instants the
// browser computed from its local yyyy-mm-dd, so no timezone is decided here.
const inRange = (iso, fromMs, toMs) => {
  if (fromMs == null && toMs == null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (fromMs != null && t < fromMs) return false;
  if (toMs != null && t > toMs) return false;
  return true;
};

// pages/Dashboard.tsx sortContacts (a stable sort over the createdAt-desc base order).
function sortContacts(arr, sortCol, sortDir) {
  return [...arr].sort((a, b) => {
    let va, vb;
    switch (sortCol) {
      case 'name': va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
      case 'company': va = (a.company || '').toLowerCase(); vb = (b.company || '').toLowerCase(); break;
      case 'template': va = (a.template || '').toLowerCase(); vb = (b.template || '').toLowerCase(); break;
      case 'status': va = (a.status || '').toLowerCase(); vb = (b.status || '').toLowerCase(); break;
      case 'approval': va = a.approvalStatus || ''; vb = b.approvalStatus || ''; break;
      case 'lastSentAt': va = new Date(a.lastSentAt || 0); vb = new Date(b.lastSentAt || 0); break;
      case 'repliedAt': va = new Date(a.repliedAt || 0); vb = new Date(b.repliedAt || 0); break;
      default: va = new Date(a.createdAt || 0); vb = new Date(b.createdAt || 0);
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

const ms = (v) => {
  if (v == null || v === '') return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Where a contact came from: 'lead' (LinkedIn Leads board), 'discover' (moved in from
 * the Discover tab — it carries a prospectId) or 'outreach' (added directly).
 * Discover contacts are stored with source 'outreach', so the prospectId decides.
 */
const sourceOf = (c) => (c.prospectId ? 'discover' : (c.source || 'outreach'));

/** "  Acme   Corp " and "acme corp" are the same company for the filter. */
const normCompanyName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Query-string params → the filter state the pages hold. */
function parseListQuery(q) {
  return {
    tab: q.tab || 'all',
    search: q.q || '',
    status: q.status || '',
    approval: q.approval || '',
    template: q.template || '',
    category: q.category || '',
    source: q.source || '',
    // One company, matched on its name ignoring case and extra spaces. Absent → no filter.
    company: q.company || '',
    createdFrom: ms(q.createdFrom), createdTo: ms(q.createdTo),
    sentFrom: ms(q.sentFrom), sentTo: ms(q.sentTo),
    repliedFrom: ms(q.repliedFrom), repliedTo: ms(q.repliedTo),
    // Absent on Contacts, which shows the base order unsorted.
    sort: q.sort || null,
    dir: q.dir === 'asc' ? 'asc' : 'desc',
  };
}

/** The filtered (and optionally sorted) list — the pages' `filtered`. */
function applyListQuery(cs, f) {
  let list = filterByTab(cs, f.tab);
  const q = f.search.trim().toLowerCase();
  if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
  if (f.status) list = list.filter(c => c.status === f.status);
  if (f.approval) list = list.filter(c => c.approvalStatus === f.approval);
  if (f.template) list = list.filter(c => c.template === f.template);
  if (f.category) list = list.filter(c => c.replyCategory === f.category);
  if (f.source) list = list.filter(c => sourceOf(c) === f.source);
  if (f.company) {
    const want = normCompanyName(f.company);
    list = list.filter(c => normCompanyName(c.company) === want);
  }
  if (f.createdFrom != null || f.createdTo != null) list = list.filter(c => inRange(c.createdAt, f.createdFrom, f.createdTo));
  if (f.sentFrom != null || f.sentTo != null) list = list.filter(c => inRange(c.lastSentAt, f.sentFrom, f.sentTo));
  if (f.repliedFrom != null || f.repliedTo != null) list = list.filter(c => inRange(c.repliedAt, f.repliedFrom, f.repliedTo));
  return f.sort ? sortContacts(list, f.sort, f.dir) : list;
}

module.exports = { FILTER_FIELDS, isFollowUpDue, filterByTab, getStats, sortContacts, parseListQuery, applyListQuery, sourceOf };
