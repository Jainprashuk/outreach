// Pure-function ports from js/app.js — identical behavior.
import type { Contact, CustomVariable, Sender, Template } from './api';

export const initials = (name: string) =>
  name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

const AVATAR_COLORS: Array<[string, string]> = [
  ['var(--blue-bg)', 'var(--blue)'],
  ['var(--green-bg)', 'var(--green)'],
  ['var(--amber-bg)', 'var(--amber)'],
  ['var(--pink-bg)', 'var(--pink)'],
  ['var(--teal-bg)', 'var(--teal)'],
];

export const avatarColor = (name: string): [string, string] =>
  AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];

export const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent', 'follow-up-sent': 'Follow-up Sent', failed: 'Failed', pending: 'Pending',
  queued: 'Queued', approved: 'Approved', rejected: 'Rejected', bounced: 'Bounced',
  replied: 'Replied', 'follow-up-replied': 'Replied after Follow-up', closed: 'Closed',
  'no-openings': 'No Openings', 'in-review': 'In Review',
};

export const BADGE_CLASS: Record<string, string> = {
  sent: 'badge-sent', 'follow-up-sent': 'badge-followup', failed: 'badge-rejected',
  pending: 'badge-pending', queued: 'badge-queued', approved: 'badge-approved',
  rejected: 'badge-rejected', bounced: 'badge-bounced', replied: 'badge-replied',
  'follow-up-replied': 'badge-replied', closed: 'badge-closed',
  'no-openings': 'badge-noopenings', 'in-review': 'badge-inreview',
};

export const STATUS_OPTIONS = [
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'follow-up-sent', label: 'Follow-up Sent' },
  { value: 'replied', label: 'Replied' },
  { value: 'follow-up-replied', label: 'Replied after Follow-up' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'failed', label: 'Failed' },
  { value: 'closed', label: 'Closed' },
  { value: 'no-openings', label: 'No Openings' },
  { value: 'in-review', label: 'In Review' },
] as const;

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export const isFollowUpDue = (c: Contact) =>
  (c.status === 'sent' || c.status === 'replied') && !c.followUpSentAt &&
  !!c.lastSentAt && (Date.now() - new Date(c.lastSentAt).getTime() >= THREE_DAYS_MS);

// Converts plain-text body to HTML for previews. Supports [text](url) links.
export const bodyToHtml = (text: string): string => {
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let result = '', lastIndex = 0, match: RegExpExecArray | null;
  while ((match = linkRe.exec(text)) !== null) {
    result += esc(text.slice(lastIndex, match.index));
    result += `<a href="${esc(match[2])}" target="_blank" rel="noopener noreferrer">${esc(match[1])}</a>`;
    lastIndex = linkRe.lastIndex;
  }
  result += esc(text.slice(lastIndex));
  return result.replace(/\n/g, '<br>');
};

export const BUILTIN_VARIABLES = [
  { key: 'name', desc: "Contact's first name" },
  { key: 'company', desc: "Contact's company" },
  { key: 'role', desc: "Contact's role" },
  { key: 'sender', desc: 'Your name' },
  { key: 'senderCompany', desc: 'Your company' },
];

export const allVariables = (customVariables: CustomVariable[] | undefined) => [
  ...BUILTIN_VARIABLES.map(v => ({ ...v, custom: false })),
  ...(customVariables || []).map(v => ({ key: v.key, desc: v.value, custom: true })),
];

export const renderTemplate = (
  templates: Record<string, Template>,
  sender: Sender,
  tplKey: string,
  contact: Pick<Contact, 'name' | 'company' | 'role' | 'sentSubject'>,
): { subject: string; body: string } => {
  const tpl = templates[tplKey];
  if (!tpl) return { subject: '', body: '' };
  const replace = (str: string) => {
    let out = str
      .replace(/{{name}}/g, contact.name.split(' ')[0])
      .replace(/{{company}}/g, contact.company)
      .replace(/{{role}}/g, contact.role)
      .replace(/{{sender}}/g, sender.name)
      .replace(/{{senderCompany}}/g, sender.company)
      .replace(/{{sentSubject}}/g, contact.sentSubject || '');
    (sender.customVariables || []).forEach(v => {
      out = out.replace(new RegExp(`{{${v.key}}}`, 'g'), v.value || '');
    });
    return out;
  };
  return { subject: replace(tpl.subject), body: replace(tpl.body) };
};
