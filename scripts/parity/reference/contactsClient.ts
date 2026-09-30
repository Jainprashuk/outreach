// REFERENCE ONLY — the browser code that filtered/sorted/counted the Dashboard
// and Contacts tables before GET /api/contacts/list existed, copied verbatim
// (commit 462104f: context/AppContext.tsx, lib/format.ts, pages/Dashboard.tsx,
// pages/Contacts.tsx). scripts/parity/contacts-list.js runs it against the
// server port in lib/contactList.js. Do not "fix" anything in here.
/* eslint-disable */
type Contact = any;

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// lib/format.ts
export const isFollowUpDue = (c: Contact) =>
  c.status === 'sent' && !c.followUpSentAt &&
  !!c.lastSentAt && (Date.now() - new Date(c.lastSentAt).getTime() >= THREE_DAYS_MS);

// context/AppContext.tsx
export const getStats = (contacts: Contact[]) => ({
  total: contacts.length,
  sent: contacts.filter(c => c.status === 'sent').length,
  bounced: contacts.filter(c => c.status === 'bounced').length,
  replied: contacts.filter(c => c.status === 'replied').length,
  followUpReplied: contacts.filter(c => c.status === 'follow-up-replied').length,
  pending: contacts.filter(c => c.approvalStatus === 'pending').length,
  remaining: contacts.filter(c => c.status === 'queued').length,
  followUpDue: contacts.filter(isFollowUpDue).length,
  followUpSent: contacts.filter(c => c.status === 'follow-up-sent').length,
  closed: contacts.filter(c => c.status === 'closed').length,
  noOpenings: contacts.filter(c => c.status === 'no-openings').length,
  inReview: contacts.filter(c => c.status === 'in-review').length,
  // pages/Dashboard.tsx
  resumable: contacts.filter(c => c.status === 'queued' && c.approvalStatus === 'approved').length,
  failed: contacts.filter(c => c.status === 'failed').length,
  unread: contacts.filter(c => c.status === 'replied' && !c.replyRead).length,
});

export const filterContacts = (cs: Contact[], tab: string): Contact[] => {
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
};

// pages/Dashboard.tsx
export const dashboardFiltered = (contacts: Contact[], s: {
  tab: string; search: string; statusFilter: string; approvalFilter: string; templateFilter: string;
  sortCol: string; sortDir: 'asc' | 'desc';
}) => {
  const { sortCol, sortDir } = s;
  const sortContacts = (arr: Contact[]) => [...arr].sort((a, b) => {
    let va: any, vb: any;
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
  let list = filterContacts(contacts, s.tab);
  const q = s.search.trim().toLowerCase();
  if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
  if (s.statusFilter) list = list.filter(c => c.status === s.statusFilter);
  if (s.approvalFilter) list = list.filter(c => c.approvalStatus === s.approvalFilter);
  if (s.templateFilter) list = list.filter(c => c.template === s.templateFilter);
  return sortContacts(list);
};

// pages/Contacts.tsx
const inDateRange = (iso: string | null | undefined, from: string, to: string) => {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
};

export const contactsFiltered = (contacts: Contact[], s: {
  tab: string; search: string; statusFilter: string; approvalFilter: string; templateFilter: string;
  categoryFilter: string; sourceFilter: string;
  dateFilters: { createdFrom: string; createdTo: string; sentFrom: string; sentTo: string; repliedFrom: string; repliedTo: string };
}) => {
  const { dateFilters } = s;
  let list = filterContacts(contacts, s.tab);
  const q = s.search.trim().toLowerCase();
  if (q) list = list.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
  if (s.statusFilter) list = list.filter(c => c.status === s.statusFilter);
  if (s.approvalFilter) list = list.filter(c => c.approvalStatus === s.approvalFilter);
  if (s.templateFilter) list = list.filter(c => c.template === s.templateFilter);
  if (s.categoryFilter) list = list.filter(c => c.replyCategory === s.categoryFilter);
  if (s.sourceFilter) list = list.filter(c => (c.source || 'outreach') === s.sourceFilter);
  if (dateFilters.createdFrom || dateFilters.createdTo) {
    list = list.filter(c => inDateRange(c.createdAt, dateFilters.createdFrom, dateFilters.createdTo));
  }
  if (dateFilters.sentFrom || dateFilters.sentTo) {
    list = list.filter(c => inDateRange(c.lastSentAt, dateFilters.sentFrom, dateFilters.sentTo));
  }
  if (dateFilters.repliedFrom || dateFilters.repliedTo) {
    list = list.filter(c => inDateRange(c.repliedAt, dateFilters.repliedFrom, dateFilters.repliedTo));
  }
  return list;
};
